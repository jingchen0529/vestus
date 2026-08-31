from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import suppress
from datetime import timedelta
from threading import Barrier, BrokenBarrierError
from typing import Any

from sqlalchemy import event, inspect, select

from app.core.security import decrypt_proxy_password
from tests.envelope import items, message, payload


def _login(client: Any, path: str, username: str, password: str) -> str:
    response = client.post(path, json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return payload(response)["accessToken"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: Any, admin_token: str) -> dict[str, Any]:
    response = client.post(
        "/api/admin/users",
        headers=_bearer(admin_token),
        json={
            "username": "configured-user",
            "password": "configured-password",
            "name": "Configured User",
            "expiresAt": "2099-12-31",
        },
    )
    assert response.status_code == 201, response.text
    return payload(response)


def _create_named_user(
    client: Any,
    admin_token: str,
    *,
    username: str,
    password: str,
) -> dict[str, Any]:
    response = client.post(
        "/api/admin/users",
        headers=_bearer(admin_token),
        json={
            "username": username,
            "password": password,
            "name": username,
            "expiresAt": "2099-12-31",
        },
    )
    assert response.status_code == 201, response.text
    return payload(response)


def test_active_proxy_and_platforms_are_shared_by_every_desktop_user(api: Any) -> None:
    client, module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    first_user = _create_named_user(
        client,
        admin_token,
        username="shared-user-one",
        password="shared-password-one",
    )
    second_user = _create_named_user(
        client,
        admin_token,
        username="shared-user-two",
        password="shared-password-two",
    )

    proxy = payload(
        client.post(
            "/api/admin/proxies",
            headers=_bearer(admin_token),
            json={
                "name": "Global Proxy",
                "host": "global-proxy.example.test",
                "port": 3128,
                "username": "global-user",
                "password": "global-secret",
            },
        )
    )
    legacy_disabled_proxy = payload(
        client.post(
            "/api/admin/proxies",
            headers=_bearer(admin_token),
            json={
                "name": "Legacy Assigned Proxy",
                "host": "legacy-assigned-proxy.example.test",
                "port": 8080,
                "username": "legacy-user",
                "password": "legacy-secret",
                "status": "disabled",
            },
        )
    )
    active_platform = payload(
        client.post(
            "/api/admin/platforms",
            headers=_bearer(admin_token),
            json={
                "name": "Global Platform",
                "url": "https://global-platform.example.test",
                "sortOrder": 10,
            },
        )
    )
    disabled_platform = payload(
        client.post(
            "/api/admin/platforms",
            headers=_bearer(admin_token),
            json={
                "name": "Disabled Global Platform",
                "url": "https://disabled-global-platform.example.test",
                "status": "disabled",
            },
        )
    )

    # Historical assignment rows can remain after an upgrade, but must not
    # narrow or replace the global resources delivered to either user.
    with module.db.session() as session:
        session.add(
            module.UserProxyAssignment(
                user_id=first_user["id"],
                proxy_id=legacy_disabled_proxy["id"],
            )
        )
        session.add(
            module.UserPlatformAssignment(
                user_id=first_user["id"],
                platform_id=disabled_platform["id"],
            )
        )

    first_token = _login(
        client,
        "/api/user/auth/login",
        first_user["username"],
        "shared-password-one",
    )
    second_token = _login(
        client,
        "/api/user/auth/login",
        second_user["username"],
        "shared-password-two",
    )
    first_config = payload(
        client.get("/api/user/desktop-config", headers=_bearer(first_token))
    )
    second_config = payload(
        client.get("/api/user/desktop-config", headers=_bearer(second_token))
    )

    assert first_config["proxy"]["id"] == proxy["id"]
    assert second_config["proxy"]["id"] == proxy["id"]
    assert [item["id"] for item in first_config["platforms"]] == [
        active_platform["id"]
    ]
    assert [item["id"] for item in second_config["platforms"]] == [
        active_platform["id"]
    ]
    assert first_config["profileKey"] == f"user-{first_user['id']}"
    assert second_config["profileKey"] == f"user-{second_user['id']}"


def test_creating_an_active_proxy_makes_it_the_only_active_proxy(api: Any) -> None:
    client, _module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    headers = _bearer(admin_token)
    first = payload(
        client.post(
            "/api/admin/proxies",
            headers=headers,
            json={
                "name": "First Global Proxy",
                "host": "first-global-proxy.example.test",
                "port": 3128,
                "username": "first-user",
                "password": "first-secret",
            },
        )
    )
    second = payload(
        client.post(
            "/api/admin/proxies",
            headers=headers,
            json={
                "name": "Second Global Proxy",
                "host": "second-global-proxy.example.test",
                "port": 8080,
                "username": "second-user",
                "password": "second-secret",
            },
        )
    )

    proxies = items(client.get("/api/admin/proxies", headers=headers))
    statuses = {item["id"]: item["status"] for item in proxies}
    assert statuses == {
        first["id"]: "disabled",
        second["id"]: "active",
    }


def test_enabling_a_proxy_disables_the_previous_active_proxy(api: Any) -> None:
    client, _module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    headers = _bearer(admin_token)
    first = payload(
        client.post(
            "/api/admin/proxies",
            headers=headers,
            json={
                "name": "Current Global Proxy",
                "host": "current-global-proxy.example.test",
                "port": 3128,
                "username": "current-user",
                "password": "current-secret",
            },
        )
    )
    replacement = payload(
        client.post(
            "/api/admin/proxies",
            headers=headers,
            json={
                "name": "Replacement Global Proxy",
                "host": "replacement-global-proxy.example.test",
                "port": 8080,
                "username": "replacement-user",
                "password": "replacement-secret",
                "status": "disabled",
            },
        )
    )

    enabled = client.patch(
        f"/api/admin/proxies/{replacement['id']}",
        headers=headers,
        json={"status": "active"},
    )
    assert enabled.status_code == 200, enabled.text

    proxies = items(client.get("/api/admin/proxies", headers=headers))
    statuses = {item["id"]: item["status"] for item in proxies}
    assert statuses == {
        first["id"]: "disabled",
        replacement["id"]: "active",
    }


def test_concurrent_active_proxy_creation_keeps_one_active_proxy(api: Any) -> None:
    _client, module = api
    select_barrier = Barrier(2)

    def synchronize_empty_active_reads(
        _conn: Any,
        _cursor: Any,
        statement: str,
        _parameters: Any,
        _context: Any,
        _executemany: bool,
    ) -> None:
        normalized = " ".join(statement.lower().split())
        if normalized.startswith("select") and "from proxy" in normalized and "proxy.status" in normalized:
            # Once a stable DB lock serializes the transactions, the first
            # transaction times out here before the second can run SELECT.
            with suppress(BrokenBarrierError):
                select_barrier.wait(timeout=1)

    event.listen(module.db.engine, "after_cursor_execute", synchronize_empty_active_reads)
    try:
        def create_proxy(index: int) -> dict[str, Any]:
            return module.db.insert_proxy(
                {
                    "name": f"Concurrent Global Proxy {index}",
                    "host": f"concurrent-{index}.example.test",
                    "port": 3100 + index,
                    "username": f"concurrent-user-{index}",
                    "password": f"concurrent-secret-{index}",
                    "status": "active",
                }
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(create_proxy, (1, 2)))
    finally:
        event.remove(module.db.engine, "after_cursor_execute", synchronize_empty_active_reads)

    assert len(results) == 2
    with module.db.session() as session:
        active_proxies = session.scalars(
            select(module.Proxy).where(module.Proxy.status == "active")
        ).all()
    assert len(active_proxies) == 1
    assert active_proxies[0].name in {result["name"] for result in results}


def test_proxy_activation_locks_singleton_before_target_row(api: Any) -> None:
    client, module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    proxy = payload(
        client.post(
            "/api/admin/proxies",
            headers=_bearer(admin_token),
            json={
                "name": "Lock Order Proxy",
                "host": "lock-order.example.test",
                "port": 3128,
                "username": "lock-order-user",
                "password": "lock-order-secret",
                "status": "disabled",
            },
        )
    )
    statements: list[str] = []

    def record_statement(
        _conn: Any,
        _cursor: Any,
        statement: str,
        _parameters: Any,
        _context: Any,
        _executemany: bool,
    ) -> None:
        statements.append(" ".join(statement.lower().split()))

    event.listen(module.db.engine, "before_cursor_execute", record_statement)
    try:
        updated = module.db.update_proxy(proxy["id"], {"status": "active"})
    finally:
        event.remove(module.db.engine, "before_cursor_execute", record_statement)

    assert updated is not None and updated["status"] == "active"
    singleton_lock_index = next(
        index
        for index, statement in enumerate(statements)
        if statement.startswith("update system_setting")
    )
    target_proxy_lock_index = next(
        index
        for index, statement in enumerate(statements)
        if statement.startswith("select")
        and "from proxy" in statement
        and "proxy.id =" in statement
    )
    assert singleton_lock_index < target_proxy_lock_index


def test_startup_normalizes_legacy_multiple_active_proxies(api: Any) -> None:
    client, module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    headers = _bearer(admin_token)
    first = payload(
        client.post(
            "/api/admin/proxies",
            headers=headers,
            json={
                "name": "Legacy Active One",
                "host": "legacy-one.example.test",
                "port": 3128,
                "username": "legacy-one",
                "password": "legacy-one-secret",
            },
        )
    )
    second = payload(
        client.post(
            "/api/admin/proxies",
            headers=headers,
            json={
                "name": "Legacy Active Two",
                "host": "legacy-two.example.test",
                "port": 8080,
                "username": "legacy-two",
                "password": "legacy-two-secret",
                "status": "disabled",
            },
        )
    )

    with module.db.session() as session:
        older = session.get(module.Proxy, first["id"])
        newer = session.get(module.Proxy, second["id"])
        assert older is not None and newer is not None
        older.status = "active"
        newer.status = "active"
        older.updated_at = module.utc_now() - timedelta(minutes=1)
        newer.updated_at = module.utc_now()

    module.db.initialize()

    proxies = items(client.get("/api/admin/proxies", headers=headers))
    active_ids = [item["id"] for item in proxies if item["status"] == "active"]
    assert active_ids == [second["id"]]


def test_user_specific_desktop_config_admin_api_is_gone(api: Any) -> None:
    client, _module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    user = _create_user(client, admin_token)
    headers = _bearer(admin_token)

    read_response = client.get(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=headers,
    )
    write_response = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=headers,
        json={"proxyId": None, "platformIds": []},
    )
    bodyless_write_response = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=headers,
    )

    assert read_response.status_code == 410
    assert write_response.status_code == 410
    assert bodyless_write_response.status_code == 410
    assert message(read_response) == "桌面代理和平台已改为全局共享配置"
    assert message(write_response) == "桌面代理和平台已改为全局共享配置"
    assert message(bodyless_write_response) == "桌面代理和平台已改为全局共享配置"


def test_global_desktop_config_permissions_encryption_and_lease(api: Any) -> None:
    client, module = api
    tables = set(inspect(module.db.engine).get_table_names())
    assert {
        "proxy",
        "platform",
        "user_proxy_assignment",
        "user_platform_assignment",
    }.issubset(tables)

    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    user = _create_user(client, admin_token)
    user_token = _login(client, "/api/user/auth/login", "configured-user", "configured-password")

    # Account-type boundaries apply to every new surface.
    assert client.get("/api/admin/proxies", headers=_bearer(user_token)).status_code == 403
    assert client.get("/api/admin/platforms", headers=_bearer(user_token)).status_code == 403
    assert client.get("/api/user/desktop-config", headers=_bearer(admin_token)).status_code == 403
    assert client.get("/api/user/desktop-config/lease", headers=_bearer(admin_token)).status_code == 403
    client.cookies.clear()
    assert client.get("/api/user/desktop-config").status_code == 401
    assert client.get("/api/user/desktop-config/lease").status_code == 401

    proxy_response = client.post(
        "/api/admin/proxies",
        headers=_bearer(admin_token),
        json={
            "name": "Assigned Proxy",
            "host": "proxy.example.test",
            "port": 3128,
            "username": "proxy-user",
            "password": "proxy-plain-secret",
            "bypassHosts": ["LF3-AD-Platform.byteadverts.com", ".byteadverts.com"],
        },
    )
    assert proxy_response.status_code == 201, proxy_response.text
    proxy = payload(proxy_response)
    assert "password" not in proxy
    assert "encryptedPassword" not in proxy
    assert "encrypted_password" not in proxy
    # Direct-connect entries are normalized server-side into the form the
    # desktop client re-validates.
    assert proxy["bypassHosts"] == [
        "lf3-ad-platform.byteadverts.com",
        "*.byteadverts.com",
    ]

    with module.db.session() as session:
        stored = session.scalar(select(module.Proxy).where(module.Proxy.id == proxy["id"]))
        assert stored is not None
        assert stored.encrypted_password != b"proxy-plain-secret"
        assert b"proxy-plain-secret" not in stored.encrypted_password
        assert decrypt_proxy_password(stored.encrypted_password) == "proxy-plain-secret"

    first_platform = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "Second in UI", "url": "https://two.example.test/path", "sortOrder": 20},
    )
    second_platform = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "First in UI", "url": "http://one.example.test", "sortOrder": 10},
    )
    assert first_platform.status_code == second_platform.status_code == 201
    first_platform_id = payload(first_platform)["id"]
    second_platform_id = payload(second_platform)["id"]

    snapshot_statements: list[str] = []

    def record_snapshot_statement(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        snapshot_statements.append(statement)

    event.listen(module.db.engine, "before_cursor_execute", record_snapshot_statement)
    try:
        atomic_snapshot = module.db.get_user_desktop_config_with_lease(user["id"])
    finally:
        event.remove(module.db.engine, "before_cursor_execute", record_snapshot_statement)
    assert atomic_snapshot is not None
    assert len([item for item in snapshot_statements if item.lstrip().upper().startswith("SELECT")]) == 1

    desktop_response = client.get("/api/user/desktop-config", headers=_bearer(user_token))
    assert desktop_response.status_code == 200, desktop_response.text
    assert desktop_response.headers["cache-control"] == "no-store"
    desktop = payload(desktop_response)
    lease = desktop.pop("lease")
    assert len(lease) == 64
    assert atomic_snapshot["lease"] == lease
    assert desktop == {
        "proxy": {
            "id": proxy["id"],
            "name": "Assigned Proxy",
            "host": "proxy.example.test",
            "port": 3128,
            "username": "proxy-user",
            "password": "proxy-plain-secret",
            "bypassHosts": [
                "lf3-ad-platform.byteadverts.com",
                "*.byteadverts.com",
            ],
        },
        "platforms": [
            {
                "id": second_platform_id,
                "name": "First in UI",
                "url": "http://one.example.test",
                "iconUrl": "",
                "sortOrder": 10,
            },
            {
                "id": first_platform_id,
                "name": "Second in UI",
                "url": "https://two.example.test/path",
                "iconUrl": "",
                "sortOrder": 20,
            },
        ],
        "profileKey": f"user-{user['id']}",
    }

    lease_response = client.get(
        "/api/user/desktop-config/lease", headers=_bearer(user_token)
    )
    assert lease_response.status_code == 200
    assert lease_response.headers["cache-control"] == "no-store"
    assert payload(lease_response) == {"lease": lease}

    changed_platform = client.patch(
        f"/api/admin/platforms/{second_platform_id}",
        headers=_bearer(admin_token),
        json={"name": "First in UI updated"},
    )
    assert changed_platform.status_code == 200
    changed_lease = payload(
        client.get("/api/user/desktop-config/lease", headers=_bearer(user_token))
    )["lease"]
    assert changed_lease != lease

    # Changing only the direct-connect list must invalidate the lease too: the
    # desktop client rebuilds its routing table from it.
    changed_bypass = client.patch(
        f"/api/admin/proxies/{proxy['id']}",
        headers=_bearer(admin_token),
        json={"bypassHosts": ["lf3-ad-platform.byteadverts.com"]},
    )
    assert changed_bypass.status_code == 200, changed_bypass.text
    assert payload(changed_bypass)["bypassHosts"] == ["lf3-ad-platform.byteadverts.com"]
    bypass_lease = payload(
        client.get("/api/user/desktop-config/lease", headers=_bearer(user_token))
    )["lease"]
    assert bypass_lease != changed_lease
    refreshed = payload(
        client.get("/api/user/desktop-config", headers=_bearer(user_token))
    )
    assert refreshed["proxy"]["bypassHosts"] == ["lf3-ad-platform.byteadverts.com"]

    cleared_bypass = client.patch(
        f"/api/admin/proxies/{proxy['id']}",
        headers=_bearer(admin_token),
        json={"bypassHosts": []},
    )
    assert cleared_bypass.status_code == 200
    assert payload(cleared_bypass)["bypassHosts"] == []

    logs = client.get("/api/admin/user-logs?page=1&pageSize=100", headers=_bearer(admin_token))
    assert logs.status_code == 200
    actions = {item["action"] for item in items(logs)}
    assert {
        "PROXY_CREATE",
        "PLATFORM_CREATE",
        "DESKTOP_CONFIG_READ",
    }.issubset(actions)


def test_desktop_config_validation_and_disabled_reference_filtering(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    user = _create_user(client, admin_token)
    user_token = _login(client, "/api/user/auth/login", "configured-user", "configured-password")

    invalid_url = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "Unsafe", "url": "javascript:alert(1)"},
    )
    assert invalid_url.status_code == 422

    invalid_port = client.post(
        "/api/admin/proxies",
        headers=_bearer(admin_token),
        json={"name": "Bad Port", "host": "proxy.test", "port": 65536, "username": "proxy-user", "password": "secret"},
    )
    assert invalid_port.status_code == 422

    invalid_host = client.post(
        "/api/admin/proxies",
        headers=_bearer(admin_token),
        json={"name": "Bad Host", "host": "http://proxy.test", "port": 8080, "username": "proxy-user", "password": "secret"},
    )
    assert invalid_host.status_code == 422

    whitespace_host = client.post(
        "/api/admin/proxies",
        headers=_bearer(admin_token),
        json={"name": "Whitespace Host", "host": "proxy host.test", "port": 8080, "username": "proxy-user", "password": "secret"},
    )
    assert whitespace_host.status_code == 422

    # The direct-connect list must be rejected here for exactly the reasons the
    # desktop client would reject it; a bypassed name that resolves to loopback
    # or carries a port/scheme is never accepted.
    for index, bad in enumerate(
        [
            "127.0.0.1",
            "::1",
            "localhost",
            "app.localhost",
            "http://a.example.test",
            "a.example.test:8080",
            "a.example.test/path",
            "user@a.example.test",
            "single-label",
            "-bad.example.test",
            "直连.example.test",
            "",
        ]
    ):
        rejected = client.post(
            "/api/admin/proxies",
            headers=_bearer(admin_token),
            json={
                "name": f"Bad Bypass {index}",
                "host": "proxy.test",
                "port": 8080,
                "username": "proxy-user",
                "password": "secret",
                "bypassHosts": [bad],
            },
        )
        assert rejected.status_code == 422, f"应当拒绝直连域名 {bad!r}：{rejected.text}"

    too_many = client.post(
        "/api/admin/proxies",
        headers=_bearer(admin_token),
        json={
            "name": "Too Many Bypass",
            "host": "proxy.test",
            "port": 8080,
            "username": "proxy-user",
            "password": "secret",
            "bypassHosts": [f"host{index}.example.test" for index in range(33)],
        },
    )
    assert too_many.status_code == 422

    invalid_username = client.post(
        "/api/admin/proxies",
        headers=_bearer(admin_token),
        json={"name": "Bad Username", "host": "proxy.test", "port": 8080, "username": "proxy:user", "password": "secret"},
    )
    assert invalid_username.status_code == 422

    credential_url = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "Credential URL", "url": "https://user:secret@example.test"},
    )
    assert credential_url.status_code == 422

    disabled_proxy = client.post(
        "/api/admin/proxies",
        headers=_bearer(admin_token),
        json={"name": "Disabled Proxy", "host": "proxy.test", "port": 8080, "username": "proxy-user", "password": "secret", "status": "disabled"},
    )
    assert disabled_proxy.status_code == 201, disabled_proxy.text
    disabled_platform = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "Disabled Platform", "url": "https://disabled.example.test", "status": "disabled"},
    )
    assert disabled_platform.status_code == 201, disabled_platform.text

    filtered_desktop = payload(
        client.get("/api/user/desktop-config", headers=_bearer(user_token))
    )
    filtered_desktop.pop("lease")
    assert filtered_desktop == {
        "proxy": None,
        "platforms": [],
        "profileKey": f"user-{user['id']}",
    }


def test_platform_management_and_deletion(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    _create_user(client, admin_token)
    user_token = _login(client, "/api/user/auth/login", "configured-user", "configured-password")
    admin_headers = _bearer(admin_token)
    icon_path = payload(
        client.post(
            "/api/admin/uploads",
            headers=admin_headers,
            files={"file": ("logo.png", b"logo", "image/png")},
        )
    )["path"]
    updated_icon_path = payload(
        client.post(
            "/api/admin/uploads",
            headers=admin_headers,
            files={"file": ("new-logo.png", b"new-logo", "image/png")},
        )
    )["path"]

    # 1. Create a platform with iconUrl
    create_res = client.post(
        "/api/admin/platforms",
        headers=admin_headers,
        json={
            "name": "Global Test Platform",
            "url": "https://global.example.test",
            "iconUrl": icon_path,
            "sortOrder": 5,
        },
    )
    assert create_res.status_code == 201
    assert payload(create_res)["iconUrl"] == icon_path
    platform_id = payload(create_res)["id"]

    # 2. Every desktop user sees a newly enabled global platform immediately.
    desktop_res = client.get("/api/user/desktop-config", headers=_bearer(user_token))
    assert desktop_res.status_code == 200
    platforms = payload(desktop_res)["platforms"]
    assert any(
        p["id"] == platform_id
        and p["name"] == "Global Test Platform"
        and p["iconUrl"] == f"http://testserver{icon_path}"
        for p in platforms
    )

    # 3. Disable platform -> desktop user no longer sees it
    patch_res = client.patch(
        f"/api/admin/platforms/{platform_id}",
        headers=admin_headers,
        json={"status": "disabled", "iconUrl": updated_icon_path},
    )
    assert patch_res.status_code == 200
    assert payload(patch_res)["iconUrl"] == updated_icon_path
    desktop_res = client.get("/api/user/desktop-config", headers=_bearer(user_token))
    assert not any(p["id"] == platform_id for p in payload(desktop_res)["platforms"])

    # 4. Delete platform -> returns 200 and removed completely
    del_res = client.delete(
        f"/api/admin/platforms/{platform_id}",
        headers=_bearer(admin_token),
    )
    assert del_res.status_code == 200
    # ``code == 0`` says the platform is gone; there is nothing else to report.
    assert payload(del_res) is None

    # 5. Non-existent platform returns 404
    del_again = client.delete(
        f"/api/admin/platforms/{platform_id}",
        headers=_bearer(admin_token),
    )
    assert del_again.status_code == 404


def test_all_active_platforms_are_visible_to_every_user(api: Any) -> None:
    client, _module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    first_user = _create_user(client, admin_token)
    second_user_response = client.post(
        "/api/admin/users",
        headers=_bearer(admin_token),
        json={
            "username": "unconfigured-user",
            "password": "unconfigured-password",
            "name": "Unconfigured User",
            "expiresAt": "2099-12-31",
        },
    )
    assert second_user_response.status_code == 201, second_user_response.text
    second_user = payload(second_user_response)

    first_platform = payload(
        client.post(
            "/api/admin/platforms",
            headers=_bearer(admin_token),
            json={"name": "Assigned", "url": "https://assigned.example.test"},
        )
    )
    other_platform = payload(
        client.post(
            "/api/admin/platforms",
            headers=_bearer(admin_token),
            json={"name": "Not assigned", "url": "https://other.example.test"},
        )
    )

    first_token = _login(
        client,
        "/api/user/auth/login",
        first_user["username"],
        "configured-password",
    )
    second_token = _login(
        client,
        "/api/user/auth/login",
        second_user["username"],
        "unconfigured-password",
    )
    first_config = payload(
        client.get("/api/user/desktop-config", headers=_bearer(first_token))
    )
    second_config = payload(
        client.get("/api/user/desktop-config", headers=_bearer(second_token))
    )
    expected_platform_ids = [first_platform["id"], other_platform["id"]]
    assert [item["id"] for item in first_config["platforms"]] == expected_platform_ids
    assert [item["id"] for item in second_config["platforms"]] == expected_platform_ids
    assert first_config["proxy"] is None
    assert second_config["proxy"] is None


def test_platform_icon_is_relative_for_admin_and_absolute_for_desktop(api: Any) -> None:
    client, _module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    user = _create_user(client, admin_token)
    headers = _bearer(admin_token)
    icon_path = payload(
        client.post(
            "/api/admin/uploads",
            headers=headers,
            files={"file": ("platform.webp", b"platform-icon", "image/webp")},
        )
    )["path"]

    created = client.post(
        "/api/admin/platforms",
        headers=headers,
        json={
            "name": "Icon platform",
            "url": "https://icon.example.test",
            "iconUrl": icon_path,
        },
    )
    assert created.status_code == 201, created.text
    assert payload(created)["iconUrl"] == icon_path
    platform_id = payload(created)["id"]
    listed = items(client.get("/api/admin/platforms", headers=headers))
    assert next(item for item in listed if item["id"] == platform_id)["iconUrl"] == icon_path

    user_token = _login(
        client,
        "/api/user/auth/login",
        user["username"],
        "configured-password",
    )
    desktop = client.get(
        "/api/user/desktop-config",
        headers={**_bearer(user_token), "Host": "desktop.example.test"},
    )
    assert desktop.status_code == 200, desktop.text
    assert payload(desktop)["platforms"][0]["iconUrl"] == (
        f"http://desktop.example.test{icon_path}"
    )


def test_platform_api_rejects_unmanaged_and_unsafe_icon_references(api: Any) -> None:
    client, _module = api
    admin_token = _login(
        client,
        "/api/admin/auth/login",
        "test-admin",
        "test-admin-password",
    )
    headers = _bearer(admin_token)
    unsafe_path = payload(
        client.post(
            "/api/admin/uploads",
            headers=headers,
            files={"file": ("unsafe.png", b"not-an-image", "text/html")},
        )
    )["path"]
    missing_path = f"/uploads/2026/08/{'e' * 32}.png"

    for index, reference in enumerate(
        ("https://cdn.example.test/icon.png", missing_path, unsafe_path), start=1
    ):
        response = client.post(
            "/api/admin/platforms",
            headers=headers,
            json={
                "name": f"Rejected icon {index}",
                "url": f"https://rejected-{index}.example.test",
                "iconUrl": reference,
            },
        )
        assert response.status_code in {400, 422}, (reference, response.text)
