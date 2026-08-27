from __future__ import annotations

from typing import Any

from sqlalchemy import event, inspect, select

from security import decrypt_proxy_password


def _login(client: Any, path: str, username: str, password: str) -> str:
    response = client.post(path, json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()["accessToken"]


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
    return response.json()


def test_desktop_config_assignment_permissions_and_encryption(api: Any) -> None:
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
        },
    )
    assert proxy_response.status_code == 201, proxy_response.text
    proxy = proxy_response.json()
    assert "password" not in proxy
    assert "encryptedPassword" not in proxy
    assert "encrypted_password" not in proxy

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

    assigned = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=_bearer(admin_token),
        json={
            "proxyId": proxy["id"],
            "platformIds": [first_platform.json()["id"], second_platform.json()["id"]],
        },
    )
    assert assigned.status_code == 200, assigned.text
    admin_config = assigned.json()
    assert admin_config["proxy"]["id"] == proxy["id"]
    assert "password" not in admin_config["proxy"]
    assert [item["sortOrder"] for item in admin_config["platforms"]] == [10, 20]

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
    desktop = desktop_response.json()
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
        },
        "platforms": [
            {
                "id": second_platform.json()["id"],
                "name": "First in UI",
                "url": "http://one.example.test",
                "sortOrder": 10,
            },
            {
                "id": first_platform.json()["id"],
                "name": "Second in UI",
                "url": "https://two.example.test/path",
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
    assert lease_response.json() == {"lease": lease}

    changed_platform = client.patch(
        f"/api/admin/platforms/{second_platform.json()['id']}",
        headers=_bearer(admin_token),
        json={"name": "First in UI updated"},
    )
    assert changed_platform.status_code == 200
    changed_lease = client.get(
        "/api/user/desktop-config/lease", headers=_bearer(user_token)
    ).json()["lease"]
    assert changed_lease != lease

    logs = client.get("/api/admin/user-logs?page=1&pageSize=100", headers=_bearer(admin_token))
    assert logs.status_code == 200
    actions = {item["action"] for item in logs.json()["items"]}
    assert {
        "PROXY_CREATE",
        "PLATFORM_CREATE",
        "USER_DESKTOP_CONFIG_UPDATE",
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
    ).json()
    disabled_platform = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "Disabled Platform", "url": "https://disabled.example.test", "status": "disabled"},
    ).json()

    rejected_proxy = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=_bearer(admin_token),
        json={"proxyId": disabled_proxy["id"], "platformIds": []},
    )
    assert rejected_proxy.status_code == 400

    rejected_platform = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=_bearer(admin_token),
        json={"proxyId": None, "platformIds": [disabled_platform["id"]]},
    )
    assert rejected_platform.status_code == 400

    missing_reference = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=_bearer(admin_token),
        json={"proxyId": None, "platformIds": [999999]},
    )
    assert missing_reference.status_code == 400

    cleared = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=_bearer(admin_token),
        json={"proxyId": None, "platformIds": []},
    )
    assert cleared.status_code == 200
    assert cleared.json() == {"proxy": None, "platforms": []}
    cleared_desktop = client.get(
        "/api/user/desktop-config", headers=_bearer(user_token)
    ).json()
    cleared_desktop.pop("lease")
    assert cleared_desktop == {
        "proxy": None,
        "platforms": [],
        "profileKey": f"user-{user['id']}",
    }
