from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import inspect, select

from tests.envelope import items, payload


def _login(client: Any, path: str, username: str, password: str) -> tuple[str, dict[str, Any]]:
    response = client.post(path, json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    grant = payload(response)
    return grant["accessToken"], grant


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_public_network_ip_uses_the_asgi_validated_peer_and_ignores_raw_forwarding_headers(
    api: Any,
    monkeypatch: Any,
) -> None:
    client, _module = api
    monkeypatch.setenv("VESTUS_TRUST_PROXY", "1")

    response = client.get(
        "/api/network/ip",
        headers={"X-Forwarded-For": "203.0.113.99, 10.0.0.8"},
    )

    assert response.status_code == 200
    assert payload(response) == {"ip": "198.51.100.27"}
    assert response.headers["cache-control"] == "no-store"


def test_public_network_ip_errors_are_not_cached(api: Any) -> None:
    _client, module = api

    with TestClient(module.app, client=("not-an-ip", 50000)) as invalid_client:
        response = invalid_client.get("/api/network/ip")

    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"


def test_public_product_name_is_available_before_desktop_login(api: Any, monkeypatch: Any) -> None:
    client, _module = api
    monkeypatch.setenv("VESTUS_PRODUCT_NAME", "专属代理客户端")

    response = client.get("/api/product")

    assert response.status_code == 200
    assert payload(response)["productName"] == "专属代理客户端"
    assert "logoUrl" in payload(response)
    assert response.headers["cache-control"] == "no-store"


def test_admin_page_csp_does_not_allow_data_images(api: Any) -> None:
    client, _module = api

    response = client.get("/admin")

    assert response.status_code == 200, response.text
    csp = response.headers["content-security-policy"]
    assert "img-src 'self'" in csp
    assert "img-src 'self' data:" not in csp


def _create_user(client: Any, admin_token: str, username: str = "desktop-user", password: str = "user-password") -> dict[str, Any]:
    response = client.post(
        "/api/admin/users",
        headers=_bearer(admin_token),
        json={
            "username": username,
            "password": password,
            "name": "Desktop User",
            "company": "Test Co",
            "expiresAt": "2099-12-31",
            "maxSessions": 2,
        },
    )
    assert response.status_code == 201, response.text
    return payload(response)


def test_three_tables_and_auth_boundaries(api: Any) -> None:
    client, module = api
    table_names = set(inspect(module.db.engine).get_table_names())
    assert {"admin", "user", "user_log"}.issubset(table_names)
    assert "sessions" not in table_names

    assert client.get("/api/user/auth/me").status_code == 401
    assert client.get("/api/admin/users").status_code == 401

    admin_token, admin_payload = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    assert admin_payload["admin"]["role"] == "super_admin"
    user = _create_user(client, admin_token)
    user_token, user_payload = _login(client, "/api/user/auth/login", "desktop-user", "user-password")
    assert user_payload["user"]["id"] == user["id"]

    # Account types are intentionally isolated at the dependency layer.
    assert client.get("/api/admin/users", headers=_bearer(user_token)).status_code == 403
    assert client.get("/api/user/auth/me", headers=_bearer(admin_token)).status_code == 403


def test_admin_web_only_uses_the_admin_login_endpoint(api: Any) -> None:
    client, _module = api

    response = client.get("/admin")
    assert response.status_code == 200
    assert "/api/admin/auth/login" in response.text
    assert "/api/user/auth/login" not in response.text
    assert "sessionStorage" not in response.text
    assert "headers.Authorization" not in response.text
    assert response.headers["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "no-store"


def test_admin_and_desktop_auth_surfaces_are_role_isolated(api: Any) -> None:
    client, _module = api
    admin_token, _ = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    _create_user(client, admin_token, "role-user", "role-user-password")
    user_token, _ = _login(client, "/api/user/auth/login", "role-user", "role-user-password")

    assert client.post(
        "/api/user/auth/login",
        json={"username": "test-admin", "password": "test-admin-password"},
    ).status_code == 401
    assert client.post(
        "/api/admin/auth/login",
        json={"username": "role-user", "password": "role-user-password"},
    ).status_code == 401

    for path in ("/api/user/auth/me", "/api/client/resource"):
        assert client.get(path, headers=_bearer(admin_token)).status_code == 403
    for path in ("/api/admin/auth/me", "/api/admin/users"):
        assert client.get(path, headers=_bearer(user_token)).status_code == 403


def test_admin_can_manage_user_and_old_token_is_invalidated(api: Any) -> None:
    client, _module = api
    admin_token, _ = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    user = _create_user(client, admin_token, "managed-user", "initial-password")
    user_id = user["id"]
    old_token, _ = _login(client, "/api/user/auth/login", "managed-user", "initial-password")

    disabled = client.post(f"/api/admin/users/{user_id}/disable", headers=_bearer(admin_token))
    assert disabled.status_code == 200
    assert payload(disabled)["status"] == "disabled"
    assert client.get("/api/user/auth/me", headers=_bearer(old_token)).status_code == 401
    assert client.post("/api/user/auth/login", json={"username": "managed-user", "password": "initial-password"}).status_code == 403

    enabled = client.post(f"/api/admin/users/{user_id}/enable", headers=_bearer(admin_token))
    assert enabled.status_code == 200
    reset = client.post(
        f"/api/admin/users/{user_id}/reset-password",
        headers=_bearer(admin_token),
        json={"password": "replacement-password"},
    )
    assert reset.status_code == 200
    assert client.post("/api/user/auth/login", json={"username": "managed-user", "password": "initial-password"}).status_code == 401
    replacement_login = client.post(
        "/api/user/auth/login",
        json={"username": "managed-user", "password": "replacement-password"},
    )
    assert replacement_login.status_code == 200
    assert payload(replacement_login)["user"]["mustChangePassword"] is False
    valid_token = payload(replacement_login)["accessToken"]
    # 用户可直接读取配置而无需强制先修改密码
    desktop_cfg = client.get(
        "/api/user/desktop-config", headers=_bearer(valid_token)
    )
    assert desktop_cfg.status_code in (200, 404)

    changed = client.post(
        "/api/user/auth/change-password",
        headers=_bearer(valid_token),
        json={
            "currentPassword": "replacement-password",
            "newPassword": "final-password",
        },
    )
    assert changed.status_code == 200
    assert client.get(
        "/api/user/auth/me", headers=_bearer(valid_token)
    ).status_code == 401
    final_login = client.post(
        "/api/user/auth/login",
        json={"username": "managed-user", "password": "final-password"},
    )
    assert final_login.status_code == 200
    assert payload(final_login)["user"]["mustChangePassword"] is False


def test_expired_user_and_manual_token_version_invalidation(api: Any) -> None:
    client, module = api
    admin_token, _ = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    user = _create_user(client, admin_token, "expiring-user", "expiry-password")
    user_token, _ = _login(client, "/api/user/auth/login", "expiring-user", "expiry-password")
    user_id = int(user["id"])

    # An expired account is rejected both for new login and existing requests.
    # Mutate only the expiry column so the existing token keeps its original
    # token_version; this isolates expiry enforcement from revocation logic.
    with module.db.session() as session:
        model = session.get(module.User, user_id)
        assert model is not None
        model.expires_at = datetime.combine(date.today() - timedelta(days=1), datetime.min.time())
    assert client.post("/api/user/auth/login", json={"username": "expiring-user", "password": "expiry-password"}).status_code == 403
    assert client.get("/api/user/auth/me", headers=_bearer(user_token)).status_code == 403

    # Restore status/expiry, then bump token_version directly to model a
    # password reset or forced logout performed by another process.
    with module.db.session() as session:
        model = session.get(module.User, user_id)
        assert model is not None
        model.expires_at = datetime.combine(date(2099, 12, 31), datetime.max.time())
        model.token_version += 1
    assert client.get("/api/user/auth/me", headers=_bearer(user_token)).status_code == 401


def test_logs_written_for_login_and_management_actions(api: Any) -> None:
    client, module = api
    admin_token, _ = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    user = _create_user(client, admin_token, "logged-user", "logged-password")
    _login(client, "/api/user/auth/login", "logged-user", "logged-password")
    client.post(f"/api/admin/users/{user['id']}/disable", headers=_bearer(admin_token))

    response = client.get("/api/admin/user-logs?page=1&pageSize=100", headers=_bearer(admin_token))
    assert response.status_code == 200, response.text
    actions = {row["action"] for row in items(response)}
    assert {"LOGIN", "USER_CREATE", "USER_DISABLE"}.issubset(actions)

    with module.db.session() as session:
        rows = session.scalars(select(module.UserLog)).all()
        assert rows
        assert all(row.summary for row in rows)
        assert all(row.status in {"SUCCESS", "FAILED"} for row in rows)


def test_admin_branding_keeps_upload_paths_and_public_product_uses_current_origin(api: Any) -> None:
    client, _module = api
    admin_token, _ = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    headers = _bearer(admin_token)
    product_logo = payload(
        client.post(
            "/api/admin/uploads",
            headers=headers,
            files={"file": ("product.png", b"product-logo", "image/png")},
        )
    )["path"]
    admin_logo = payload(
        client.post(
            "/api/admin/uploads",
            headers=headers,
            files={"file": ("admin.ico", b"admin-logo", "image/x-icon")},
        )
    )["path"]

    update_res = client.put(
        "/api/admin/settings",
        headers=headers,
        json={
            "productName": "企业智选浏览器",
            "logoUrl": product_logo,
            "adminLogoUrl": admin_logo,
        },
    )
    assert update_res.status_code == 200
    assert payload(update_res)["productName"] == "企业智选浏览器"
    assert payload(update_res)["logoUrl"] == product_logo
    assert payload(update_res)["adminLogoUrl"] == admin_logo
    admin_res = client.get("/api/admin/settings", headers=headers)
    assert payload(admin_res)["logoUrl"] == product_logo
    assert payload(admin_res)["adminLogoUrl"] == admin_logo

    public_res = client.get("/api/product", headers={"Host": "product.example.test"})
    assert public_res.status_code == 200
    assert payload(public_res)["productName"] == "企业智选浏览器"
    assert payload(public_res)["logoUrl"] == f"http://product.example.test{product_logo}"


def test_branding_api_rejects_unmanaged_and_unsafe_image_references(api: Any) -> None:
    client, _module = api
    admin_token, _ = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    headers = _bearer(admin_token)
    unsafe_upload = payload(
        client.post(
            "/api/admin/uploads",
            headers=headers,
            files={"file": ("looks-like-image.png", b"<script>bad</script>", "text/html")},
        )
    )["path"]
    missing_upload = f"/uploads/2026/08/{'f' * 32}.png"

    for reference in (
        "https://cdn.example.test/logo.png",
        "data:image/png;base64,AAAA",
        "/uploads/2026/08/not-generated.png",
        missing_upload,
        unsafe_upload,
    ):
        response = client.put(
            "/api/admin/settings",
            headers=headers,
            json={"logoUrl": reference},
        )
        assert response.status_code in {400, 422}, (reference, response.text)

    settings = payload(client.get("/api/admin/settings", headers=headers))
    assert settings["logoUrl"] == ""


def test_settings_reject_unknown_theme_color(api: Any) -> None:
    client, _module = api
    admin_token, _ = _login(
        client, "/api/admin/auth/login", "test-admin", "test-admin-password"
    )

    response = client.put(
        "/api/admin/settings",
        headers=_bearer(admin_token),
        json={"adminThemeColor": "url(javascript:invalid)"},
    )

    assert response.status_code == 422, response.text


def test_reset_admin_password_succeeds_with_an_empty_payload(api: Any) -> None:
    client, _module = api
    super_admin_token, _ = _login(
        client, "/api/admin/auth/login", "test-admin", "test-admin-password"
    )
    created = client.post(
        "/api/admin/admins",
        headers=_bearer(super_admin_token),
        json={
            "username": "password-reset-admin",
            "password": "initial-admin-password",
            "name": "Password Reset Admin",
            "role": "admin",
            "status": "active",
        },
    )
    assert created.status_code == 201, created.text

    response = client.post(
        f"/api/admin/admins/{payload(created)['id']}/reset-password",
        headers=_bearer(super_admin_token),
        json={"password": "replacement-admin-password"},
    )

    assert response.status_code == 200, response.text
    # ``code == 0`` is the whole answer; there is nothing to report back.
    assert payload(response) is None
