"""Password character set: the web console must match what desktop accepts.

The desktop client only lets a user type visible ASCII into its password field
(0x21-0x7E). A password the web console sets with Chinese, a space or a
full-width character can therefore never be entered on the desktop, so the same
rule is enforced here for every path that *sets* a password.
"""
from __future__ import annotations

from typing import Any

import pytest

from tests.envelope import payload

NON_ASCII_PASSWORDS = [
    "中文密码123",
    "密码abcdef",
    "pass word",
    "pass\u3000word",
    "pass😀word",
    "ｐａｓｓword",
    "Passw0rd！",
]


def _login(client: Any, path: str, username: str, password: str) -> dict[str, str]:
    response = client.post(path, json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {payload(response)['accessToken']}"}


@pytest.fixture()
def admin(api: Any) -> tuple[Any, dict[str, str]]:
    client, _module = api
    return client, _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")


def _create(client: Any, headers: dict[str, str], username: str, password: str) -> Any:
    return client.post("/api/admin/users", headers=headers, json={
        "username": username, "password": password, "name": "字符集测试", "expiresAt": "2099-12-31",
    })


@pytest.mark.parametrize("password", NON_ASCII_PASSWORDS)
def test_creating_a_desktop_user_refuses_a_password_the_desktop_cannot_type(
    admin: tuple[Any, dict[str, str]], password: str,
) -> None:
    client, headers = admin
    response = _create(client, headers, "charset-user", password)
    assert response.status_code == 422, response.text
    assert "可见 ASCII" in response.text
    assert payload(client.get("/api/admin/users", headers=headers))["items"] == []


def test_creating_a_desktop_user_accepts_the_full_visible_ascii_set(
    admin: tuple[Any, dict[str, str]],
) -> None:
    client, headers = admin
    password = "Passw0rd!@#$%^&*()_+-=[]{};:'\",.<>/?\\|`~"
    created = _create(client, headers, "ascii-user", password)
    assert created.status_code == 201, created.text
    assert _login(client, "/api/user/auth/login", "ascii-user", password)


@pytest.mark.parametrize("password", NON_ASCII_PASSWORDS)
def test_resetting_a_desktop_user_password_uses_the_same_rule(
    admin: tuple[Any, dict[str, str]], password: str,
) -> None:
    client, headers = admin
    created = _create(client, headers, "reset-charset-user", "initial-password")
    assert created.status_code == 201, created.text
    user_id = payload(created)["id"]
    response = client.post(f"/api/admin/users/{user_id}/reset-password", headers=headers, json={"password": password})
    assert response.status_code == 422, response.text
    assert _login(client, "/api/user/auth/login", "reset-charset-user", "initial-password")


@pytest.mark.parametrize("password", NON_ASCII_PASSWORDS)
def test_change_password_refuses_a_chinese_or_spaced_new_password(
    admin: tuple[Any, dict[str, str]], password: str,
) -> None:
    client, headers = admin
    created = _create(client, headers, "change-charset-user", "initial-password")
    assert created.status_code == 201, created.text
    user = _login(client, "/api/user/auth/login", "change-charset-user", "initial-password")
    response = client.post("/api/user/auth/change-password", headers=user, json={
        "currentPassword": "initial-password", "newPassword": password,
    })
    assert response.status_code == 422, response.text
    assert _login(client, "/api/user/auth/login", "change-charset-user", "initial-password")


def test_system_administrator_password_rule_is_not_changed(admin: tuple[Any, dict[str, str]]) -> None:
    client, headers = admin
    password = "管理员密码123"
    created = client.post("/api/admin/admins", headers=headers, json={
        "username": "charset-admin", "password": password, "name": "字符集管理员",
    })
    assert created.status_code == 201, created.text
    assert _login(client, "/api/admin/auth/login", "charset-admin", password)


@pytest.mark.parametrize("username", ["张三", "client中文01", "client 01", "ｃｌｉｅｎｔ", "client😀", "client/01"])
def test_desktop_account_rejects_characters_missing_from_desktop_whitelist(
    admin: tuple[Any, dict[str, str]], username: str,
) -> None:
    client, headers = admin
    response = _create(client, headers, username, "password-123")
    assert response.status_code == 422, response.text
    assert payload(client.get("/api/admin/users", headers=headers))["items"] == []


def test_desktop_account_accepts_supported_characters_and_display_name_stays_chinese(
    admin: tuple[Any, dict[str, str]],
) -> None:
    client, headers = admin
    created = _create(client, headers, "ops.user_01@corp-x", "password-123")
    assert created.status_code == 201, created.text
    assert payload(created)["name"] == "字符集测试"
    updated = client.patch(f"/api/admin/users/{payload(created)['id']}", headers=headers, json={"username": "中文账号"})
    assert updated.status_code == 422, updated.text
    assert _login(client, "/api/user/auth/login", "ops.user_01@corp-x", "password-123")


def test_historical_password_can_be_verified_and_replaced_without_normalization(admin: Any, api: Any) -> None:
    from app.core.security import hash_password
    from app.db.models import User

    client, headers = admin
    _client, module = api
    created = _create(client, headers, "legacy-user", "initial-password")
    assert created.status_code == 201
    old_password = " 旧密码 legacy "
    with module.db.session() as session:
        session.get(User, payload(created)["id"]).password_hash = hash_password(old_password)
    user = _login(client, "/api/user/auth/login", "legacy-user", old_password)
    changed = client.post("/api/user/auth/change-password", headers=user, json={
        "currentPassword": old_password, "newPassword": "Valid123!",
    })
    assert changed.status_code == 200, changed.text
    assert _login(client, "/api/user/auth/login", "legacy-user", "Valid123!")


@pytest.mark.parametrize("length", [6, 256])
def test_desktop_password_accepts_length_boundaries(admin: Any, length: int) -> None:
    client, headers = admin
    created = _create(client, headers, "boundary-user", "!" + "a" * (length - 2) + "~")
    assert created.status_code == 201, created.text
