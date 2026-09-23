"""Regressions for the hardening of per-user VPN and administrator binding.

Each test here pins down one hole found in review of the feature:

* audit logs leaked every tenant's usernames, IPs and session ids;
* a plain administrator could write the global proxy pool, including the
  ``is_default`` mark that decides every unassigned user's egress;
* a disabled node could keep the default mark, and the last-resort fallback was
  ordered by ``updated_at``, so editing any proxy moved unassigned users;
* a plain administrator could bind their accounts to someone else, or unbind
  them into a state where they kept working but vanished from every view;
* deleting an administrator left its users bound to a deleted row, which made
  them uneditable;
* the user list could not tell an assignment that had stopped working from one
  that still applied.
"""

from __future__ import annotations

from typing import Any

from tests.envelope import code, items, payload

SESSION_KEY = "0000018f2c4a1b3d00001234000000bb"


def _login(client: Any, path: str, username: str, password: str) -> str:
    response = client.post(path, json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return payload(response)["accessToken"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_admin(client: Any, admin_token: str, username: str) -> dict[str, Any]:
    response = client.post(
        "/api/admin/admins",
        headers=_bearer(admin_token),
        json={
            "username": username,
            "password": f"{username}-password",
            "name": username,
            "role": "admin",
        },
    )
    assert response.status_code == 201, response.text
    return payload(response)


def _create_user(client: Any, admin_token: str, username: str, **extra: Any) -> dict[str, Any]:
    body = {
        "username": username,
        "password": f"{username}-password",
        "name": username,
        "expiresAt": "2099-12-31",
    }
    body.update(extra)
    response = client.post("/api/admin/users", headers=_bearer(admin_token), json=body)
    assert response.status_code == 201, response.text
    return payload(response)


def _create_proxy(client: Any, admin_token: str, name: str, **extra: Any) -> dict[str, Any]:
    body = {
        "name": name,
        "host": f"{name}.example.test",
        "port": 3128,
        "username": f"{name}-user",
        "password": f"{name}-secret",
    }
    body.update(extra)
    response = client.post("/api/admin/proxies", headers=_bearer(admin_token), json=body)
    assert response.status_code == 201, response.text
    return payload(response)


def _desktop_config(client: Any, username: str) -> dict[str, Any]:
    token = _login(client, "/api/user/auth/login", username, f"{username}-password")
    response = client.get("/api/user/desktop-config", headers=_bearer(token))
    assert response.status_code == 200, response.text
    return payload(response)


def _report_activity(client: Any, username: str, session_key: str = SESSION_KEY) -> None:
    token = _login(client, "/api/user/auth/login", username, f"{username}-password")
    response = client.post(
        "/api/user/browser-activity",
        headers=_bearer(token),
        json={
            "sessionKey": session_key,
            "browserId": 1,
            "platformId": 0,
            "directMode": False,
            "reportedAtMs": 1_700_000_001_000,
            "droppedPages": 0,
            "pages": [
                {
                    "url": "https://tracked.example.test/page",
                    "urlParams": "advid=scope-check",
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
        },
    )
    assert response.status_code == 200, response.text


# --------------------------------------------------------------------------
# Audit logs are part of the scope
# --------------------------------------------------------------------------


def test_audit_logs_hide_other_tenants(api: Any) -> None:
    client, _module = api
    super_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    beijing = _create_admin(client, super_token, "log-beijing-admin")
    shanghai = _create_admin(client, super_token, "log-shanghai-admin")
    mine = _create_user(client, super_token, "log-mine", boundAdminId=beijing["id"])
    theirs = _create_user(client, super_token, "log-theirs", boundAdminId=shanghai["id"])

    # Activity from both tenants, plus another administrator's own actions.
    _report_activity(client, "log-mine", "0000018f2c4a1b3d0000123400000b01")
    _report_activity(client, "log-theirs", "0000018f2c4a1b3d0000123400000b02")
    shanghai_token = _login(
        client, "/api/admin/auth/login", "log-shanghai-admin", "log-shanghai-admin-password"
    )
    client.patch(
        f"/api/admin/users/{theirs['id']}",
        headers=_bearer(shanghai_token),
        json={"name": "renamed-theirs"},
    )

    headers = _bearer(
        _login(client, "/api/admin/auth/login", "log-beijing-admin", "log-beijing-admin-password")
    )
    logs = payload(client.get("/api/admin/user-logs", headers=headers, params={"pageSize": 200}))
    assert logs["total"] > 0
    # The invariant: every visible row is either this administrator's own doing
    # or aimed at one of their users.  A super admin's action on their user is
    # legitimately visible -- who did it is part of the record.
    for entry in logs["items"]:
        involves_me = entry["actorUsername"] in ("log-beijing-admin", "log-mine")
        aimed_at_mine = entry.get("targetName") == "log-mine"
        assert involves_me or aimed_at_mine, entry
    haystack = " ".join(
        f"{entry.get('actorUsername')} {entry.get('targetName')} {entry.get('summary')}"
        for entry in logs["items"]
    )
    assert "log-mine" in haystack
    for forbidden in ("log-theirs", "log-shanghai-admin"):
        assert forbidden not in haystack, forbidden

    # A user-side row that belongs to the other tenant is not addressable either.
    super_logs = payload(
        client.get("/api/admin/user-logs", headers=_bearer(super_token), params={"pageSize": 200})
    )
    foreign = next(
        entry
        for entry in super_logs["items"]
        if entry.get("targetName") == "log-theirs" or entry.get("actorUsername") == "log-shanghai-admin"
    )
    assert client.get(
        f"/api/admin/user-logs/{foreign['id']}", headers=headers
    ).status_code == 404
    assert client.get(
        f"/api/admin/user-logs/{foreign['id']}", headers=_bearer(super_token)
    ).status_code == 200

    # The legacy endpoints share the same scope.
    legacy = items(client.get("/api/admin/logs?limit=200", headers=headers))
    legacy_names = " ".join(
        f"{entry.get('actorUsername')} {entry.get('targetName')} {entry.get('summary')}"
        for entry in legacy
    )
    assert "log-theirs" not in legacy_names
    assert "log-shanghai-admin" not in legacy_names

    # A failed login for somebody else's account must not surface the name.
    client.post(
        "/api/user/auth/login",
        json={"username": "log-theirs", "password": "definitely-wrong"},
    )
    logs = payload(client.get("/api/admin/user-logs", headers=headers, params={"pageSize": 200}))
    assert "log-theirs" not in " ".join(
        f"{entry.get('actorUsername')} {entry.get('targetName')} {entry.get('summary')}"
        for entry in logs["items"]
    )

    # The scope also survives an explicit actorId/targetId probe.
    probe = client.get(
        "/api/admin/user-logs",
        headers=headers,
        params={"targetId": theirs["id"], "pageSize": 50},
    )
    assert probe.status_code == 200
    assert payload(probe)["total"] == 0
    assert mine["id"] != theirs["id"]


def test_plain_admin_cannot_write_the_global_proxy_pool(api: Any) -> None:
    client, _module = api
    super_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    keeper = _create_proxy(client, super_token, "scope-default-keeper", isDefault=True)
    other = _create_proxy(client, super_token, "scope-other-node")
    _create_admin(client, super_token, "proxy-plain-admin")

    headers = _bearer(
        _login(client, "/api/admin/auth/login", "proxy-plain-admin", "proxy-plain-admin-password")
    )

    # Reads stay open so the console can render the list.
    assert client.get("/api/admin/proxies", headers=headers).status_code == 200
    assert code(
        client.post(
            "/api/admin/proxies",
            headers=headers,
            json={
                "name": "rogue-node",
                "host": "rogue.example.test",
                "port": 3128,
                "username": "rogue",
                "password": "rogue-secret",
            },
        )
    ) == 40300
    assert client.patch(
        f"/api/admin/proxies/{other['id']}",
        headers=headers,
        json={"status": "disabled"},
    ).status_code == 403
    assert client.patch(
        f"/api/admin/proxies/{other['id']}",
        headers=headers,
        json={"isDefault": True},
    ).status_code == 403
    assert client.delete(
        f"/api/admin/proxies/{keeper['id']}", headers=headers
    ).status_code == 403

    # Nothing moved: the default mark is still where the super admin left it.
    proxies = items(client.get("/api/admin/proxies", headers=_bearer(super_token)))
    assert {p["id"]: p["isDefault"] for p in proxies} == {
        keeper["id"]: True,
        other["id"]: False,
    }


# --------------------------------------------------------------------------
# The default mark may only sit on an enabled node
# --------------------------------------------------------------------------


def test_disabling_the_default_node_drops_the_mark_and_is_audited(api: Any) -> None:
    client, _module = api
    super_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    headers = _bearer(super_token)
    first = _create_proxy(client, super_token, "first-node")
    marked = _create_proxy(client, super_token, "marked-node", isDefault=True)
    user = _create_user(client, super_token, "no-drift-user")

    assert _desktop_config(client, "no-drift-user")["proxy"]["id"] == marked["id"]

    disabled = client.patch(
        f"/api/admin/proxies/{marked['id']}", headers=headers, json={"status": "disabled"}
    )
    assert disabled.status_code == 200, disabled.text
    assert payload(disabled)["isDefault"] is False

    # The mark is gone from the table, and the audit row says what happened.
    proxies = items(client.get("/api/admin/proxies", headers=headers))
    assert [p["id"] for p in proxies if p["isDefault"]] == []
    summaries = [
        entry["summary"]
        for entry in items(client.get("/api/admin/user-logs", headers=headers, params={"pageSize": 50}))
        if entry["action"] == "PROXY_UPDATE"
    ]
    assert any("已取消其默认标记" in summary for summary in summaries)

    # Unassigned users fall back to the first active node and STAY there: an
    # unrelated edit must not move them (the old ordering was by updated_at).
    assert _desktop_config(client, "no-drift-user")["proxy"]["id"] == first["id"]
    renamed = client.patch(
        f"/api/admin/proxies/{first['id']}", headers=headers, json={"name": "first-node-renamed"}
    )
    assert renamed.status_code == 200, renamed.text
    assert _desktop_config(client, "no-drift-user")["proxy"]["id"] == first["id"]
    assert user["proxyId"] is None

    # A disabled node cannot be handed the mark, by edit or by creation.
    refused = client.patch(
        f"/api/admin/proxies/{marked['id']}", headers=headers, json={"isDefault": True}
    )
    assert refused.status_code == 400
    assert code(refused) == 40000
    created = client.post(
        "/api/admin/proxies",
        headers=headers,
        json={
            "name": "disabled-default-attempt",
            "host": "disabled-default.example.test",
            "port": 3128,
            "username": "disabled-default",
            "password": "disabled-default-secret",
            "status": "disabled",
            "isDefault": True,
        },
    )
    assert created.status_code == 400


# --------------------------------------------------------------------------
# A plain administrator cannot move accounts across tenants
# --------------------------------------------------------------------------


def test_plain_admin_cannot_rebind_or_unbind_users(api: Any) -> None:
    client, _module = api
    super_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    mine = _create_admin(client, super_token, "tenant-one-admin")
    other = _create_admin(client, super_token, "tenant-two-admin")
    user = _create_user(client, super_token, "tenant-one-user", boundAdminId=mine["id"])
    node = _create_proxy(client, super_token, "tenant-node")

    headers = _bearer(
        _login(client, "/api/admin/auth/login", "tenant-one-admin", "tenant-one-admin-password")
    )

    # Handing one of my accounts to another administrator.
    cross = client.post(
        "/api/admin/users",
        headers=headers,
        json={
            "username": "planted-user",
            "password": "planted-password",
            "name": "planted",
            "boundAdminId": other["id"],
        },
    )
    assert cross.status_code == 403
    assert code(cross) == 40301

    # Choosing a node is equally out of reach, on create and on edit.
    assert client.post(
        "/api/admin/users",
        headers=headers,
        json={
            "username": "node-chooser",
            "password": "node-chooser-password",
            "name": "node-chooser",
            "proxyId": node["id"],
        },
    ).status_code == 403
    assert client.patch(
        f"/api/admin/users/{user['id']}", headers=headers, json={"proxyId": node["id"]}
    ).status_code == 403

    # Unbinding would hide the account from every administrator while it keeps
    # working; moving it would hand it to a peer.
    assert client.patch(
        f"/api/admin/users/{user['id']}", headers=headers, json={"boundAdminId": None}
    ).status_code == 403
    assert client.patch(
        f"/api/admin/users/{user['id']}", headers=headers, json={"boundAdminId": other["id"]}
    ).status_code == 403

    # Ordinary edits still work, and the binding is untouched.
    renamed = client.patch(
        f"/api/admin/users/{user['id']}", headers=headers, json={"name": "tenant-one-user-renamed"}
    )
    assert renamed.status_code == 200, renamed.text
    assert payload(renamed)["boundAdminId"] == mine["id"]
    assert payload(renamed)["boundAdminName"] == "tenant-one-admin"

    # The super admin keeps full control.
    moved = client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_bearer(super_token),
        json={"boundAdminId": other["id"], "proxyId": node["id"]},
    )
    assert moved.status_code == 200, moved.text
    assert payload(moved)["boundAdminId"] == other["id"]
    assert payload(moved)["proxyId"] == node["id"]


def test_deleting_an_admin_releases_its_users(api: Any) -> None:
    client, _module = api
    super_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    headers = _bearer(super_token)
    doomed = _create_admin(client, super_token, "doomed-admin")
    user = _create_user(client, super_token, "released-user", boundAdminId=doomed["id"])

    removed = client.delete(f"/api/admin/admins/{doomed['id']}", headers=headers)
    assert removed.status_code in (200, 204), removed.text

    listed = next(
        entry
        for entry in items(client.get("/api/admin/users", headers=headers))
        if entry["id"] == user["id"]
    )
    assert listed["boundAdminId"] is None
    assert listed["boundAdminName"] is None

    # The account stays editable: the old binding pointed at a deleted row and
    # every update failed with "管理员不存在".
    renamed = client.patch(
        f"/api/admin/users/{user['id']}", headers=headers, json={"name": "released-user-renamed"}
    )
    assert renamed.status_code == 200, renamed.text

    summaries = [
        entry["summary"]
        for entry in items(client.get("/api/admin/user-logs", headers=headers, params={"pageSize": 50}))
        if entry["action"] == "ADMIN_DELETE"
    ]
    assert any("已解绑其名下 1 个用户" in summary for summary in summaries)


# --------------------------------------------------------------------------
# The user payload says whether the assignment still applies
# --------------------------------------------------------------------------


def test_lapsed_assignment_is_visible_in_the_user_list(api: Any) -> None:
    client, _module = api
    super_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    headers = _bearer(super_token)
    node = _create_proxy(client, super_token, "lapsing-node")
    user = _create_user(client, super_token, "lapsing-user", proxyId=node["id"])

    listed = next(
        entry
        for entry in items(client.get("/api/admin/users", headers=headers))
        if entry["id"] == user["id"]
    )
    assert listed["proxyName"] == "lapsing-node"
    assert listed["proxyActive"] is True

    disabled = client.patch(
        f"/api/admin/proxies/{node['id']}", headers=headers, json={"status": "disabled"}
    )
    assert disabled.status_code == 200, disabled.text

    listed = next(
        entry
        for entry in items(client.get("/api/admin/users", headers=headers))
        if entry["id"] == user["id"]
    )
    # The name is still shown (the assignment exists) but it no longer applies.
    assert listed["proxyName"] == "lapsing-node"
    assert listed["proxyActive"] is False


def test_created_user_payload_matches_the_read_shape(api: Any) -> None:
    client, _module = api
    super_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    node = _create_proxy(client, super_token, "shape-node")
    created = _create_user(client, super_token, "shape-user", proxyId=node["id"])

    assert created["proxyName"] == "shape-node"
    assert created["proxyActive"] is True
    assert "boundAdminName" in created and created["boundAdminName"] is None
    assert created["proxyId"] == node["id"]
