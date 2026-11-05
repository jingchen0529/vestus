from __future__ import annotations

from typing import Any

import pytest

from tests.envelope import message, payload


@pytest.fixture(autouse=True)
def _disable_real_managed_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    # Tests use fake providers; never launch a locally configured real browser.
    monkeypatch.delenv("VESTUS_MANAGED_CHROMIUM_PATH", raising=False)


@pytest.fixture(autouse=True)
def _disable_real_identity_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    # 身份探测访问上游真实接口；默认整体禁用，探测相关用例自行覆盖。
    from app.services import managed_platforms as managed_platforms_service

    monkeypatch.setattr(
        managed_platforms_service, "_identity_probe", lambda *args, **kwargs: None
    )


@pytest.fixture()
def recovery_enabled(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    # The app lifespan has already started with recovery disabled. Enable only
    # request-time queueing; no background worker or real browser is started.
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "1")


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


def test_admin_managed_account_create_keeps_legacy_list_secret_free(api: Any, recovery_enabled: None) -> None:
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


def test_managed_account_update_rotates_version_without_returning_secret(api: Any, recovery_enabled: None) -> None:
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


def test_super_admin_can_upsert_user_managed_account_in_plaintext(api: Any, recovery_enabled: None) -> None:
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


def test_user_managed_account_switching_modes_clears_unused_plaintext_secret(api: Any, recovery_enabled: None) -> None:
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


def test_multiple_managed_accounts_are_listed_and_bootstrapped_independently(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform = _setup(client)

    account_ids: list[int] = []
    for name, cookie_value in (("账号 A", "cookie-a"), ("账号 B", "cookie-b")):
        response = client.post(
            "/api/admin/managed-platform-accounts",
            headers=_bearer(admin_token),
            json={
                "platformId": platform["id"],
                "name": name,
                "authMode": "cookie",
                "cookieBundle": [{"name": "sid", "value": cookie_value, "domain": ".example.test"}],
            },
        )
        assert response.status_code == 201, response.text
        account_id = payload(response)["id"]
        account_ids.append(account_id)
        bound = client.post(
            f"/api/admin/managed-platform-accounts/{account_id}/bindings",
            headers=_bearer(admin_token),
            json={"userId": 1},
        )
        assert bound.status_code == 201, bound.text

    listed = client.get(
        "/api/admin/users/1/managed-accounts", headers=_bearer(admin_token)
    )
    assert listed.status_code == 200, listed.text
    items = payload(listed)["items"]
    assert [item["managedAccountId"] for item in items] == account_ids
    assert [item["name"] for item in items] == ["账号 A", "账号 B"]

    desktop_config = client.get("/api/user/desktop-config", headers=_bearer(user_token))
    assert desktop_config.status_code == 200, desktop_config.text
    desktop_platform = payload(desktop_config)["platforms"][0]
    assert [item["id"] for item in desktop_platform["managedAccounts"]] == account_ids
    assert "cookieBundle" not in desktop_platform["managedAccounts"][0]

    consumed_values = []
    for account_id, cookie_value in zip(account_ids, ("cookie-a", "cookie-b"), strict=True):
        issued = client.post(
            f"/api/user/managed-platforms/{platform['id']}/bootstrap",
            headers=_bearer(user_token),
            json={"managedAccountId": account_id, "deviceId": f"device-{account_id}"},
        )
        assert issued.status_code == 200, issued.text
        assert payload(issued)["managedAccountId"] == account_id
        consumed = client.post(
            f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
            headers=_bearer(user_token),
            json={
                "bootstrapToken": payload(issued)["bootstrapToken"],
                "deviceId": f"device-{account_id}",
            },
        )
        assert consumed.status_code == 200, consumed.text
        consumed_values.append(payload(consumed)["cookieBundle"][0]["value"])
        assert consumed_values[-1] == cookie_value
    assert consumed_values == ["cookie-a", "cookie-b"]

    legacy = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"deviceId": "legacy-device"},
    )
    assert legacy.status_code == 409, legacy.text

    removed = client.delete(
        f"/api/admin/users/1/managed-accounts/{account_ids[0]}",
        headers=_bearer(admin_token),
    )
    assert removed.status_code == 200, removed.text
    remaining = client.get(
        "/api/admin/users/1/managed-accounts", headers=_bearer(admin_token)
    )
    assert [item["managedAccountId"] for item in payload(remaining)["items"]] == [account_ids[1]]


def test_binding_model_allows_two_accounts_for_one_user_and_platform(api: Any) -> None:
    _client, module = api
    from sqlalchemy.exc import IntegrityError

    from app.db.models import ManagedPlatformAccount, ManagedPlatformBinding

    account = ManagedPlatformAccount(
        platform_id=1,
        name="identity-fields-optional",
        auth_mode="cookie",
        allowed_hosts=[],
    )
    assert account.remote_account_id is None
    assert account.remote_display_name is None
    assert account.identity_checked_at is None

    with module.db.session() as session:
        session.add_all(
            [
                ManagedPlatformBinding(
                    user_id=1,
                    platform_id=1,
                    managed_account_id=101,
                    status="active",
                ),
                ManagedPlatformBinding(
                    user_id=1,
                    platform_id=1,
                    managed_account_id=102,
                    status="active",
                ),
            ]
        )
        session.flush()
        assert session.query(ManagedPlatformBinding).count() == 2
        session.add(
            ManagedPlatformBinding(
                user_id=1,
                platform_id=1,
                managed_account_id=102,
                status="active",
            )
        )
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
        else:  # pragma: no cover - the old model takes this branch
            raise AssertionError("duplicate user/platform/account binding was accepted")


def test_binding_repository_can_list_and_get_account_specific_rows(api: Any) -> None:
    _client, module = api
    from app.db.models import ManagedPlatformBinding
    from app.repositories import managed_platforms as repository

    with module.db.session() as session:
        session.add_all(
            [
                ManagedPlatformBinding(
                    user_id=1,
                    platform_id=1,
                    managed_account_id=201,
                    status="active",
                ),
                ManagedPlatformBinding(
                    user_id=1,
                    platform_id=1,
                    managed_account_id=202,
                    status="active",
                ),
            ]
        )
        session.flush()
        listed = repository.list_bindings(session, 1, 1)
        assert [item.managed_account_id for item in listed] == [201, 202]
        selected = repository.get_binding_for_account(session, 1, 1, 202)
        assert selected is not None
        assert selected.managed_account_id == 202


def test_user_bound_managed_accounts_support_per_account_create_get_and_patch(api: Any, recovery_enabled: None) -> None:
    client, _module = api
    admin_token, _user_token, _platform = _setup(client)

    first = client.post(
        "/api/admin/users/1/managed-accounts",
        headers=_bearer(admin_token),
        json={
            "name": "张三-方舟主号",
            "authMode": "cookie",
            "cookieBundle": [{"name": "sid", "value": "cookie-1", "domain": ".example.test"}],
        },
    )
    assert first.status_code == 201, first.text
    first_data = payload(first)
    assert first_data["name"] == "张三-方舟主号"
    assert first_data["authMode"] == "cookie"
    assert "cookieBundle" not in first_data

    second = client.post(
        "/api/admin/users/1/managed-accounts",
        headers=_bearer(admin_token),
        json={
            "authMode": "server_login",
            "username": "ark-sub",
            "password": "secret-password",
        },
    )
    assert second.status_code == 201, second.text
    second_data = payload(second)
    assert second_data["name"] == "user-1-ark"
    assert second_data["authMode"] == "server_login"

    detail = client.get(
        f"/api/admin/users/1/managed-accounts/{first_data['managedAccountId']}",
        headers=_bearer(admin_token),
    )
    assert detail.status_code == 200, detail.text
    detail_data = payload(detail)
    assert detail_data["name"] == "张三-方舟主号"
    assert detail_data["cookieBundle"][0]["value"] == "cookie-1"

    updated = client.patch(
        f"/api/admin/users/1/managed-accounts/{first_data['managedAccountId']}",
        headers=_bearer(admin_token),
        json={
            "name": "张三-方舟一号",
            "authMode": "cookie",
            "cookieBundle": [{"name": "sid", "value": "cookie-2", "domain": ".example.test"}],
        },
    )
    assert updated.status_code == 200, updated.text
    updated_data = payload(updated)
    assert updated_data["name"] == "张三-方舟一号"
    assert updated_data["credentialVersion"] == 2
    assert updated_data["cookieBundle"][0]["value"] == "cookie-2"

    listed = client.get("/api/admin/users/1/managed-accounts", headers=_bearer(admin_token))
    assert listed.status_code == 200, listed.text
    assert [item["name"] for item in payload(listed)["items"]] == ["张三-方舟一号", "user-1-ark"]




def _cookie_account_with_binding(client: Any, admin_token: str, platform: dict[str, Any]) -> int:
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
    return account_id


def _issue_bootstrap(
    client: Any, user_token: str, platform: dict[str, Any], account_id: int,
    device_id: str | None = "device-a",
) -> dict[str, Any]:
    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"managedAccountId": account_id, "deviceId": device_id},
    )
    assert issued.status_code == 200, issued.text
    return payload(issued)


def _consume_bootstrap(
    client: Any, user_token: str, platform: dict[str, Any], grant: dict[str, Any],
    device_id: str | None = "device-a",
) -> dict[str, Any]:
    consumed = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
        headers=_bearer(user_token),
        json={"bootstrapToken": grant["bootstrapToken"], "deviceId": device_id},
    )
    assert consumed.status_code == 200, consumed.text
    return payload(consumed)


def _start_managed_session(
    client: Any, user_token: str, platform: dict[str, Any], account_id: int,
    device_id: str | None = "device-a",
) -> dict[str, Any]:
    grant = _issue_bootstrap(client, user_token, platform, account_id, device_id)
    consumed = _consume_bootstrap(client, user_token, platform, grant, device_id)
    return {
        "managedAccountId": consumed["managedAccountId"],
        "credentialVersion": consumed["credentialVersion"],
        "sessionId": consumed["sessionId"],
        "deviceId": device_id,
    }


def _report_expired(
    client: Any, user_token: str, platform: dict[str, Any], identity: dict[str, Any],
) -> Any:
    return client.post(
        f"/api/user/managed-platforms/{platform['id']}/session-expired",
        headers=_bearer(user_token),
        json=identity,
    )


def test_report_session_expired_marks_account_and_blocks_bootstrap(api: Any) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    pending = _issue_bootstrap(client, user_token, platform, account_id)

    reported = _report_expired(client, user_token, platform, identity)
    assert reported.status_code == 200, reported.text
    report = payload(reported)
    assert report == {"sessionStatus": "expired", "credentialVersion": 2, "applied": True}
    assert reported.headers["Cache-Control"] == "no-store"

    with module.db.session() as session_db:
        row = session_db.get(module.ManagedPlatformAccount, account_id)
        assert row is not None
        assert row.session_status == "expired"
        assert row.last_error == "客户端上报：用户在平台退出登录"
        assert row.cookie_bundle[0]["value"] == "secret-cookie"

    # Expiry blocks fresh issuance and grants that were issued but not consumed.
    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"deviceId": "device-a"},
    )
    assert issued.status_code == 409, issued.text
    assert "退出" in issued.text
    consumed = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
        headers=_bearer(user_token),
        json={"bootstrapToken": pending["bootstrapToken"], "deviceId": "device-a"},
    )
    assert consumed.status_code == 409, consumed.text

    again = _report_expired(client, user_token, platform, identity)
    assert again.status_code == 200, again.text
    assert payload(again) == {**report, "applied": False}
    with module.db.session() as session_db:
        audits = session_db.query(module.UserLog).filter_by(action="MANAGED_SESSION_EXPIRED").all()
        assert len(audits) == 1
        assert audits[0].details["sessionId"] == identity["sessionId"]
        assert audits[0].details["credentialVersion"] == identity["credentialVersion"]


@pytest.mark.parametrize("endpoint", ["account-patch", "user-patch", "legacy-put"])
def test_admin_credential_rotation_resets_session_status(
    api: Any, endpoint: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    reported = _report_expired(client, user_token, platform, identity)
    assert reported.status_code == 200, reported.text

    _install_probe(monkeypatch, _verified_probe([]))
    credentials = {
        "authMode": "cookie",
        "cookieBundle": [{"name": "sessionid", "value": "fresh-cookie", "domain": ".example.test"}],
    }
    if endpoint == "legacy-put":
        rotated = client.put(
            "/api/admin/users/1/managed-account", headers=_bearer(admin_token), json=credentials
        )
    else:
        path = (
            f"/api/admin/managed-platform-accounts/{account_id}"
            if endpoint == "account-patch" else f"/api/admin/users/1/managed-accounts/{account_id}"
        )
        rotated = client.patch(path, headers=_bearer(admin_token), json=credentials)
    assert rotated.status_code == 200, rotated.text
    assert payload(rotated)["sessionStatus"] == "valid"
    assert payload(rotated)["credentialVersion"] == 3

    # A retry from the old browser must not invalidate the replacement cookie.
    for _ in range(2):
        late = _report_expired(client, user_token, platform, identity)
        assert late.status_code == 200, late.text
        assert payload(late) == {"sessionStatus": "valid", "credentialVersion": 3, "applied": False}
    grant = _issue_bootstrap(client, user_token, platform, account_id)
    consumed = _consume_bootstrap(client, user_token, platform, grant)
    assert consumed["cookieBundle"][0]["value"] == "fresh-cookie"
    assert consumed["credentialVersion"] == 3
    with module.db.session() as session_db:
        assert session_db.query(module.UserLog).filter_by(action="MANAGED_SESSION_EXPIRED").count() == 1


def test_session_expiry_requires_complete_strict_identity(api: Any) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    invalid_payloads = [
        {"managedAccountId": account_id},  # Unsafe legacy request is not supported.
        {key: value for key, value in identity.items() if key != "sessionId"},
        {key: value for key, value in identity.items() if key != "credentialVersion"},
        *({**identity, "managedAccountId": value} for value in (0, -1, True, "1", 1.5, 2**63)),
        *({**identity, "credentialVersion": value} for value in (0, -1, True, "1", 1.5, 2**31)),
        *({**identity, "sessionId": value} for value in (None, 1, "", "0", "01", "-1", "1x", str(2**63))),
        {**identity, "deviceId": 42},
    ]
    for invalid in invalid_payloads:
        response = _report_expired(client, user_token, platform, invalid)
        assert response.status_code == 422, response.text
    with module.db.session() as session:
        account = session.get(module.ManagedPlatformAccount, account_id)
        assert account.session_status == "valid"
        assert account.credential_version == 1
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_EXPIRED").count() == 0


def test_session_expiry_rejects_unconsumed_unknown_wrong_version_and_device(api: Any) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    grant = _issue_bootstrap(client, user_token, platform, account_id)
    with module.db.session() as session:
        row = session.query(module.ManagedBrowserSession).one()
        identity = {
            "managedAccountId": account_id,
            "credentialVersion": row.credential_version,
            "sessionId": str(row.id),
            "deviceId": "device-a",
        }
    unconsumed = _report_expired(client, user_token, platform, identity)
    assert unconsumed.status_code == 409, unconsumed.text
    _consume_bootstrap(client, user_token, platform, grant)
    for changes in (
        {"sessionId": "999999"},
        {"credentialVersion": 2},
        {"deviceId": "device-b"},
        {"deviceId": None},
    ):
        denied = _report_expired(client, user_token, platform, {**identity, **changes})
        assert denied.status_code == 409, denied.text
    with module.db.session() as session:
        account = session.get(module.ManagedPlatformAccount, account_id)
        assert account.session_status == "valid"
        assert account.credential_version == 1
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_EXPIRED").count() == 0


def test_session_expiry_rejects_cross_user_account_and_platform(api: Any) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    other_user = client.post(
        "/api/admin/users", headers=_bearer(admin_token),
        json={"username": "other-user", "password": "other-password", "name": "Other User", "expiresAt": "2099-12-31"},
    )
    assert other_user.status_code == 201, other_user.text
    user_id = payload(other_user)["id"]
    bound = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/bindings",
        headers=_bearer(admin_token), json={"userId": user_id},
    )
    assert bound.status_code == 201, bound.text
    other_token = _login(client, "/api/user/auth/login", "other-user", "other-password")
    stolen = _report_expired(client, other_token, platform, identity)
    assert stolen.status_code == 409, stolen.text

    other_account = client.post(
        "/api/admin/users/1/managed-accounts", headers=_bearer(admin_token),
        json={"name": "other-account", "authMode": "cookie", "cookieBundle": [{"name": "sid", "value": "other", "domain": ".example.test"}]},
    )
    assert other_account.status_code == 201, other_account.text
    crossed = _report_expired(
        client, user_token, platform, {**identity, "managedAccountId": payload(other_account)["managedAccountId"]}
    )
    assert crossed.status_code == 409, crossed.text
    other_platform = client.post(
        "/api/admin/platforms", headers=_bearer(admin_token),
        json={"name": "other-platform", "url": "https://other.example.test/admin"},
    )
    assert other_platform.status_code == 201, other_platform.text
    crossed = _report_expired(client, user_token, payload(other_platform), identity)
    assert crossed.status_code == 409, crossed.text
    with module.db.session() as session:
        assert all(account.session_status == "valid" for account in session.query(module.ManagedPlatformAccount))
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_EXPIRED").count() == 0


@pytest.mark.parametrize("binding_state", ["removed", "inactive"])
def test_session_expiry_requires_binding_to_remain_active(api: Any, binding_state: str) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    if binding_state == "removed":
        removed = client.delete(
            f"/api/admin/managed-platform-accounts/{account_id}/bindings/1", headers=_bearer(admin_token)
        )
        assert removed.status_code == 200, removed.text
    else:
        with module.db.session() as session:
            session.query(module.ManagedPlatformBinding).one().status = "disabled"
    response = _report_expired(client, user_token, platform, identity)
    assert response.status_code == (404 if binding_state == "removed" else 409), response.text
    with module.db.session() as session:
        account = session.get(module.ManagedPlatformAccount, account_id)
        assert account.session_status == "valid"
        assert account.credential_version == 1
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_EXPIRED").count() == 0


def test_consumed_session_can_report_after_grant_ttl_and_cleanup(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import timedelta

    from app.repositories import managed_platforms as repository
    from app.services import managed_platforms as service

    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    unconsumed = _issue_bootstrap(client, user_token, platform, account_id)
    later = module.utc_now() + timedelta(days=1)
    monkeypatch.setattr(service, "utc_now", lambda: later)
    denied = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume", headers=_bearer(user_token),
        json={"bootstrapToken": unconsumed["bootstrapToken"], "deviceId": "device-a"},
    )
    assert denied.status_code == 409, denied.text
    with module.db.session() as session:
        assert repository.purge_expired_sessions(session, later) == 1
        assert session.query(module.ManagedBrowserSession).count() == 1
        assert session.get(module.ManagedBrowserSession, int(identity["sessionId"])).consumed_at is not None
    reported = _report_expired(client, user_token, platform, identity)
    assert reported.status_code == 200, reported.text
    assert payload(reported) == {"sessionStatus": "expired", "credentialVersion": 2, "applied": True}


@pytest.mark.parametrize("device_id", [None, "  device-a  ", "   "])
def test_session_expiry_normalizes_optional_device_consistently(api: Any, device_id: str | None) -> None:
    client, _module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id, device_id)
    if device_id is None:
        identity.pop("deviceId")
    response = _report_expired(client, user_token, platform, identity)
    assert response.status_code == 200, response.text
    assert payload(response)["applied"] is True


@pytest.mark.parametrize("invalid_state", ["session-expired", "binding-inactive", "wrong-platform", "platform-inactive"])
def test_consume_checks_current_account_and_binding_state(api: Any, invalid_state: str) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    grant = _issue_bootstrap(client, user_token, platform, account_id)
    with module.db.session() as session:
        account = session.get(module.ManagedPlatformAccount, account_id)
        if invalid_state == "session-expired":
            account.session_status = "expired"  # Even without a version bump, never consume.
        elif invalid_state == "binding-inactive":
            session.query(module.ManagedPlatformBinding).one().status = "disabled"
        elif invalid_state == "wrong-platform":
            account.platform_id = platform["id"] + 1
        else:
            session.get(module.Platform, platform["id"]).status = "disabled"
    consumed = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume", headers=_bearer(user_token),
        json={"bootstrapToken": grant["bootstrapToken"], "deviceId": "device-a"},
    )
    assert consumed.status_code == 409, consumed.text
    with module.db.session() as session:
        assert session.query(module.ManagedBrowserSession).one().consumed_at is None
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_BOOTSTRAP_CONSUMED").count() == 0


@pytest.mark.parametrize("separate_sessions", [False, True])
def test_concurrent_expiry_reports_apply_once(api: Any, monkeypatch: pytest.MonkeyPatch, separate_sessions: bool) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from app.repositories import managed_platforms as repository
    from app.services import managed_platforms as service
    from app.services.audit import AuditContext

    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    first = _start_managed_session(client, user_token, platform, account_id)
    second = _start_managed_session(client, user_token, platform, account_id) if separate_sessions else first
    barrier = Barrier(2, timeout=10)
    original = repository.expire_account_session

    def synchronized_expiry(session: Any, **kwargs: Any) -> bool:
        # Both SQLite transactions read version 1 before either may write.
        barrier.wait()
        return original(session, **kwargs)

    monkeypatch.setattr(repository, "expire_account_session", synchronized_expiry)

    def report(identity: dict[str, Any]) -> dict[str, Any]:
        return service.report_session_expired(
            module.db._database, 1, platform["id"], account_id,
            identity["credentialVersion"], identity["sessionId"], identity["deviceId"],
            audit=AuditContext(actor_type="user", actor_id=1),
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(report, identity) for identity in (first, second)]
        results = [future.result(timeout=20) for future in futures]
    assert sorted(result["applied"] for result in results) == [False, True]
    assert all(result["sessionStatus"] == "expired" and result["credentialVersion"] == 2 for result in results)
    with module.db.session() as session:
        assert session.get(module.ManagedPlatformAccount, account_id).credential_version == 2
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_EXPIRED").count() == 1


def test_concurrent_bootstrap_consumes_release_cookie_only_once(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from app.repositories import managed_platforms as repository
    from app.services import managed_platforms as service
    from app.services.audit import AuditContext
    from app.services.errors import ConflictError

    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    grant = _issue_bootstrap(client, user_token, platform, account_id)
    barrier = Barrier(2, timeout=10)
    original = repository.consume_session

    def synchronized_consume(session: Any, row: Any, now: Any) -> bool:
        barrier.wait()
        return original(session, row, now)

    monkeypatch.setattr(repository, "consume_session", synchronized_consume)

    def consume() -> dict[str, Any] | None:
        try:
            return service.consume_bootstrap(
                module.db._database, 1, platform["id"], grant["bootstrapToken"], "device-a",
                audit=AuditContext(actor_type="user", actor_id=1),
            )
        except ConflictError:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(consume) for _ in range(2)]
        results = [future.result(timeout=20) for future in futures]
    assert sum(result is not None for result in results) == 1
    successful = next(result for result in results if result is not None)
    assert successful["cookieBundle"][0]["value"] == "secret-cookie"
    with module.db.session() as session:
        assert session.query(module.ManagedBrowserSession).one().consumed_at is not None
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_BOOTSTRAP_CONSUMED").count() == 1


@pytest.mark.parametrize("winning_change", ["rotate", "expire", "unbind"])
def test_consume_cas_rechecks_changes_after_initial_reads(api: Any, monkeypatch: pytest.MonkeyPatch, winning_change: str) -> None:
    from app.repositories import managed_platforms as repository
    from app.services import managed_platforms as service

    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    running = _start_managed_session(client, user_token, platform, account_id)
    grant = _issue_bootstrap(client, user_token, platform, account_id)
    original = repository.consume_session

    def change_then_consume(session: Any, row: Any, now: Any) -> bool:
        if winning_change == "rotate":
            service.update_account(module.db._database, account_id, {
                "cookie_bundle": [{"name": "sid", "value": "fresh", "domain": ".example.test"}]
            })
        elif winning_change == "expire":
            service.report_session_expired(
                module.db._database, 1, platform["id"], account_id,
                running["credentialVersion"], running["sessionId"], running["deviceId"],
            )
        else:
            service.unbind_account(module.db._database, account_id, 1)
        return original(session, row, now)

    monkeypatch.setattr(repository, "consume_session", change_then_consume)
    denied = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume", headers=_bearer(user_token),
        json={"bootstrapToken": grant["bootstrapToken"], "deviceId": "device-a"},
    )
    assert denied.status_code == 409, denied.text
    with module.db.session() as session:
        row = session.query(module.ManagedBrowserSession).order_by(module.ManagedBrowserSession.id.desc()).first()
        assert row.consumed_at is None
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_BOOTSTRAP_CONSUMED").count() == 1


def test_expiry_cas_does_not_overwrite_concurrent_fresh_credentials(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.repositories import managed_platforms as repository
    from app.services import managed_platforms as service

    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    original = repository.expire_account_session
    fresh_cookies = [{"name": "sid", "value": "fresh", "domain": ".example.test"}]

    def change_then_expire(session: Any, **kwargs: Any) -> bool:
        service.update_account(module.db._database, account_id, {"cookie_bundle": fresh_cookies})
        return original(session, **kwargs)

    monkeypatch.setattr(repository, "expire_account_session", change_then_expire)
    ignored = _report_expired(client, user_token, platform, identity)
    assert ignored.status_code == 200, ignored.text
    assert payload(ignored) == {"sessionStatus": "valid", "credentialVersion": 2, "applied": False}
    with module.db.session() as session:
        account = session.get(module.ManagedPlatformAccount, account_id)
        assert account.cookie_bundle[0]["value"] == "fresh"
        assert account.last_error is None
        assert session.query(module.UserLog).filter_by(action="MANAGED_SESSION_EXPIRED").count() == 0


def test_recovery_provider_cannot_overwrite_concurrent_rotation(api: Any, recovery_enabled: None) -> None:
    from app.services import managed_platforms as service
    from app.services.managed_recovery import run_recovery

    client, module = api
    admin_token, _user_token, platform = _setup(client)
    saved = client.put(
        "/api/admin/users/1/managed-account", headers=_bearer(admin_token),
        json={"authMode": "server_login", "username": "owner", "password": "old-password"},
    )
    assert saved.status_code == 200, saved.text
    account_id = payload(saved)["id"]

    class RacingProvider:
        def verify(self, **_kwargs: Any) -> service.ManagedLoginResult:
            service.update_account(module.db._database, account_id, {"password": "fresh-password"})
            return service.ManagedLoginResult(
                "verified", [{"name": "sid", "value": "stale-result", "domain": ".example.test"}],
                remote_account_id="test-remote-user",
            )

    assert run_recovery(module.db._database, account_id, provider=RacingProvider()) is False
    after = payload(client.get("/api/admin/users/1/managed-account", headers=_bearer(admin_token)))
    assert after["password"] == "fresh-password"
    assert after["cookieBundle"] == []
    assert after["credentialVersion"] == 2
    assert after["sessionStatus"] == "expired"
    assert after["recoveryStatus"] == "pending"
    with module.db.session() as session:
        assert session.query(module.ManagedBrowserSession).count() == 0


@pytest.mark.parametrize("endpoint", ["account-patch", "user-patch", "legacy-put"])
def test_admin_write_cas_rejects_an_expiry_winning_after_read(api: Any, monkeypatch: pytest.MonkeyPatch, endpoint: str) -> None:
    from app.repositories import managed_platforms as repository
    from app.services import managed_platforms as service

    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    original = repository.get_account_for_update
    triggered = False

    def expire_after_read(session: Any, selected_id: Any) -> Any:
        nonlocal triggered
        stale = original(session, selected_id)
        if not triggered:
            triggered = True
            service.report_session_expired(
                module.db._database, 1, platform["id"], account_id,
                identity["credentialVersion"], identity["sessionId"], identity["deviceId"],
            )
        return stale

    monkeypatch.setattr(repository, "get_account_for_update", expire_after_read)
    credentials = {"authMode": "cookie", "cookieBundle": [{"name": "sid", "value": "racing-cookie", "domain": ".example.test"}]}
    if endpoint == "legacy-put":
        updated = client.put("/api/admin/users/1/managed-account", headers=_bearer(admin_token), json=credentials)
    else:
        path = (
            f"/api/admin/managed-platform-accounts/{account_id}"
            if endpoint == "account-patch" else f"/api/admin/users/1/managed-accounts/{account_id}"
        )
        updated = client.patch(path, headers=_bearer(admin_token), json=credentials)
    assert updated.status_code == 409, updated.text
    with module.db.session() as session:
        account = session.get(module.ManagedPlatformAccount, account_id)
        assert account.credential_version == 2
        assert account.session_status == "expired"
        assert account.cookie_bundle[0]["value"] == "secret-cookie"
        assert session.query(module.UserLog).filter(module.UserLog.action.in_([
            "MANAGED_ACCOUNT_UPDATED", "MANAGED_ACCOUNT_USER_UPDATED", "MANAGED_ACCOUNT_USER_UPSERTED"
        ])).count() == 0


class _FakeLocator:
    def __init__(self, text: str) -> None:
        self._text = text

    def inner_text(self, timeout: Any = None) -> str:
        return self._text


class _FakePage:
    def __init__(self, url: str, text: str) -> None:
        self.url = url
        self._text = text

    def locator(self, _selector: str) -> _FakeLocator:
        return _FakeLocator(self._text)


def test_looks_like_login_flags_logged_out_marketing_homepage() -> None:
    """登出后的营销首页没有验证码，必须凭「立即登录」等特征识别为未登录。"""
    from app.services.managed_platforms import PlaywrightManagedLoginProvider

    provider = PlaywrightManagedLoginProvider()
    page = _FakePage(
        "https://agent.oceanengine.com/",
        "巨量引擎方舟 多元营销 生态引擎 立即登录 加入我们",
    )
    assert provider._looks_like_login(page) is True


def test_looks_like_login_accepts_logged_in_workbench() -> None:
    from app.services.managed_platforms import PlaywrightManagedLoginProvider

    provider = PlaywrightManagedLoginProvider()
    page = _FakePage(
        "https://agent.oceanengine.com/workbench",
        "工作台 概览 数据报表 资产 退出登录",
    )
    assert provider._looks_like_login(page) is False


def test_looks_like_login_still_flags_captcha_pages() -> None:
    from app.services.managed_platforms import PlaywrightManagedLoginProvider

    provider = PlaywrightManagedLoginProvider()
    page = _FakePage(
        "https://agent.oceanengine.com/workbench",
        "安全验证 请输入验证码",
    )
    assert provider._looks_like_login(page) is True


def test_cookie_provider_rejects_an_expired_entry_before_launching_browser() -> None:
    from app.services.managed_platforms import PlaywrightManagedLoginProvider

    result = PlaywrightManagedLoginProvider(executable_path="/does/not/exist").verify(
        platform_url="https://agent.oceanengine.com/workbench",
        auth_mode="cookie",
        username=None,
        password=None,
        cookie_bundle=[
            {
                "name": "sessionid",
                "value": "still-present",
                "domain": ".oceanengine.com",
                "expiresAt": "2099-01-01T00:00:00Z",
            },
            {
                "name": "sessionid_ss",
                "value": "expired",
                "domain": ".oceanengine.com",
                "expiresAt": "2000-01-01T00:00:00Z",
            },
        ],
    )
    assert result.status == "invalid"
    assert "过期" in result.detail


def test_looks_like_login_rejects_an_unknown_public_page() -> None:
    from app.services.managed_platforms import PlaywrightManagedLoginProvider

    provider = PlaywrightManagedLoginProvider()
    page = _FakePage("https://agent.oceanengine.com/workbench", "公告列表 帮助中心")
    assert provider._looks_like_login(page) is True




# ---------------------------------------------------------------------------
# 远端身份探测（platform user-info probe）
# ---------------------------------------------------------------------------


def _verified_probe(calls: list | None = None):
    from app.services.managed_identity import IdentityProbeOutcome

    def fake(platform_url: str, cookie_bundle: list):
        if calls is not None:
            calls.append((platform_url, list(cookie_bundle)))
        return IdentityProbeOutcome(
            state="verified",
            remote_account_id="782454999746269",
            remote_display_name="潘鹏 · 天津志禧网络技术有限公司",
            detail="登录态有效",
        )

    return fake


def _outcome_probe(state: str, detail: str = ""):
    from app.services.managed_identity import IdentityProbeOutcome

    def fake(platform_url: str, cookie_bundle: list):
        return IdentityProbeOutcome(state=state, detail=detail)

    return fake


def _install_probe(monkeypatch: pytest.MonkeyPatch, fake) -> None:
    from app.services import managed_platforms as managed_platforms_service

    monkeypatch.setattr(managed_platforms_service, "_identity_probe", fake)


def _create_cookie_account(client: Any, admin_token: str, platform: dict[str, Any]) -> Any:
    response = client.post(
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
    return response


def test_identity_probe_fills_remote_identity_on_admin_create(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    calls: list = []
    _install_probe(monkeypatch, _verified_probe(calls))

    response = _create_cookie_account(client, admin_token, platform)
    assert response.status_code == 201, response.text
    data = payload(response)
    assert data["remoteAccountId"] == "782454999746269"
    assert data["remoteDisplayName"] == "潘鹏 · 天津志禧网络技术有限公司"
    assert data["identityCheckedAt"] is not None
    assert len(calls) == 1
    probe_url, probe_bundle = calls[0]
    assert probe_url == platform["url"]
    assert probe_bundle[0]["name"] == "sessionid"

    from sqlalchemy import select

    with module.db.session() as session:
        row = session.scalar(select(module.ManagedPlatformAccount))
        assert row is not None
        assert row.remote_account_id == "782454999746269"
        assert row.remote_display_name == "潘鹏 · 天津志禧网络技术有限公司"
        assert row.identity_checked_at is not None
        assert row.last_verified_at is not None


def test_identity_probe_rejects_dead_cookie_on_admin_create(api: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    _install_probe(monkeypatch, _outcome_probe("invalid", "没有获取到您的登录信息，请先登录"))

    response = _create_cookie_account(client, admin_token, platform)
    assert response.status_code == 400, response.text
    assert "Cookie 校验失败" in message(response)
    assert "没有获取到您的登录信息" in message(response)


    with module.db.session() as session:
        assert session.query(module.ManagedPlatformAccount).count() == 0


def test_identity_probe_unavailable_does_not_block_admin_create(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    _install_probe(monkeypatch, _outcome_probe("unavailable", "identity probe failed: timeout"))

    response = _create_cookie_account(client, admin_token, platform)
    assert response.status_code == 201, response.text
    data = payload(response)
    assert data["remoteAccountId"] is None
    assert data["identityCheckedAt"] is None


def test_identity_probe_not_called_for_server_login_accounts(
    api: Any, monkeypatch: pytest.MonkeyPatch, recovery_enabled: None,
) -> None:
    client, _module = api
    admin_token, _user_token, platform = _setup(client)
    calls: list = []

    def fake(platform_url: str, cookie_bundle: list):
        calls.append(platform_url)
        return None

    _install_probe(monkeypatch, fake)
    response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "账号密码账号",
            "authMode": "server_login",
            "username": "ark-owner",
            "password": "ark-password",
        },
    )
    assert response.status_code == 201, response.text
    assert calls == []


def test_identity_probe_rejects_dead_cookie_on_user_bound_account_update(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    created = client.post(
        "/api/admin/users/1/managed-accounts",
        headers=_bearer(admin_token),
        json={"authMode": "cookie", "cookieBundle": [_session_cookie("first-cookie")]},
    )
    assert created.status_code == 201, created.text
    account_id = payload(created)["managedAccountId"]
    version_before = payload(created)["credentialVersion"]

    _install_probe(monkeypatch, _outcome_probe("invalid", "没有获取到您的登录信息，请先登录"))
    updated = client.patch(
        f"/api/admin/users/1/managed-accounts/{account_id}",
        headers=_bearer(admin_token),
        json={"cookieBundle": [_session_cookie("rotated-cookie")]},
    )
    assert updated.status_code == 400, updated.text
    assert "Cookie 校验失败" in message(updated)


    with module.db.session() as session:
        row = session.get(module.ManagedPlatformAccount, int(account_id))
        assert row is not None
        # 事务回滚：凭据与版本号保持原样。
        assert row.credential_version == version_before
        assert row.cookie_bundle[0]["value"] == "first-cookie"


def _session_cookie(value: str) -> dict[str, Any]:
    return {
        "name": "sessionid",
        "value": value,
        "domain": ".example.test",
        "path": "/",
        "secure": True,
        "httpOnly": True,
        "sameSite": "Lax",
    }


def test_identity_check_endpoint_refreshes_identity_without_restoring_expired_session(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)

    from sqlalchemy import select

    with module.db.session() as session:
        row = session.scalar(select(module.ManagedPlatformAccount))
        row.session_status = "expired"
        row.last_error = "客户端上报平台侧退出"

    calls: list = []
    _install_probe(monkeypatch, _verified_probe(calls))
    response = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/identity-check",
        headers=_bearer(admin_token),
    )
    assert response.status_code == 200, response.text
    data = payload(response)
    assert data["state"] == "verified"
    assert "替换 Cookie" in data["detail"]
    assert data["account"]["sessionStatus"] == "expired"
    assert data["account"]["lastError"] == "客户端上报平台侧退出"
    assert data["account"]["remoteDisplayName"] == "潘鹏 · 天津志禧网络技术有限公司"
    assert len(calls) == 1


def test_identity_check_endpoint_marks_invalid_session_expired(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)

    _install_probe(monkeypatch, _outcome_probe("invalid", "没有获取到您的登录信息，请先登录"))
    response = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/identity-check",
        headers=_bearer(admin_token),
    )
    assert response.status_code == 200, response.text
    data = payload(response)
    assert data["state"] == "invalid"
    assert data["account"]["sessionStatus"] == "expired"
    assert "没有获取到您的登录信息" in data["account"]["lastError"]

    # 会话失效后用户无法再发起托管启动。
    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"managedAccountId": account_id, "deviceId": "device-a"},
    )
    assert issued.status_code == 409, issued.text


def test_identity_check_endpoint_rejects_non_cookie_account(
    api: Any, monkeypatch: pytest.MonkeyPatch, recovery_enabled: None,
) -> None:
    client, module = api
    admin_token, _user_token, platform = _setup(client)
    response = client.post(
        "/api/admin/managed-platform-accounts",
        headers=_bearer(admin_token),
        json={
            "platformId": platform["id"],
            "name": "账号密码账号",
            "authMode": "server_login",
            "username": "ark-owner",
            "password": "ark-password",
        },
    )
    account_id = payload(response)["id"]
    calls: list = []
    _install_probe(monkeypatch, _verified_probe(calls))
    # 自动登录还没写回 Cookie：没有可校验的会话，直接拒绝且不发探测请求。
    checked = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/identity-check",
        headers=_bearer(admin_token),
    )
    assert checked.status_code == 400, checked.text
    assert "还没有可校验的登录会话" in checked.text
    assert calls == []

    # 自动登录成功后 Cookie 与 Cookie 模式同源：身份校验同样可用。
    from sqlalchemy import text as sql_text

    with module.db.session() as session:
        session.execute(
            sql_text("UPDATE managed_platform_account SET cookie_bundle = :bundle WHERE id = :id"),
            {"bundle": '[{"name":"sessionid","value":"stored-cookie","domain":".example.test"}]', "id": account_id},
        )
    verified = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/identity-check",
        headers=_bearer(admin_token),
    )
    assert verified.status_code == 200, verified.text
    assert payload(verified)["state"] == "verified"
    assert len(calls) == 1


def test_identity_check_endpoint_maps_unavailable_to_503(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _module = api
    admin_token, _user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    _install_probe(monkeypatch, _outcome_probe("unavailable", "identity probe failed: timeout"))
    response = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/identity-check",
        headers=_bearer(admin_token),
    )
    assert response.status_code == 503, response.text


def test_issue_bootstrap_reuse_path_probes_and_fills_identity(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)

    calls: list = []
    _install_probe(monkeypatch, _verified_probe(calls))
    grant = _issue_bootstrap(client, user_token, platform, account_id)
    assert grant["managedAccountId"] == account_id

    from sqlalchemy import select

    with module.db.session() as session:
        row = session.scalar(select(module.ManagedPlatformAccount))
        assert row.remote_account_id == "782454999746269"
        assert row.identity_checked_at is not None
        # 复用路径不轮换凭据。
        assert row.credential_version == 1


def test_issue_bootstrap_reuse_path_probe_invalid_blocks_and_marks_expired(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)

    _install_probe(monkeypatch, _outcome_probe("invalid", "没有获取到您的登录信息，请先登录"))
    issued = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"managedAccountId": account_id, "deviceId": "device-a"},
    )
    assert issued.status_code == 409, issued.text
    assert "平台侧退出" in message(issued)

    from sqlalchemy import select

    with module.db.session() as session:
        row = session.scalar(select(module.ManagedPlatformAccount))
        assert row.session_status == "expired"
        assert "没有获取到您的登录信息" in (row.last_error or "")

    # 标记失效后，随后的启动也一并被上下文加载检查拒绝。
    again = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"managedAccountId": account_id, "deviceId": "device-a"},
    )
    assert again.status_code == 409, again.text


def test_issue_bootstrap_reuse_path_probe_unavailable_still_issues_grant(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)

    _install_probe(monkeypatch, _outcome_probe("unavailable", "identity probe failed: timeout"))
    grant = _issue_bootstrap(client, user_token, platform, account_id)
    assert grant["managedAccountId"] == account_id


def test_issue_bootstrap_reuse_path_skips_probe_when_identity_fresh(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    calls: list = []
    _install_probe(monkeypatch, _verified_probe(calls))
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    assert len(calls) == 1  # 创建时已探测

    fresh_calls: list = []
    _install_probe(monkeypatch, _verified_probe(fresh_calls))
    grant = _issue_bootstrap(client, user_token, platform, account_id)
    assert grant["managedAccountId"] == account_id
    assert fresh_calls == []  # 身份仍然新鲜，不再探测


def test_session_cookie_selection_prefers_plain_sessionid_last_occurrence() -> None:
    from app.services.managed_identity import (
        _session_cookie_value,
        _supports_platform,
    )

    assert _supports_platform("https://agent.oceanengine.com/admin") is True
    assert _supports_platform("https://sso.different.example/admin") is False

    bundle = [
        {"name": "sessionid", "value": "old", "domain": ".oceanengine.com"},
        {"name": "sessionid", "value": "new", "domain": "agent.oceanengine.com"},
        {"name": "sessionid_ss", "value": "ss-old", "domain": ".oceanengine.com"},
        {"name": "unrelated", "value": "x", "domain": ".oceanengine.com"},
    ]
    assert _session_cookie_value(bundle) == "new"
    assert _session_cookie_value([{"name": "unrelated", "value": "x", "domain": ".oceanengine.com"}]) is None
    # 其它平台的 Cookie 不参与本平台探测。
    assert _session_cookie_value([{"name": "sessionid", "value": "x", "domain": ".other.com"}]) is None


def _identity_outcome(state: str) -> Any:
    from app.services.managed_identity import IdentityProbeOutcome

    return IdentityProbeOutcome(state=state)


def _clear_session_probe_cache(module: Any) -> None:
    from app.services import managed_platforms as managed_service

    managed_service._session_probe_cache.clear()


def test_desktop_sync_probe_expires_dead_session_and_surfaces_in_config(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    from app.services import managed_platforms as managed_service

    account_id = _cookie_account_with_binding(client, admin_token, platform)
    _clear_session_probe_cache(module)
    calls: list[str] = []

    def probe(url: str, cookies: Any) -> Any:
        calls.append(url)
        return _identity_outcome("invalid")

    monkeypatch.setattr(managed_service, "_identity_probe", probe)
    managed_service.refresh_session_statuses(module.db._database, 1)
    assert calls, "dead session must be probed before the desktop payload"
    with module.db.session() as session:
        row = session.get(module.ManagedPlatformAccount, account_id)
        assert row.session_status == "expired"
        assert row.credential_version == 2
        assert row.last_error == "自动校验：上游会话已失效"

    config = client.get("/api/user/desktop-config", headers=_bearer(user_token))
    assert config.status_code == 200, config.text
    accounts = payload(config)["platforms"][0]["managedAccounts"]
    assert accounts and accounts[0]["status"] == "expired"

    # 已失效的账号不再被选中，也就不会再探测。
    calls.clear()
    managed_service.refresh_session_statuses(module.db._database, 1)
    assert calls == []
    blocked = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap",
        headers=_bearer(user_token),
        json={"managedAccountId": account_id, "deviceId": "device-a"},
    )
    assert blocked.status_code == 409, blocked.text


def test_desktop_sync_probe_never_resurrects_a_reported_expired_session(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin_token, platform)
    identity = _start_managed_session(client, user_token, platform, account_id)
    reported = _report_expired(client, user_token, platform, identity)
    assert payload(reported)["applied"] is True
    from app.services import managed_platforms as managed_service

    _clear_session_probe_cache(module)

    def probe(url: str, cookies: Any) -> Any:
        raise AssertionError("expired accounts must never be probed")

    monkeypatch.setattr(managed_service, "_identity_probe", probe)
    managed_service.refresh_session_statuses(module.db._database, 1)
    with module.db.session() as session:
        row = session.get(module.ManagedPlatformAccount, account_id)
        assert row.session_status == "expired"
        assert row.credential_version == 2, "probe must not bump an already-expired version"


def test_desktop_sync_probe_unknown_keeps_state_and_valid_is_cached(
    api: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, module = api
    admin_token, user_token, platform = _setup(client)
    from app.services import managed_platforms as managed_service

    account_id = _cookie_account_with_binding(client, admin_token, platform)
    _clear_session_probe_cache(module)

    states = ["unavailable", "verified", "verified"]
    calls: list[str] = []

    def probe(url: str, cookies: Any) -> Any:
        calls.append(url)
        return _identity_outcome(states.pop(0))

    monkeypatch.setattr(managed_service, "_identity_probe", probe)
    # 未知：状态保持 valid，不写缓存。
    managed_service.refresh_session_statuses(module.db._database, 1)
    with module.db.session() as session:
        row = session.get(module.ManagedPlatformAccount, account_id)
        assert row.session_status == "valid"
    # 确定有效：缓存生效，之后的同步不再请求上游。
    managed_service.refresh_session_statuses(module.db._database, 1)
    managed_service.refresh_session_statuses(module.db._database, 1)
    assert calls == ["url"] * 2 or len(calls) == 2, f"unexpected probe count: {calls}"
    with module.db.session() as session:
        row = session.get(module.ManagedPlatformAccount, account_id)
        assert row.session_status == "valid"
    # 有效缓存有 TTL；确定失效缓存则持续跳过探测。
    assert managed_service._session_probe_cache[(account_id, 1)][1] == "valid"
