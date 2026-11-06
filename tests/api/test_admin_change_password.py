from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi import Depends, Request

from tests.envelope import payload

ENDPOINT = "/api/admin/auth/change-password"
USERNAME = "test-admin"
OLD_PASSWORD = "test-admin-password"
NEW_PASSWORD = "new-super-admin-password"


def _login(client: Any, password: str = OLD_PASSWORD, username: str = USERNAME) -> str:
    response = client.post("/api/admin/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return payload(response)["accessToken"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_super_admin_changes_own_password_and_invalidates_all_old_sessions(api: Any) -> None:
    client, _module = api
    first_token = _login(client)
    second_token = _login(client)
    old_cookie = client.cookies.get("vestus_admin_session")
    changed = client.post(ENDPOINT, headers=_bearer(first_token), json={
        "currentPassword": OLD_PASSWORD, "newPassword": NEW_PASSWORD,
    })
    assert changed.status_code == 200, changed.text
    assert payload(changed) is None
    assert 'Max-Age=0' in changed.headers.get("set-cookie", "")
    assert client.cookies.get("vestus_admin_session") is None
    for token in (first_token, second_token):
        assert client.get("/api/admin/auth/me", headers=_bearer(token)).status_code == 401
    assert client.get("/api/admin/auth/me", headers={
        "Cookie": f"vestus_admin_session={old_cookie}",
    }).status_code == 401
    old_login = client.post("/api/admin/auth/login", json={"username": USERNAME, "password": OLD_PASSWORD})
    assert old_login.status_code == 401
    new_token = _login(client, NEW_PASSWORD)
    assert client.get("/api/admin/auth/me", headers=_bearer(new_token)).status_code == 200


@pytest.mark.parametrize(
    ("current_password", "new_password", "detail"),
    [("incorrect-current-password", NEW_PASSWORD, "当前密码错误"),
     (OLD_PASSWORD, OLD_PASSWORD, "新密码不能与当前密码相同")],
)
def test_rejected_change_preserves_session_and_records_failed_audit(
    api: Any, current_password: str, new_password: str, detail: str,
) -> None:
    client, _module = api
    token = _login(client)
    response = client.post(ENDPOINT, headers=_bearer(token), json={
        "currentPassword": current_password, "newPassword": new_password,
    })
    assert response.status_code == 400, response.text
    assert response.json()["msg"] == detail
    assert "set-cookie" not in response.headers
    assert client.get("/api/admin/auth/me", headers=_bearer(token)).status_code == 200
    _login(client)
    logs = payload(client.get("/api/admin/user-logs", headers=_bearer(token), params={"pageSize": 100}))
    changes = [item for item in logs["items"] if item["action"] == "CHANGE_PASSWORD"]
    assert len(changes) == 1
    assert changes[0]["status"] == "FAILED"
    assert changes[0]["actorType"] == "admin"
    assert changes[0]["targetType"] == "admin"
    for secret in (current_password, new_password):
        assert secret not in str(changes)


@pytest.mark.parametrize("new_password", ["", "short", "x" * 257])
def test_invalid_password_length_does_not_change_credentials(api: Any, new_password: str) -> None:
    client, _module = api
    token = _login(client)
    response = client.post(ENDPOINT, headers=_bearer(token), json={
        "currentPassword": OLD_PASSWORD, "newPassword": new_password,
    })
    assert response.status_code == 422
    assert client.get("/api/admin/auth/me", headers=_bearer(token)).status_code == 200
    _login(client)


@pytest.mark.parametrize("extra", [{"adminId": 2}, {"confirmPassword": NEW_PASSWORD}])
def test_change_password_rejects_extra_fields(api: Any, extra: dict[str, Any]) -> None:
    client, _module = api
    token = _login(client)
    response = client.post(ENDPOINT, headers=_bearer(token), json={
        "currentPassword": OLD_PASSWORD, "newPassword": NEW_PASSWORD, **extra,
    })
    assert response.status_code == 422
    assert client.get("/api/admin/auth/me", headers=_bearer(token)).status_code == 200


@pytest.mark.parametrize("origin", [None, "http://attacker.testserver", "http://testserver"])
def test_cookie_change_requires_same_origin(api: Any, origin: str | None) -> None:
    client, _module = api
    _login(client)
    response = client.post(ENDPOINT, headers={"Origin": origin} if origin else {}, json={
        "currentPassword": OLD_PASSWORD, "newPassword": NEW_PASSWORD,
    })
    assert response.status_code == (200 if origin == "http://testserver" else 403), response.text
    if origin == "http://testserver":
        assert client.cookies.get("vestus_admin_session") is None
        _login(client, NEW_PASSWORD)
    else:
        assert client.get("/api/admin/auth/me").status_code == 200
        _login(client)


def test_self_change_is_super_admin_only_and_does_not_modify_desktop_user(api: Any) -> None:
    client, _module = api
    credentials = {"currentPassword": OLD_PASSWORD, "newPassword": NEW_PASSWORD}
    assert client.post(ENDPOINT, json=credentials).status_code == 401
    super_token = _login(client)
    created = client.post("/api/admin/admins", headers=_bearer(super_token), json={
        "username": "other-admin", "password": OLD_PASSWORD, "name": "普通管理员", "role": "admin",
    })
    assert created.status_code == 201, created.text
    other_token = _login(client, username="other-admin")
    assert client.post(ENDPOINT, headers=_bearer(other_token), json=credentials).status_code == 403
    created_user = client.post("/api/admin/users", headers=_bearer(super_token), json={
        "username": "desktop-user", "password": OLD_PASSWORD, "name": "桌面用户", "expiresAt": "2099-12-31",
    })
    assert created_user.status_code == 201, created_user.text
    user_login = client.post("/api/user/auth/login", json={"username": "desktop-user", "password": OLD_PASSWORD})
    assert user_login.status_code == 200
    user_token = payload(user_login)["accessToken"]
    assert client.post(ENDPOINT, headers=_bearer(user_token), json=credentials).status_code == 403
    changed = client.post(ENDPOINT, headers=_bearer(super_token), json=credentials)
    assert changed.status_code == 200, changed.text
    assert client.get("/api/user/auth/me", headers=_bearer(user_token)).status_code == 200
    assert client.get("/api/admin/auth/me", headers=_bearer(other_token)).status_code == 200
    _login(client, username="other-admin")
    new_token = _login(client, NEW_PASSWORD)
    logs = payload(client.get("/api/admin/user-logs", headers=_bearer(new_token), params={"pageSize": 100}))
    changes = [item for item in logs["items"] if item["action"] == "CHANGE_PASSWORD"]
    assert len(changes) == 1
    assert changes[0]["status"] == "SUCCESS"
    assert changes[0]["actorType"] == "admin"
    assert changes[0]["targetId"] == changes[0]["actorId"]
    assert OLD_PASSWORD not in str(changes)
    assert NEW_PASSWORD not in str(changes)


@pytest.mark.parametrize("change", ["demote", "disable", "logout"])
def test_account_changes_after_authentication_cannot_use_stale_permission(
    api: Any, monkeypatch: pytest.MonkeyPatch, change: str,
) -> None:
    from app.api.deps import current_account, super_admin_auth

    client, module = api
    token = _login(client)
    account_id = payload(client.get("/api/admin/auth/me", headers=_bearer(token)))["id"]
    created = client.post("/api/admin/admins", headers=_bearer(token), json={
        "username": "another-super", "password": "another-password", "name": "另一超级管理员", "role": "super_admin",
    })
    assert created.status_code == 201, created.text
    other_token = _login(client, "another-password", "another-super")

    async def interleaved_auth(request: Request, auth: Any = Depends(current_account)) -> Any:
        authenticated = await super_admin_auth(auth)
        if request.url.path == ENDPOINT:
            if change == "logout":
                response = await asyncio.to_thread(client.post, "/api/admin/auth/logout", headers=_bearer(token))
            else:
                response = await asyncio.to_thread(
                    client.patch, f"/api/admin/admins/{account_id}", headers=_bearer(other_token),
                    json={"role": "admin"} if change == "demote" else {"status": "disabled"},
                )
            assert response.status_code == 200, response.text
        return authenticated

    monkeypatch.setitem(module.app.dependency_overrides, super_admin_auth, interleaved_auth)
    response = client.post(ENDPOINT, headers=_bearer(token), json={
        "currentPassword": OLD_PASSWORD, "newPassword": NEW_PASSWORD,
    })
    assert response.status_code == 401, response.text
    if change != "logout":
        restored = client.patch(f"/api/admin/admins/{account_id}", headers=_bearer(other_token), json={
            "role": "super_admin", "status": "active",
        })
        assert restored.status_code == 200, restored.text
    _login(client)
    assert client.post("/api/admin/auth/login", json={"username": USERNAME, "password": NEW_PASSWORD}).status_code == 401
