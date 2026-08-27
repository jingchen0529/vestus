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
            "bypassHosts": ["LF3-AD-Platform.byteadverts.com", ".byteadverts.com"],
        },
    )
    assert proxy_response.status_code == 201, proxy_response.text
    proxy = proxy_response.json()
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
            "bypassHosts": [
                "lf3-ad-platform.byteadverts.com",
                "*.byteadverts.com",
            ],
        },
        "platforms": [
            {
                "id": second_platform.json()["id"],
                "name": "First in UI",
                "url": "http://one.example.test",
                "iconUrl": "",
                "sortOrder": 10,
            },
            {
                "id": first_platform.json()["id"],
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

    # Changing only the direct-connect list must invalidate the lease too: the
    # desktop client rebuilds its routing table from it.
    changed_bypass = client.patch(
        f"/api/admin/proxies/{proxy['id']}",
        headers=_bearer(admin_token),
        json={"bypassHosts": ["lf3-ad-platform.byteadverts.com"]},
    )
    assert changed_bypass.status_code == 200, changed_bypass.text
    assert changed_bypass.json()["bypassHosts"] == ["lf3-ad-platform.byteadverts.com"]
    bypass_lease = client.get(
        "/api/user/desktop-config/lease", headers=_bearer(user_token)
    ).json()["lease"]
    assert bypass_lease != changed_lease
    refreshed = client.get("/api/user/desktop-config", headers=_bearer(user_token)).json()
    assert refreshed["proxy"]["bypassHosts"] == ["lf3-ad-platform.byteadverts.com"]

    cleared_bypass = client.patch(
        f"/api/admin/proxies/{proxy['id']}",
        headers=_bearer(admin_token),
        json={"bypassHosts": []},
    )
    assert cleared_bypass.status_code == 200
    assert cleared_bypass.json()["bypassHosts"] == []

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

    missing_platform = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=_bearer(admin_token),
        json={"proxyId": None, "platformIds": [999_999]},
    )
    assert missing_platform.status_code == 400

    cleared = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=_bearer(admin_token),
        json={"proxyId": None, "platformIds": []},
    )
    assert cleared.status_code == 200
    assert cleared.json()["proxy"] is None
    cleared_desktop = client.get(
        "/api/user/desktop-config", headers=_bearer(user_token)
    ).json()
    cleared_desktop.pop("lease")
    # Clearing the assignment leaves the desktop user with no platform access.
    assert cleared_desktop == {
        "proxy": None,
        "platforms": [],
        "profileKey": f"user-{user['id']}",
    }


def test_platform_management_and_deletion(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    user = _create_user(client, admin_token)
    user_token = _login(client, "/api/user/auth/login", "configured-user", "configured-password")
    admin_headers = _bearer(admin_token)
    icon_path = client.post(
        "/api/admin/uploads",
        headers=admin_headers,
        files={"file": ("logo.png", b"logo", "image/png")},
    ).json()["path"]
    updated_icon_path = client.post(
        "/api/admin/uploads",
        headers=admin_headers,
        files={"file": ("new-logo.png", b"new-logo", "image/png")},
    ).json()["path"]

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
    assert create_res.json()["iconUrl"] == icon_path
    platform_id = create_res.json()["id"]

    # 2. Desktop user sees only the platform explicitly assigned to it.
    assigned = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=admin_headers,
        json={"proxyId": None, "platformIds": [platform_id]},
    )
    assert assigned.status_code == 200, assigned.text
    desktop_res = client.get("/api/user/desktop-config", headers=_bearer(user_token))
    assert desktop_res.status_code == 200
    platforms = desktop_res.json()["platforms"]
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
    assert patch_res.json()["iconUrl"] == updated_icon_path
    desktop_res = client.get("/api/user/desktop-config", headers=_bearer(user_token))
    assert not any(p["id"] == platform_id for p in desktop_res.json()["platforms"])

    # 4. Delete platform -> returns 200 and removed completely
    del_res = client.delete(
        f"/api/admin/platforms/{platform_id}",
        headers=_bearer(admin_token),
    )
    assert del_res.status_code == 200
    assert del_res.json() == {"success": True}

    # 5. Non-existent platform returns 404
    del_again = client.delete(
        f"/api/admin/platforms/{platform_id}",
        headers=_bearer(admin_token),
    )
    assert del_again.status_code == 404


def test_platforms_are_visible_only_to_assigned_users(api: Any) -> None:
    client, module = api
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
    second_user = second_user_response.json()

    first_platform = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "Assigned", "url": "https://assigned.example.test"},
    ).json()
    other_platform = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "Not assigned", "url": "https://other.example.test"},
    ).json()

    saved = client.patch(
        f"/api/admin/users/{first_user['id']}/desktop-config",
        headers=_bearer(admin_token),
        json={"proxyId": None, "platformIds": [first_platform["id"]]},
    )
    assert saved.status_code == 200, saved.text
    assert [item["id"] for item in saved.json()["platforms"]] == [
        first_platform["id"]
    ]

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
    first_config = client.get(
        "/api/user/desktop-config", headers=_bearer(first_token)
    ).json()
    second_config = client.get(
        "/api/user/desktop-config", headers=_bearer(second_token)
    ).json()
    assert [item["id"] for item in first_config["platforms"]] == [
        first_platform["id"]
    ]
    assert all(item["id"] != other_platform["id"] for item in first_config["platforms"])
    assert second_config["platforms"] == []
    assert second_config["proxy"] is None

    with module.db.session() as session:
        assignments = session.scalars(
            select(module.UserPlatformAssignment).where(
                module.UserPlatformAssignment.user_id == first_user["id"]
            )
        ).all()
    assert [assignment.platform_id for assignment in assignments] == [
        first_platform["id"]
    ]


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
    icon_path = client.post(
        "/api/admin/uploads",
        headers=headers,
        files={"file": ("platform.webp", b"platform-icon", "image/webp")},
    ).json()["path"]

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
    assert created.json()["iconUrl"] == icon_path
    platform_id = created.json()["id"]
    listed = client.get("/api/admin/platforms", headers=headers).json()
    assert next(item for item in listed if item["id"] == platform_id)["iconUrl"] == icon_path

    assigned = client.patch(
        f"/api/admin/users/{user['id']}/desktop-config",
        headers=headers,
        json={"proxyId": None, "platformIds": [platform_id]},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["platforms"][0]["iconUrl"] == icon_path

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
    assert desktop.json()["platforms"][0]["iconUrl"] == (
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
    unsafe_path = client.post(
        "/api/admin/uploads",
        headers=headers,
        files={"file": ("unsafe.png", b"not-an-image", "text/html")},
    ).json()["path"]
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
