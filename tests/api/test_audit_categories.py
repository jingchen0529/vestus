"""Audit categories through authenticated HTTP endpoints and login events."""

from __future__ import annotations

from typing import Any

from tests.envelope import payload


def _admin_headers(client: Any) -> dict[str, str]:
    response = client.post(
        "/api/admin/auth/login",
        json={"username": "test-admin", "password": "test-admin-password"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {payload(response)['accessToken']}"}


def test_log_category_query_filters_rows_counts_and_legacy_details(api: Any) -> None:
    client, _module = api
    headers = _admin_headers(client)
    created = client.post(
        "/api/admin/users",
        headers=headers,
        json={"username": "audit-client", "name": "审计测试用户", "password": "audit-password"},
    )
    assert created.status_code == 201, created.text

    result = client.get(
        "/api/admin/user-logs", headers=headers,
        params={"category": "admin_login", "pageSize": 1},
    )
    assert result.status_code == 200, result.text
    data = payload(result)
    assert data["total"] == 1
    assert data["pages"] == 1
    entry = data["items"][0]
    assert entry["action"] == "LOGIN"
    assert entry["actionLabel"] == "登录"
    assert entry["categoryLabel"] == "管理端登录"
    assert payload(client.get(f"/api/admin/user-logs/{entry['id']}", headers=headers)) == entry

    for path in ("/api/admin/audit-logs", "/api/admin/logs"):
        legacy = payload(client.get(path, headers=headers))
        assert next(item for item in legacy["items"] if item["id"] == entry["id"]) == entry

    empty = payload(client.get(
        "/api/admin/user-logs", headers=headers, params={"category": "desktop_login"},
    ))
    assert empty["total"] == 0
    invalid = client.get("/api/admin/user-logs", headers=headers, params={"category": "invalid"})
    assert invalid.status_code == 422


def test_failed_logins_keep_server_recorded_entry_source_without_inventing_an_actor(api: Any) -> None:
    client, _module = api
    headers = _admin_headers(client)
    attempts = [
        ("/api/admin/auth/login", "missing-admin", "admin", "admin_login"),
        ("/api/user/auth/login", "missing-desktop", "desktop", "desktop_login"),
        ("/api/auth/login", "missing-legacy", None, "unknown"),
    ]
    for path, username, _source, _category in attempts:
        response = client.post(path, json={
            "username": username, "password": "wrong-password", "authSource": "spoofed",
        })
        assert response.status_code == 401, response.text

    failed = payload(client.get("/api/admin/user-logs", headers=headers, params={"status": "FAILED"}))
    assert failed["total"] == 3
    for _path, username, source, category in attempts:
        entry = next(item for item in failed["items"] if item["summary"].startswith(username + ":"))
        assert entry["actorType"] == "system"
        assert entry["actorId"] is None
        assert entry["actorUsername"] is None
        assert entry["category"] == category
        assert (entry["details"] or {}).get("authSource") == source
        filtered = payload(client.get(
            "/api/admin/user-logs", headers=headers, params={"status": "FAILED", "category": category},
        ))
        assert [item["id"] for item in filtered["items"]] == [entry["id"]]


def test_recognized_account_login_audit_preserves_identity_and_device_metadata(api: Any) -> None:
    client, _module = api
    headers = _admin_headers(client)
    created = client.post(
        "/api/admin/users", headers=headers,
        json={"username": "audit-client", "password": "audit-password", "name": "审计测试用户"},
    )
    assert created.status_code == 201, created.text
    rejected = client.post(
        "/api/user/auth/login", json={"username": "audit-client", "password": "wrong-password"},
    )
    assert rejected.status_code == 401
    logged_in = client.post(
        "/api/user/auth/login",
        json={"username": "audit-client", "password": "audit-password", "deviceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"},
    )
    assert logged_in.status_code == 200, logged_in.text
    user_headers = {"Authorization": f"Bearer {payload(logged_in)['accessToken']}"}
    logged_out = client.post("/api/user/auth/logout", headers=user_headers)
    assert logged_out.status_code == 200, logged_out.text

    result = payload(client.get(
        "/api/admin/user-logs", headers=headers, params={"category": "desktop_login"},
    ))
    assert [(item["action"], item["status"]) for item in result["items"]] == [
        ("LOGOUT", "SUCCESS"), ("LOGIN", "SUCCESS"), ("LOGIN", "FAILED"),
    ]
    assert all(item["actorType"] == "user" for item in result["items"])
    assert all(item["actorId"] == payload(created)["id"] for item in result["items"])
    assert result["items"][1]["details"] == {"deviceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890", "authSource": "desktop"}
    assert result["items"][2]["details"] == {"authSource": "desktop"}
    admin_login = payload(client.get(
        "/api/admin/user-logs", headers=headers, params={"category": "admin_login"},
    ))["items"][0]
    assert admin_login["details"] == {"authSource": "admin"}
