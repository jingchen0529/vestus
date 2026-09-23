"""Device identifiers: collection, normalization and backward compatibility.

The desktop client reads the machine identifier its operating system exposes and
sends it on login and with every activity batch.  Three properties matter:

* a login or upload **without** the field still works -- desktop builds already
  in the field do not send it, and the activity schema is ``extra="forbid"`` so
  the field had to be declared rather than tolerated;
* whatever is stored is normalized to one canonical form (the three platforms
  disagree on case, hyphens and braces), because the whole point is comparing
  "same machine" later;
* a malformed value is dropped, never rejected: a machine whose identifier
  cannot be read must still be able to log in.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import inspect

from app.core.device import MAX_DEVICE_ID_LENGTH, normalize_device_id
from tests.envelope import items, payload

#: macOS 报大写 UUID，Windows 报小写十六进制（工具链还常带大括号），
#: Linux 报 32 位小写十六进制。归一化只统一大小写、去掉大括号与空白——同一台
#: 机器永远只报它自己平台那一种格式，不需要把 UUID 的横线也抹掉。
MAC_UUID = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"
MAC_NORMALIZED = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
WINDOWS_GUID = "{a1b2c3d4e5f67890abcdef1234567890}"
LINUX_MACHINE_ID = "a1b2c3d4e5f67890abcdef1234567890"
OTHER_MACHINE_ID = "ffffffffffffffffffffffffffffffff"


def _login(client: Any, path: str, username: str, password: str, **extra: Any) -> str:
    response = client.post(
        path, json={"username": username, "password": password, **extra}
    )
    assert response.status_code == 200, response.text
    return payload(response)["accessToken"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: Any, admin_token: str, username: str) -> dict[str, Any]:
    response = client.post(
        "/api/admin/users",
        headers=_bearer(admin_token),
        json={
            "username": username,
            "password": f"{username}-password",
            "name": username,
            "expiresAt": "2099-12-31",
        },
    )
    assert response.status_code == 201, response.text
    return payload(response)


def _find_user(client: Any, admin_token: str, username: str) -> dict[str, Any]:
    return next(
        entry
        for entry in items(client.get("/api/admin/users", headers=_bearer(admin_token)))
        if entry["username"] == username
    )


def _report(client: Any, username: str, *, session_key: str, **extra: Any) -> None:
    token = _login(client, "/api/user/auth/login", username, f"{username}-password")
    body = {
        "sessionKey": session_key,
        "browserId": 1,
        "platformId": 0,
        "directMode": False,
        "reportedAtMs": 1_700_000_001_000,
        "droppedPages": 0,
        "pages": [
            {
                "url": "https://tracked.example.test/page",
                "visits": 1,
                "clicks": 0,
                "inputs": 0,
                "submits": 0,
                "scrolls": 0,
                "dwellMs": 0,
                "firstSeenAtMs": 1_700_000_000_000,
                "lastSeenAtMs": 1_700_000_000_500,
            }
        ],
    }
    body.update(extra)
    response = client.post("/api/user/browser-activity", headers=_bearer(token), json=body)
    assert response.status_code == 200, response.text


def test_normalization_folds_the_three_platform_formats() -> None:
    assert normalize_device_id(MAC_UUID) == MAC_NORMALIZED
    assert normalize_device_id(f"  {WINDOWS_GUID}  ") == LINUX_MACHINE_ID
    assert normalize_device_id(f"{LINUX_MACHINE_ID}\n") == LINUX_MACHINE_ID
    # Values that cannot be trusted are dropped, never repaired.
    assert normalize_device_id(None) is None
    assert normalize_device_id("") is None
    assert normalize_device_id("   ") is None
    assert normalize_device_id("{}") is None
    assert normalize_device_id("--------") is None
    assert normalize_device_id("my-laptop.local") is None
    assert normalize_device_id("未知设备") is None
    assert normalize_device_id(12345) is None
    assert normalize_device_id("a" * (MAX_DEVICE_ID_LENGTH + 1)) is None


def test_login_records_the_canonical_device_id(api: Any) -> None:
    client, module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    user = _create_user(client, admin_token, "device-login-user")

    _login(
        client,
        "/api/user/auth/login",
        "device-login-user",
        "device-login-user-password",
        deviceId=MAC_UUID,
    )
    listed = _find_user(client, admin_token, "device-login-user")
    assert listed["lastDeviceId"] == MAC_NORMALIZED

    # A second machine takes over the "last seen" slot.
    _login(
        client,
        "/api/user/auth/login",
        "device-login-user",
        "device-login-user-password",
        deviceId=OTHER_MACHINE_ID,
    )
    assert _find_user(client, admin_token, "device-login-user")["lastDeviceId"] == OTHER_MACHINE_ID

    with module.db.session() as session:
        stored = session.get(module.User, user["id"])
        assert stored is not None and stored.last_device_id == OTHER_MACHINE_ID


def test_login_without_or_with_broken_device_id_still_works(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    _create_user(client, admin_token, "no-device-user")

    # Exactly what a desktop build already in the field sends.
    _login(client, "/api/user/auth/login", "no-device-user", "no-device-user-password")
    assert _find_user(client, admin_token, "no-device-user")["lastDeviceId"] is None

    # A value the collector cannot vouch for is dropped, and the login succeeds:
    # collecting a device id must never be the reason a login fails.
    _login(
        client,
        "/api/user/auth/login",
        "no-device-user",
        "no-device-user-password",
        deviceId="my-laptop.local",
    )
    assert _find_user(client, admin_token, "no-device-user")["lastDeviceId"] is None

    # And a login without one never erases what an earlier login stored.
    _login(
        client,
        "/api/user/auth/login",
        "no-device-user",
        "no-device-user-password",
        deviceId=LINUX_MACHINE_ID,
    )
    _login(client, "/api/user/auth/login", "no-device-user", "no-device-user-password")
    assert _find_user(client, admin_token, "no-device-user")["lastDeviceId"] == LINUX_MACHINE_ID


def test_activity_report_carries_the_device_id(api: Any) -> None:
    client, module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    _create_user(client, admin_token, "device-session-user")

    _report(
        client,
        "device-session-user",
        session_key="0000018f2c4a1b3d0000123400000c01",
        deviceId=WINDOWS_GUID,
    )
    sessions = payload(
        client.get("/api/admin/browser-sessions", headers=_bearer(admin_token))
    )["items"]
    mine = next(item for item in sessions if item["username"] == "device-session-user")
    assert mine["deviceId"] == LINUX_MACHINE_ID

    columns = {
        column["name"] for column in inspect(module.db.engine).get_columns("browser_session")
    }
    assert "device_id" in columns

    # A later batch fills a blank in, but never re-labels an existing session.
    _report(
        client,
        "device-session-user",
        session_key="0000018f2c4a1b3d0000123400000c02",
    )
    _report(
        client,
        "device-session-user",
        session_key="0000018f2c4a1b3d0000123400000c02",
        deviceId=OTHER_MACHINE_ID,
    )
    sessions = payload(
        client.get("/api/admin/browser-sessions", headers=_bearer(admin_token))
    )["items"]
    by_key = {item["sessionKey"]: item for item in sessions}
    assert by_key["0000018f2c4a1b3d0000123400000c01"]["deviceId"] == LINUX_MACHINE_ID
    assert by_key["0000018f2c4a1b3d0000123400000c02"]["deviceId"] == OTHER_MACHINE_ID

    # Uploading without the field stays accepted (old client), session included.
    _report(client, "device-session-user", session_key="0000018f2c4a1b3d0000123400000c03")
    sessions = payload(
        client.get("/api/admin/browser-sessions", headers=_bearer(admin_token))
    )["items"]
    old_style = next(
        item for item in sessions if item["sessionKey"] == "0000018f2c4a1b3d0000123400000c03"
    )
    assert old_style["deviceId"] is None


def test_login_audit_row_keeps_the_device_id(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    _create_user(client, admin_token, "device-audit-user")
    _login(
        client,
        "/api/user/auth/login",
        "device-audit-user",
        "device-audit-user-password",
        deviceId=MAC_UUID,
    )

    logs = payload(
        client.get(
            "/api/admin/user-logs",
            headers=_bearer(admin_token),
            params={"action": "LOGIN", "pageSize": 50},
        )
    )["items"]
    row = next(
        entry
        for entry in logs
        if entry["actorUsername"] == "device-audit-user" and entry["status"] == "SUCCESS"
    )
    assert row["details"] == {"deviceId": MAC_NORMALIZED}
