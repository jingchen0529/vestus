from __future__ import annotations

from typing import Any

from tests.envelope import payload


def _login(client: Any, path: str, username: str, password: str) -> str:
    response = client.post(path, json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return payload(response)["accessToken"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _setup(client: Any) -> tuple[str, str, dict[str, Any]]:
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    platform_response = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": "方舟", "url": "https://ark.example.test/admin"},
    )
    assert platform_response.status_code == 201, platform_response.text
    platform = payload(platform_response)
    user_response = client.post(
        "/api/admin/users",
        headers=_bearer(admin_token),
        json={
            "username": "managed-user",
            "password": "managed-password",
            "name": "Managed User",
            "expiresAt": "2099-12-31",
        },
    )
    assert user_response.status_code == 201, user_response.text
    return admin_token, _login(client, "/api/user/auth/login", "managed-user", "managed-password"), platform


def test_admin_managed_account_create_keeps_legacy_list_secret_free(api: Any) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "方舟主账号",
            "authMode": "server_login",
            "username": "ark-owner",
            "password": "ark-password",
        },
    )
    assert response.status_code == 201, response.text
    data = payload(response)
    assert data["platformId"] == platform["id"]
    assert data["authMode"] == "server_login"
    assert data["credentialVersion"] == 1
    assert "password" not in data
    assert "cookieBundle" not in data

    from sqlalchemy import select

    with module.db.session() as session:
        row = session.scalar(select(module.ManagedPlatformAccount))
        assert row is not None
        assert row.password == "ark-password"
        assert row.encrypted_password is None


def test_admin_verify_without_managed_browser_returns_explicit_provider_error(api: Any) -> None:
    client, _module = api
    admin_token, _user_token, platform = _setup(client)
    created = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "方舟主账号",
            "authMode": "server_login",
            "username": "ark-owner",
            "password": "ark-password",
        },
    )
    account_id = payload(created)["id"]
    response = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/verify",
        headers=_bearer(admin_token),
    )
    assert response.status_code == 422, response.text
    assert "needs_manual_verification" in response.text


def test_user_bootstrap_cookie_is_single_use_and_requires_binding(api: Any) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "方舟主账号",
            "authMode": "cookie",
            "cookieBundle": [
                {
                    "name": "sessionid",
                    "value": "secret-cookie",
                    "domain": ".example.test",
                    "path": "/",
                    "secure": True,
                    "httpOnly": True,
                    "sameSite": "Lax",
                }
            ],
            "allowedHosts": ["ark.example.test"],
        },
    )
    assert account_response.status_code == 201, account_response.text
    account_id = payload(account_response)["id"]
    bind = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/bindings",
        headers=_bearer(admin_token),
        json={"userId": 1},
    )
    assert bind.status_code == 201, bind.text

    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"deviceId": "device-a"},
    )
    assert issued.status_code == 200, issued.text
    grant = payload(issued)
    assert grant["bootstrapToken"]
    assert "cookieBundle" not in grant

    consumed = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
        headers=_bearer(user_token),
        json={"bootstrapToken": grant["bootstrapToken"], "deviceId": "device-a"},
    )
    assert consumed.status_code == 200, consumed.text
    session = payload(consumed)
    assert session["targetUrl"] == platform["url"]
    assert session["cookieBundle"][0]["name"] == "sessionid"
    assert session["cookieBundle"][0]["value"] == "secret-cookie"

    replay = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
        headers=_bearer(user_token),
        json={"bootstrapToken": grant["bootstrapToken"], "deviceId": "device-a"},
    )
    assert replay.status_code == 409, replay.text
    assert "一次性" in replay.text

    with module.db.session() as session_db:
        assert session_db.query(module.ManagedBrowserSession).count() == 1


def test_bootstrap_grant_is_invalidated_when_binding_is_removed(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform = _setup(client)
    account_response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "revoked-binding-account",
            "authMode": "cookie",
            "cookieBundle": [
                {"name": "sessionid", "value": "revoked-cookie", "domain": ".example.test"}
            ],
        },
    )
    assert account_response.status_code == 201, account_response.text
    account_id = payload(account_response)["id"]
    bind = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/bindings",
        headers=_bearer(admin_token),
        json={"userId": 1},
    )
    assert bind.status_code == 201, bind.text
    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"deviceId": "device-revoked"},
    )
    assert issued.status_code == 200, issued.text
    bootstrap_token = payload(issued)["bootstrapToken"]

    removed = client.delete(
        f"/api/admin/managed-platform-accounts/{account_id}/bindings/1",
        headers=_bearer(admin_token),
    )
    assert removed.status_code == 200, removed.text
    consumed = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
        headers=_bearer(user_token),
        json={"bootstrapToken": bootstrap_token, "deviceId": "device-revoked"},
    )
    assert consumed.status_code == 409, consumed.text


def test_disabled_platform_cannot_issue_or_consume_managed_bootstrap(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform = _setup(client)
    account_response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "disabled-platform-account",
            "authMode": "cookie",
            "cookieBundle": [
                {"name": "sessionid", "value": "disabled-platform-cookie", "domain": ".example.test"}
            ],
        },
    )
    assert account_response.status_code == 201, account_response.text
    account_id = payload(account_response)["id"]
    bind = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/bindings",
        headers=_bearer(admin_token),
        json={"userId": 1},
    )
    assert bind.status_code == 201, bind.text
    disabled = client.patch(
        f"/api/admin/platforms/{platform['id']}",
        headers=_bearer(admin_token),
        json={"status": "disabled"},
    )
    assert disabled.status_code == 200, disabled.text
    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"deviceId": "device-disabled-platform"},
    )
    assert issued.status_code == 409, issued.text


def test_expired_managed_account_invalidates_pending_bootstrap(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform = _setup(client)
    account_response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "expired-pending-account",
            "authMode": "cookie",
            "cookieBundle": [
                {"name": "sessionid", "value": "expired-pending-cookie", "domain": ".example.test"}
            ],
        },
    )
    assert account_response.status_code == 201, account_response.text
    account_id = payload(account_response)["id"]
    bind = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/bindings",
        headers=_bearer(admin_token),
        json={"userId": 1},
    )
    assert bind.status_code == 201, bind.text
    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"deviceId": "device-expired-account"},
    )
    assert issued.status_code == 200, issued.text
    bootstrap_token = payload(issued)["bootstrapToken"]
    expired = client.patch(
        f"/api/admin/managed-platform-accounts/{account_id}",
        headers=_bearer(admin_token),
        json={"expiresAt": "2000-01-01"},
    )
    assert expired.status_code == 200, expired.text
    consumed = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
        headers=_bearer(user_token),
        json={"bootstrapToken": bootstrap_token, "deviceId": "device-expired-account"},
    )
    assert consumed.status_code == 409, consumed.text


def test_managed_account_update_rotates_version_without_returning_secret(api: Any) -> None:
    client, _module = api
    admin_token, _user_token, platform = _setup(client)
    created = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "方舟主账号",
            "authMode": "server_login",
            "username": "ark-owner",
            "password": "old-password",
        },
    )
    account_id = payload(created)["id"]
    updated = client.patch(
        f"/api/admin/managed-platform-accounts/{account_id}",
        headers=_bearer(admin_token),
        json={"password": "new-password"},
    )
    assert updated.status_code == 200, updated.text
    data = payload(updated)
    assert data["credentialVersion"] == 2
    assert "password" not in data


def test_plain_admin_cannot_manage_managed_platform_accounts(api: Any) -> None:
    client, module = api
    _super_token, _user_token, platform = _setup(client)
    from app.core.security import hash_password
    from app.db.models import Admin

    with module.db.session() as session:
        session.add(
            Admin(
                username="plain-admin",
                password_hash=hash_password("plain-admin-password"),
                name="普通管理员",
                role="admin",
                status="active",
            )
        )
    token = _login(client, "/api/admin/auth/login", "plain-admin", "plain-admin-password")
    response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(token),
        json={
            "platformId": platform["id"],
            "name": "普通管理员配置的方舟账号",
            "authMode": "cookie",
            "cookieBundle": [
                {
                    "name": "sessionid",
                    "value": "secret-cookie",
                    "domain": ".example.test",
                    "path": "/",
                    "secure": True,
                    "httpOnly": True,
                    "sameSite": "Lax",
                }
            ],
            "allowedHosts": ["ark.example.test"],
        },
    )
    assert response.status_code == 403, response.text
    assert client.get(
        "/api/admin/users/1/managed-account", headers=_bearer(token)
    ).status_code == 403
    assert client.put(
        "/api/admin/users/1/managed-account",
        headers=_bearer(token),
        json={"authMode": "cookie", "cookieBundle": []},
    ).status_code == 403
    assert client.delete(
        "/api/admin/users/1/managed-account", headers=_bearer(token)
    ).status_code == 403


def test_super_admin_can_upsert_user_managed_account_in_plaintext(api: Any) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)

    saved = client.put(
        "/api/admin/users/1/managed-account",
        headers=_bearer(admin_token),
        json={
            "authMode": "server_login",
            "username": "ark-owner",
            "password": "ark-password",
        },
    )
    assert saved.status_code == 200, saved.text
    data = payload(saved)
    assert data["platformId"] == platform["id"]
    assert data["platformName"] == "方舟"
    assert data["authMode"] == "server_login"
    assert data["username"] == "ark-owner"
    assert data["password"] == "ark-password"
    assert data["cookieBundle"] == []
    assert data["expiresAt"] is None
    # allowedHosts 不再由管理员填写：服务端从平台入口 URL 推导主业务域。
    assert data["allowedHosts"] == ["example.test"]

    loaded = client.get("/api/admin/users/1/managed-account", headers=_bearer(admin_token))
    assert loaded.status_code == 200, loaded.text
    assert payload(loaded)["password"] == "ark-password"

    with module.db.session() as session:
        row = session.query(module.ManagedPlatformAccount).one()
        assert row.username == "ark-owner"
        assert row.password == "ark-password"
        assert row.cookie_bundle is None
        assert row.encrypted_password is None


def test_user_managed_account_switching_modes_clears_unused_plaintext_secret(api: Any) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    cookie_bundle = [{"name": "sessionid", "value": "cookie-secret", "domain": ".example.test"}]

    cookie_saved = client.put(
        "/api/admin/users/1/managed-account",
        headers=_bearer(admin_token),
        json={"authMode": "cookie", "cookieBundle": cookie_bundle},
    )
    assert cookie_saved.status_code == 200, cookie_saved.text
    cookie_data = payload(cookie_saved)
    assert cookie_data["platformId"] == platform["id"]
    assert cookie_data["cookieBundle"][0]["name"] == "sessionid"
    assert cookie_data["cookieBundle"][0]["value"] == "cookie-secret"
    assert cookie_data["username"] is None
    assert cookie_data["password"] is None

    login_saved = client.put(
        "/api/admin/users/1/managed-account",
        headers=_bearer(admin_token),
        json={"authMode": "server_login", "username": "owner", "password": "secret"},
    )
    assert login_saved.status_code == 200, login_saved.text
    login_data = payload(login_saved)
    assert login_data["cookieBundle"] == []
    assert login_data["password"] == "secret"

    with module.db.session() as session:
        row = session.query(module.ManagedPlatformAccount).one()
        assert row.cookie_bundle is None
        assert row.password == "secret"


def test_user_managed_account_requires_ark_platform(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    user_response = client.post(
        "/api/admin/users",
        headers=_bearer(admin_token),
        json={"username": "no-ark-user", "password": "password", "name": "No Ark"},
    )
    assert user_response.status_code == 201, user_response.text
    response = client.put(
        "/api/admin/users/1/managed-account",
        headers=_bearer(admin_token),
        json={"authMode": "server_login", "username": "owner", "password": "secret"},
    )
    assert response.status_code == 400, response.text
    assert "方舟" in response.text


def test_delete_user_managed_account_revokes_binding_and_secret(api: Any) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    saved = client.put(
        "/api/admin/users/1/managed-account",
        headers=_bearer(admin_token),
        json={"authMode": "cookie", "cookieBundle": [{"name": "sid", "value": "secret", "domain": ".example.test"}]},
    )
    assert saved.status_code == 200, saved.text
    removed = client.delete("/api/admin/users/1/managed-account", headers=_bearer(admin_token))
    assert removed.status_code == 200, removed.text
    assert client.get("/api/admin/users/1/managed-account", headers=_bearer(admin_token)).status_code == 404
    with module.db.session() as session:
        row = session.query(module.ManagedPlatformAccount).one()
        assert row.status == "revoked"
        assert row.cookie_bundle is None
        assert session.query(module.ManagedPlatformBinding).count() == 0


def test_cookie_bundle_preserves_browser_attributes_after_round_trip(api: Any) -> None:
    client, _module = api
    admin_token, _user_token, platform = _setup(client)
    response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "带属性的 Cookie",
            "authMode": "cookie",
            "cookieBundle": [
                {
                    "name": "sessionid",
                    "value": "secret-cookie",
                    "domain": ".example.test",
                    "httpOnly": True,
                    "sameSite": "Lax",
                    "expiresAt": "2099-12-31T00:00:00Z",
                }
            ],
            "allowedHosts": ["ark.example.test"],
        },
    )
    assert response.status_code == 201, response.text
    account_id = payload(response)["id"]
    bind = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/bindings",
        headers=_bearer(admin_token),
        json={"userId": 1},
    )
    assert bind.status_code == 201, bind.text
    user_token = _login(client, "/api/user/auth/login", "managed-user", "managed-password")
    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"deviceId": "device-attrs"},
    )
    token = payload(issued)["bootstrapToken"]
    consumed = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
        headers=_bearer(user_token),
        json={"bootstrapToken": token, "deviceId": "device-attrs"},
    )
    cookie = payload(consumed)["cookieBundle"][0]
    assert cookie["httpOnly"] is True
    assert cookie["sameSite"] == "Lax"
    assert cookie["expiresAt"].startswith("2099-12-31T00:00:00")

