from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from typing import Any

import pytest

from tests.envelope import payload


class UpstreamResponse:
    status = 200
    body: Any = {"code": 0, "data": {"userId": "test-remote-user", "userName": "测试账号"}}
    error: Exception | None = None

    def __call__(self, request: urllib.request.Request, **kwargs: Any) -> io.BytesIO:
        assert request.full_url == "https://agent.oceanengine.com/agent/user/user-info/"
        if self.error is not None:
            raise self.error
        body = io.BytesIO(json.dumps(self.body).encode())
        if self.status != 200:
            raise urllib.error.HTTPError(request.full_url, self.status, "test response", {}, body)
        return body


@pytest.fixture()
def managed_account(api: Any, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Any, Any, int, int, UpstreamResponse]:
    client, _module = api
    from app.services import managed_platforms

    monkeypatch.setattr(managed_platforms, "_session_probe_cache", {})
    upstream = UpstreamResponse()
    monkeypatch.setattr(urllib.request, "urlopen", upstream)
    admin = payload(client.post("/api/admin/auth/login", json={
        "username": "test-admin", "password": "test-admin-password",
    }))["accessToken"]
    admin_headers = {"Authorization": f"Bearer {admin}"}
    platform_response = client.post("/api/admin/platforms", headers=admin_headers, json={
        "name": "测试方舟", "url": "https://agent.oceanengine.com/admin",
    })
    assert platform_response.status_code == 201
    platform_id = payload(platform_response)["id"]
    user_response = client.post("/api/admin/users", headers=admin_headers, json={
        "username": "test-managed-user", "password": "test-managed-password", "name": "测试用户", "expiresAt": "2099-12-31",
    })
    assert user_response.status_code == 201, user_response.text
    user_id = payload(user_response)["id"]
    user_token = payload(client.post("/api/user/auth/login", json={
        "username": "test-managed-user", "password": "test-managed-password",
    }))["accessToken"]
    user_headers = {"Authorization": f"Bearer {user_token}"}
    created = client.post(f"/api/admin/users/{user_id}/managed-accounts", headers=admin_headers, json={
        "name": "测试托管账号", "authMode": "cookie", "cookieBundle": [_cookie("initial")],
    })
    assert created.status_code == 201, created.text
    account_id = payload(created)["managedAccountId"]
    return client, admin_headers, user_headers, platform_id, account_id, upstream


def _cookie(value: str) -> dict[str, Any]:
    return {"name": "sessionid", "value": value, "domain": ".oceanengine.com", "path": "/"}


def _binding(client: Any, headers: dict[str, str], account_id: int) -> dict[str, Any]:
    response = client.get("/api/admin/managed-bindings", headers=headers)
    assert response.status_code == 200
    return next(item for item in payload(response)["items"] if item["managedAccountId"] == account_id)


def _lease(client: Any, headers: dict[str, str]) -> str:
    response = client.get("/api/user/desktop-config/lease", headers=headers)
    assert response.status_code == 200
    return str(payload(response)["lease"])


@pytest.mark.parametrize("entry", ["account-create", "account-update", "binding-create", "binding-update", "legacy"])
@pytest.mark.parametrize("field", ["autoRelogin", "auto_relogin"])
@pytest.mark.parametrize("value", [True, False])
def test_managed_write_requests_reject_caller_selected_recovery_policy(
    managed_account: Any, entry: str, field: str, value: bool,
) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    before = _binding(client, admin, account_id)
    lease_before = _lease(client, user)
    user_id = before["userId"]
    method, endpoint = {
        "account-create": ("POST", "/api/admin/managed-platform-accounts"),
        "account-update": ("PATCH", f"/api/admin/managed-platform-accounts/{account_id}"),
        "binding-create": ("POST", f"/api/admin/users/{user_id}/managed-accounts"),
        "binding-update": ("PATCH", f"/api/admin/users/{user_id}/managed-accounts/{account_id}"),
        "legacy": ("PUT", f"/api/admin/users/{user_id}/managed-account"),
    }[entry]
    credentials: dict[str, Any] = {
        "authMode": "server_login", "username": "test-email", "password": "test-password", field: value,
    }
    if entry == "account-create":
        credentials.update(platformId=platform_id, name="新账号")
    response = client.request(method, endpoint, headers=admin, json=credentials)
    assert response.status_code == 422, response.text
    assert _binding(client, admin, account_id) == before
    assert _lease(client, user) == lease_before


@pytest.mark.parametrize("entry", ["account-create", "account-update", "binding-create", "binding-update", "legacy"])
@pytest.mark.parametrize("worker_enabled", [True, False])
def test_password_writes_use_the_server_policy_without_a_request_switch(
    managed_account: Any, monkeypatch: pytest.MonkeyPatch, entry: str, worker_enabled: bool,
) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    before = _binding(client, admin, account_id)
    user_id = before["userId"]
    # The fixture's app was started without a worker; changing the configuration
    # here controls only service validation and never starts a background browser.
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "1" if worker_enabled else "0")
    method, endpoint = {
        "account-create": ("POST", "/api/admin/managed-platform-accounts"),
        "account-update": ("PATCH", f"/api/admin/managed-platform-accounts/{account_id}"),
        "binding-create": ("POST", f"/api/admin/users/{user_id}/managed-accounts"),
        "binding-update": ("PATCH", f"/api/admin/users/{user_id}/managed-accounts/{account_id}"),
        "legacy": ("PUT", f"/api/admin/users/{user_id}/managed-account"),
    }[entry]
    credentials: dict[str, Any] = {
        "authMode": "server_login", "username": "test-email", "password": "test-password",
    }
    if entry == "account-create":
        credentials.update(platformId=platform_id, name="强制恢复账号")
    response = client.request(method, endpoint, headers=admin, json=credentials)
    if worker_enabled:
        assert response.status_code in (200, 201), response.text
        account = payload(response)
        assert account["autoRelogin"] is True
        assert account["sessionStatus"] == "expired"
        assert account["recoveryStatus"] == "pending"
        assert account["nextRecoveryAt"] is not None
    else:
        assert response.status_code == 503, response.text
        assert "自动恢复服务未启用" in response.json()["msg"]
        assert _binding(client, admin, account_id) == before
        accounts = payload(client.get("/api/admin/managed-platform-accounts", headers=admin))["items"]
        assert len(accounts) == 1


def test_unknown_check_is_visible_after_refresh_without_refreshing_success_time(managed_account: Any) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    before = payload(client.get(f"/api/admin/managed-platform-accounts/{account_id}", headers=admin))
    lease_before = _lease(client, user)
    upstream.error = urllib.error.URLError(TimeoutError("synthetic-secret-value"))
    checked = client.post(f"/api/admin/managed-platform-accounts/{account_id}/identity-check", headers=admin)
    assert checked.status_code == 503
    row = _binding(client, admin, account_id)
    assert row["lastIdentityCheckState"] == "unavailable"
    assert row["lastIdentityCheckAt"] is not None
    assert "synthetic-secret-value" not in row["lastIdentityCheckDetail"]
    assert row["sessionStatus"] == "valid"
    after = payload(client.get(f"/api/admin/managed-platform-accounts/{account_id}", headers=admin))
    assert after["identityCheckedAt"] == before["identityCheckedAt"]
    assert after["lastVerifiedAt"] == before["lastVerifiedAt"]
    assert after["credentialVersion"] == before["credentialVersion"]
    assert _lease(client, user) == lease_before


def test_successful_check_refreshes_identity_without_changing_desktop_lease(
    managed_account: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import managed_platforms

    client, admin, user, platform_id, account_id, upstream = managed_account
    before = _binding(client, admin, account_id)
    lease_before = _lease(client, user)
    # The API renders timestamps at second precision; avoid wall-clock sleeps.
    checked_at = datetime.fromisoformat(before["lastIdentityCheckAt"].removesuffix("Z")) + timedelta(seconds=2)
    monkeypatch.setattr(managed_platforms, "utc_now", lambda: checked_at)
    upstream.body = {"code": 0, "data": {"userId": "test-remote-user", "userName": "更新后的显示名"}}
    checked = client.post(f"/api/admin/managed-platform-accounts/{account_id}/identity-check", headers=admin)
    assert checked.status_code == 200
    row = _binding(client, admin, account_id)
    assert row["remoteDisplayName"] == "更新后的显示名"
    assert row["lastIdentityCheckState"] == "verified"
    assert row["lastIdentityCheckAt"] != before["lastIdentityCheckAt"]
    assert row["sessionStatus"] == "valid"
    assert row["credentialVersion"] == before["credentialVersion"]
    assert _lease(client, user) == lease_before


@pytest.mark.parametrize("state", ["verified", "unavailable"])
def test_desktop_sync_check_metadata_keeps_the_existing_lease(
    managed_account: Any, state: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import managed_platforms

    client, admin, user, platform_id, account_id, upstream = managed_account
    before = _binding(client, admin, account_id)
    checked_at = datetime.fromisoformat(before["lastIdentityCheckAt"].removesuffix("Z")) + timedelta(seconds=2)
    monkeypatch.setattr(managed_platforms, "utc_now", lambda: checked_at)
    # The lease endpoint does not probe or populate the successful-probe cache.
    lease_before = _lease(client, user)
    if state == "unavailable":
        upstream.error = urllib.error.URLError(TimeoutError("test timeout"))
    else:
        upstream.body = {"code": 0, "data": {"userId": "test-remote-user", "userName": "同步后的显示名"}}
    synced = client.get("/api/user/desktop-config", headers=user)
    assert synced.status_code == 200
    row = _binding(client, admin, account_id)
    assert row["lastIdentityCheckState"] == state
    assert row["lastIdentityCheckAt"] != before["lastIdentityCheckAt"]
    assert row["sessionStatus"] == "valid"
    assert row["credentialVersion"] == before["credentialVersion"]
    assert payload(synced)["lease"] == lease_before
    assert _lease(client, user) == lease_before


@pytest.mark.parametrize("status", [200, 401, 403])
def test_explicit_logout_blocks_bootstrap_and_repeated_checks_do_not_rotate(managed_account: Any, status: int) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    lease_before = _lease(client, user)
    upstream.status = status
    upstream.body = {"code": 1, "msg": "登录态已失效，请先登录"}
    endpoint = f"/api/admin/managed-platform-accounts/{account_id}/identity-check"
    checked = client.post(endpoint, headers=admin)
    assert checked.status_code == 200
    assert payload(checked)["state"] == "invalid"
    first = _binding(client, admin, account_id)
    assert first["sessionStatus"] == "expired"
    assert first["lastIdentityCheckState"] == "invalid"
    expired_lease = _lease(client, user)
    assert expired_lease != lease_before
    assert client.post(endpoint, headers=admin).status_code == 200
    assert _binding(client, admin, account_id)["credentialVersion"] == first["credentialVersion"]
    assert _lease(client, user) == expired_lease
    config = payload(client.get("/api/user/desktop-config", headers=user))
    assert config["lease"] == expired_lease
    desktop_account = next(
        account for platform in config["platforms"] for account in platform["managedAccounts"]
        if account["id"] == account_id
    )
    assert desktop_account["sessionStatus"] == "expired"
    bootstrap = client.post(f"/api/user/managed-platforms/{platform_id}/bootstrap", headers=user, json={
        "managedAccountId": account_id, "deviceId": "test-device",
    })
    assert bootstrap.status_code == 409


def test_checking_an_expired_cookie_cannot_restore_the_session(managed_account: Any) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    endpoint = f"/api/admin/managed-platform-accounts/{account_id}/identity-check"
    upstream.status = 401
    assert client.post(endpoint, headers=admin).status_code == 200
    before = _binding(client, admin, account_id)
    expired_lease = _lease(client, user)
    upstream.status = 200
    checked = client.post(endpoint, headers=admin)
    assert checked.status_code == 200
    assert payload(checked)["state"] == "verified"
    assert payload(checked)["account"]["sessionStatus"] == "expired"
    assert "替换" in payload(checked)["detail"]
    after = _binding(client, admin, account_id)
    assert after["sessionStatus"] == "expired"
    assert after["lastError"] == before["lastError"]
    assert after["credentialVersion"] == before["credentialVersion"]
    assert _lease(client, user) == expired_lease
    bootstrap = client.post(f"/api/user/managed-platforms/{platform_id}/bootstrap", headers=user, json={
        "managedAccountId": account_id, "deviceId": "test-device",
    })
    assert bootstrap.status_code == 409


@pytest.mark.parametrize("entry", ["account", "binding", "legacy"])
def test_expired_cookie_replacement_requires_verification_at_every_entry(managed_account: Any, entry: str) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    upstream.status = 401
    assert client.post(f"/api/admin/managed-platform-accounts/{account_id}/identity-check", headers=admin).status_code == 200
    before = _binding(client, admin, account_id)
    expired_lease = _lease(client, user)
    user_id = before["userId"]
    method, endpoint = {
        "account": ("PATCH", f"/api/admin/managed-platform-accounts/{account_id}"),
        "binding": ("PATCH", f"/api/admin/users/{user_id}/managed-accounts/{account_id}"),
        "legacy": ("PUT", f"/api/admin/users/{user_id}/managed-account"),
    }[entry]
    credentials = {"authMode": "cookie", "cookieBundle": [_cookie("replacement")]}
    upstream.error = urllib.error.URLError(TimeoutError("synthetic timeout"))
    rejected = client.request(method, endpoint, headers=admin, json=credentials)
    assert rejected.status_code == 503, rejected.text
    after_failure = _binding(client, admin, account_id)
    assert after_failure["sessionStatus"] == "expired"
    assert after_failure["credentialVersion"] == before["credentialVersion"]
    assert _lease(client, user) == expired_lease
    detail = payload(client.get(f"/api/admin/users/{user_id}/managed-accounts/{account_id}", headers=admin))
    assert detail["cookieBundle"][0]["value"] == "initial"
    upstream.error = None
    upstream.status = 200
    saved = client.request(method, endpoint, headers=admin, json=credentials)
    assert saved.status_code == 200, saved.text
    after_success = _binding(client, admin, account_id)
    assert after_success["sessionStatus"] == "valid"
    assert after_success["lastIdentityCheckState"] == "verified"
    assert after_success["credentialVersion"] == before["credentialVersion"] + 1
    assert _lease(client, user) != expired_lease
    bootstrap = client.post(f"/api/user/managed-platforms/{platform_id}/bootstrap", headers=user, json={
        "managedAccountId": account_id, "deviceId": "test-device",
    })
    assert bootstrap.status_code == 200, bootstrap.text


def test_desktop_sync_clears_stale_unknown_check_when_upstream_recovers(managed_account: Any) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    upstream.error = urllib.error.URLError(TimeoutError("test timeout"))
    assert client.post(f"/api/admin/managed-platform-accounts/{account_id}/identity-check", headers=admin).status_code == 503
    assert _binding(client, admin, account_id)["lastIdentityCheckState"] == "unavailable"
    upstream.error = None
    synced = client.get("/api/user/desktop-config", headers=user)
    assert synced.status_code == 200, synced.text
    assert _binding(client, admin, account_id)["lastIdentityCheckState"] == "verified"


@pytest.mark.parametrize("change", ["allowedHosts", "expiresAt", "status"])
def test_managed_authorization_changes_invalidate_lease_without_rotating_credentials(
    managed_account: Any, change: str,
) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    endpoint = f"/api/admin/managed-platform-accounts/{account_id}"
    before = payload(client.get(endpoint, headers=admin))
    lease_before = _lease(client, user)
    values = {
        "allowedHosts": [*before["allowedHosts"], "static.oceanengine.com"],
        "expiresAt": "2099-12-30T00:00:00Z",
        "status": "invalid",
    }
    changed = client.patch(endpoint, headers=admin, json={change: values[change]})
    assert changed.status_code == 200, changed.text
    account = payload(changed)
    assert account[change] != before[change]
    assert account["credentialVersion"] == before["credentialVersion"]
    assert _lease(client, user) != lease_before


def test_managed_alias_edit_preserves_the_desktop_lease(managed_account: Any) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    lease_before = _lease(client, user)
    changed = client.patch(f"/api/admin/managed-platform-accounts/{account_id}", headers=admin, json={
        "name": "仅修改管理别名",
    })
    assert changed.status_code == 200, changed.text
    assert payload(changed)["name"] == "仅修改管理别名"
    assert _lease(client, user) == lease_before


def test_unbinding_managed_account_invalidates_the_desktop_lease(managed_account: Any) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    user_id = _binding(client, admin, account_id)["userId"]
    lease_before = _lease(client, user)
    removed = client.delete(f"/api/admin/managed-platform-accounts/{account_id}/bindings/{user_id}", headers=admin)
    assert removed.status_code == 200, removed.text
    assert _lease(client, user) != lease_before
    config = payload(client.get("/api/user/desktop-config", headers=user))
    assert all(
        account["id"] != account_id
        for platform in config["platforms"] for account in platform["managedAccounts"]
    )


def test_valid_cookie_rotation_invalidates_the_existing_desktop_lease(managed_account: Any) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    before = _binding(client, admin, account_id)
    lease_before = _lease(client, user)
    changed = client.patch(f"/api/admin/managed-platform-accounts/{account_id}", headers=admin, json={
        "cookieBundle": [_cookie("rotated")],
    })
    assert changed.status_code == 200, changed.text
    account = payload(changed)
    assert account["sessionStatus"] == before["sessionStatus"] == "valid"
    assert account["credentialVersion"] == before["credentialVersion"] + 1
    assert _lease(client, user) != lease_before


def test_password_mode_change_invalidates_lease_but_request_cannot_disable_recovery(
    managed_account: Any, api: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.managed_platforms import ManagedLoginResult
    from app.services.managed_recovery import run_recovery

    client, admin, user, platform_id, account_id, upstream = managed_account
    _client, module = api
    # The HTTP fixture already started with its worker disabled; only queueing
    # is enabled here. The explicit provider never launches a real browser.
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "1")
    endpoint = f"/api/admin/managed-platform-accounts/{account_id}"
    lease_before = _lease(client, user)
    changed = client.patch(endpoint, headers=admin, json={
        "authMode": "server_login", "username": "test-email", "password": "test-password",
    })
    assert changed.status_code == 200, changed.text
    assert payload(changed)["authMode"] == "server_login"
    assert _lease(client, user) != lease_before

    class Provider:
        def verify(self, **kwargs: Any) -> ManagedLoginResult:
            return ManagedLoginResult("verified", [_cookie("recovered")], remote_account_id="test-remote-user")

    assert run_recovery(module.db, account_id, provider=Provider()) is True
    before = payload(client.get(endpoint, headers=admin))
    lease_before = _lease(client, user)
    changed = client.patch(endpoint, headers=admin, json={"autoRelogin": False})
    assert changed.status_code == 422, changed.text
    after = payload(client.get(endpoint, headers=admin))
    assert before["autoRelogin"] is True
    assert after["autoRelogin"] is True
    assert after["sessionStatus"] == before["sessionStatus"] == "valid"
    assert after["recoveryStatus"] == before["recoveryStatus"] == "idle"
    assert after["credentialVersion"] == before["credentialVersion"]
    assert _lease(client, user) == lease_before


def test_password_recovery_refreshes_check_metadata_and_recheck_keeps_pending_recovery(
    managed_account: Any, api: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.managed_platforms import ManagedLoginResult
    from app.services.managed_recovery import run_recovery

    client, admin, user, platform_id, account_id, upstream = managed_account
    _client, module = api
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "1")
    changed = client.patch(f"/api/admin/managed-platform-accounts/{account_id}", headers=admin, json={
        "authMode": "server_login", "username": "test-email", "password": "test-password",
    })
    assert changed.status_code == 200, changed.text

    class Provider:
        def verify(self, **kwargs: Any) -> ManagedLoginResult:
            return ManagedLoginResult("verified", [_cookie("recovered")], remote_account_id="test-remote-user")

    assert run_recovery(module.db, account_id, provider=Provider()) is True
    recovered = _binding(client, admin, account_id)
    assert recovered["sessionStatus"] == "valid"
    assert recovered["lastIdentityCheckState"] == "verified"
    assert recovered["lastIdentityCheckAt"] is not None
    upstream.status = 401
    endpoint = f"/api/admin/managed-platform-accounts/{account_id}/identity-check"
    assert client.post(endpoint, headers=admin).status_code == 200
    pending = _binding(client, admin, account_id)
    assert pending["recoveryStatus"] == "pending"
    upstream.status = 200
    assert client.post(endpoint, headers=admin).status_code == 200
    after = _binding(client, admin, account_id)
    assert after["sessionStatus"] == "expired"
    assert after["recoveryStatus"] == "pending"
    assert after["nextRecoveryAt"] == pending["nextRecoveryAt"]


def test_worker_disabled_reports_unavailability_only_when_password_login_is_needed(
    managed_account: Any, api: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services.managed_platforms import ManagedLoginResult
    from app.services.managed_recovery import run_recovery

    client, admin, user, platform_id, account_id, upstream = managed_account
    _client, module = api
    account_endpoint = f"/api/admin/managed-platform-accounts/{account_id}"
    bootstrap_endpoint = f"/api/user/managed-platforms/{platform_id}/bootstrap"
    bootstrap_request = {"managedAccountId": account_id, "deviceId": "test-device"}
    # Cookie mode remains usable while the password recovery worker is disabled.
    assert client.post(bootstrap_endpoint, headers=user, json=bootstrap_request).status_code == 200
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "1")
    changed = client.patch(account_endpoint, headers=admin, json={
        "authMode": "server_login", "username": "test-email", "password": "test-password",
    })
    assert changed.status_code == 200, changed.text
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "0")
    pending = client.post(bootstrap_endpoint, headers=user, json=bootstrap_request)
    assert pending.status_code == 503, pending.text
    assert "自动恢复服务未启用" in pending.json()["msg"]

    class Provider:
        def verify(self, **kwargs: Any) -> ManagedLoginResult:
            return ManagedLoginResult("verified", [_cookie("recovered")], remote_account_id="test-remote-user")

    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "1")
    assert run_recovery(module.db, account_id, provider=Provider()) is True
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "0")
    active = client.post(bootstrap_endpoint, headers=user, json=bootstrap_request)
    assert active.status_code == 200, active.text
    upstream.status = 401
    checked = client.post(f"{account_endpoint}/identity-check", headers=admin)
    assert checked.status_code == 200, checked.text
    row = _binding(client, admin, account_id)
    assert row["autoRelogin"] is True
    assert row["sessionStatus"] == "expired"
    assert row["recoveryStatus"] == "pending"
    blocked = client.post(bootstrap_endpoint, headers=user, json=bootstrap_request)
    assert blocked.status_code == 503, blocked.text


def test_bootstrap_probe_records_expiry_for_an_unverified_saved_cookie(managed_account: Any) -> None:
    client, admin, user, platform_id, account_id, upstream = managed_account
    user_id = _binding(client, admin, account_id)["userId"]
    upstream.error = urllib.error.URLError(TimeoutError("test timeout"))
    saved = client.patch(f"/api/admin/users/{user_id}/managed-accounts/{account_id}", headers=admin, json={
        "cookieBundle": [_cookie("not-yet-verified")],
    })
    assert saved.status_code == 200, saved.text
    upstream.error = None
    upstream.status = 401
    bootstrap = client.post(f"/api/user/managed-platforms/{platform_id}/bootstrap", headers=user, json={
        "managedAccountId": account_id, "deviceId": "test-device",
    })
    assert bootstrap.status_code == 409
    row = _binding(client, admin, account_id)
    assert row["sessionStatus"] == "expired"
    assert row["lastIdentityCheckState"] == "invalid"
