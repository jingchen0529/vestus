"""Per-user VPN assignment and administrator binding.

Two features land together because both reshape what the admin API returns:

* each desktop user can be assigned its own proxy node, falling back to the
  single default-marked proxy and then to the newest active proxy;
* each desktop user can be bound to one administrator, and that administrator
  then only sees the accounts bound to them -- in the user list, the stats and
  the browser-activity views.
"""

from __future__ import annotations

from typing import Any

from tests.envelope import items, payload


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


def _create_platform(client: Any, admin_token: str, name: str) -> dict[str, Any]:
    response = client.post(
        "/api/admin/platforms",
        headers=_bearer(admin_token),
        json={"name": name, "url": f"https://{name}.example.test"},
    )
    assert response.status_code == 201, response.text
    return payload(response)


def _page(url: str, **counters: int) -> dict[str, Any]:
    row = {
        "url": url,
        "visits": 0,
        "clicks": 0,
        "inputs": 0,
        "submits": 0,
        "scrolls": 0,
        "dwellMs": 0,
        "firstSeenAtMs": 1_700_000_000_000,
        "lastSeenAtMs": 1_700_000_000_500,
    }
    row.update(counters)
    return row


def _report(*pages: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    body = {
        "sessionKey": "0000018f2c4a1b3d00001234000000aa",
        "browserId": 1,
        "platformId": 0,
        "directMode": False,
        "reportedAtMs": 1_700_000_001_000,
        "droppedPages": 0,
        "pages": list(pages),
    }
    body.update(overrides)
    return body


# --------------------------------------------------------------------------
# Per-user VPN assignment
# --------------------------------------------------------------------------


def test_unassigned_user_receives_the_default_proxy(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    default_proxy = _create_proxy(
        client, admin_token, "default-proxy", isDefault=True
    )
    other_proxy = _create_proxy(client, admin_token, "other-proxy")
    _create_user(client, admin_token, "default-follower")
    user_token = _login(client, "/api/user/auth/login", "default-follower", "default-follower-password")

    config = payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))
    assert config["proxy"]["id"] == default_proxy["id"]
    # Creating a second node must not steal the default mark.
    assert [p["id"] for p in items(client.get("/api/admin/proxies", headers=_bearer(admin_token))) if p["isDefault"]] == [
        default_proxy["id"]
    ]
    assert other_proxy["isDefault"] is False


def test_assigned_user_receives_their_own_proxy(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    default_proxy = _create_proxy(client, admin_token, "default-proxy", isDefault=True)
    beijing_proxy = _create_proxy(client, admin_token, "beijing-proxy")
    user = _create_user(client, admin_token, "beijing-user", proxyId=beijing_proxy["id"])
    user_token = _login(client, "/api/user/auth/login", "beijing-user", "beijing-user-password")

    config = payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))
    assert config["proxy"]["id"] == beijing_proxy["id"]
    assert config["proxy"]["name"] == "beijing-proxy"

    # The admin API shows the assignment with its display name.
    listed = items(client.get("/api/admin/users", headers=_bearer(admin_token)))
    mine = next(entry for entry in listed if entry["id"] == user["id"])
    assert mine["proxyId"] == beijing_proxy["id"]
    assert mine["proxyName"] == "beijing-proxy"

    # The lease reflects the assignment, and changing it back to the default
    # changes the lease again.
    first_lease = payload(
        client.get("/api/user/desktop-config/lease", headers=_bearer(user_token))
    )["lease"]
    changed = client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_bearer(admin_token),
        json={"proxyId": default_proxy["id"]},
    )
    assert changed.status_code == 200, changed.text
    config = payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))
    assert config["proxy"]["id"] == default_proxy["id"]
    second_lease = payload(
        client.get("/api/user/desktop-config/lease", headers=_bearer(user_token))
    )["lease"]
    assert second_lease != first_lease


def test_disabled_or_missing_assigned_proxy_falls_back_to_default(api: Any) -> None:
    client, module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    default_proxy = _create_proxy(client, admin_token, "default-proxy", isDefault=True)
    newest_active = _create_proxy(client, admin_token, "newest-active")
    user = _create_user(client, admin_token, "fallback-user", proxyId=newest_active["id"])
    user_token = _login(client, "/api/user/auth/login", "fallback-user", "fallback-user-password")

    # While the assigned node is active it wins, even though it is not default.
    config = payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))
    assert config["proxy"]["id"] == newest_active["id"]

    # Once the assigned node is disabled the user drops back to the default.
    disabled = client.patch(
        f"/api/admin/proxies/{newest_active['id']}",
        headers=_bearer(admin_token),
        json={"status": "disabled"},
    )
    assert disabled.status_code == 200, disabled.text
    config = payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))
    assert config["proxy"]["id"] == default_proxy["id"]

    # A reference to a deleted proxy is cleaned up at delete time.
    client.delete(
        f"/api/admin/proxies/{newest_active['id']}", headers=_bearer(admin_token)
    )
    with module.db.session() as session:
        stored = session.get(module.User, user["id"])
        assert stored is not None and stored.proxy_id is None


def test_unknown_proxy_or_admin_reference_is_rejected(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")

    missing_proxy = client.post(
        "/api/admin/users",
        headers=_bearer(admin_token),
        json={
            "username": "ghost-proxy-user",
            "password": "ghost-proxy-password",
            "name": "ghost",
            "proxyId": 424242,
        },
    )
    assert missing_proxy.status_code == 404

    proxy = _create_proxy(client, admin_token, "some-proxy")
    user = _create_user(client, admin_token, "some-user", proxyId=proxy["id"])
    patch_response = client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_bearer(admin_token),
        json={"boundAdminId": 424242},
    )
    assert patch_response.status_code == 404


def test_moving_the_default_mark_repoints_unassigned_users(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    first = _create_proxy(client, admin_token, "first-default", isDefault=True)
    second = _create_proxy(client, admin_token, "second-default")
    _create_user(client, admin_token, "floating-user")
    user_token = _login(client, "/api/user/auth/login", "floating-user", "floating-user-password")

    assert payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))["proxy"][
        "id"
    ] == first["id"]

    moved = client.patch(
        f"/api/admin/proxies/{second['id']}",
        headers=_bearer(admin_token),
        json={"isDefault": True},
    )
    assert moved.status_code == 200, moved.text
    proxies = items(client.get("/api/admin/proxies", headers=_bearer(admin_token)))
    assert {p["id"]: p["isDefault"] for p in proxies} == {
        first["id"]: False,
        second["id"]: True,
    }
    assert payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))["proxy"][
        "id"
    ] == second["id"]


# --------------------------------------------------------------------------
# Administrator binding and data isolation
# --------------------------------------------------------------------------


def test_plain_admin_sees_only_bound_users_everywhere(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    beijing_admin = _create_admin(client, admin_token, "beijing-admin")

    _create_user(client, admin_token, "bound-user", boundAdminId=beijing_admin["id"])
    _create_user(client, admin_token, "unbound-user")

    admin_login = _login(
        client, "/api/admin/auth/login", "beijing-admin", "beijing-admin-password"
    )
    headers = _bearer(admin_login)

    # The user list is narrowed to the bound accounts.
    listed = items(client.get("/api/admin/users", headers=headers))
    assert [entry["username"] for entry in listed] == ["bound-user"]

    # Stats describe only those accounts.
    stats = payload(client.get("/api/admin/stats", headers=headers))
    assert stats["total"] == 1
    assert stats["active"] == 1

    # A user outside the scope is indistinguishable from a missing one.
    outside = next(
        entry
        for entry in items(client.get("/api/admin/users", headers=_bearer(admin_token)))
        if entry["username"] == "unbound-user"
    )
    assert client.get(
        f"/api/admin/users/{outside['id']}", headers=headers
    ).status_code == 404
    assert client.patch(
        f"/api/admin/users/{outside['id']}", headers=headers, json={"name": "x"}
    ).status_code == 404
    assert client.delete(
        f"/api/admin/users/{outside['id']}", headers=headers
    ).status_code == 404

    # Creating as a plain admin binds the new account to them automatically.
    self_bound = client.post(
        "/api/admin/users",
        headers=headers,
        json={
            "username": "self-bound-user",
            "password": "self-bound-password",
            "name": "self-bound",
            "expiresAt": "2099-12-31",
        },
    )
    assert self_bound.status_code == 201, self_bound.text
    assert payload(self_bound)["boundAdminId"] == beijing_admin["id"]


def test_activity_scope_hides_other_admins_users(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    beijing_admin = _create_admin(client, admin_token, "beijing-admin")
    shanghai_admin = _create_admin(client, admin_token, "shanghai-admin")

    platform = _create_platform(client, admin_token, "tracked-platform")
    _create_user(client, admin_token, "beijing-reporter", boundAdminId=beijing_admin["id"])
    _create_user(client, admin_token, "shanghai-reporter", boundAdminId=shanghai_admin["id"])

    beijing_token = _login(
        client, "/api/user/auth/login", "beijing-reporter", "beijing-reporter-password"
    )
    uploaded = client.post(
        "/api/user/browser-activity",
        headers=_bearer(beijing_token),
        json=_report(
            _page(
                "https://tracked-platform.example.test/page",
                visits=3,
                clicks=1,
                urlParams="advid=beijing01",
            ),
            sessionKey="0000018f2c4a1b3d0000123400000001",
            platformId=platform["id"],
        ),
    )
    assert uploaded.status_code == 200, uploaded.text
    shanghai_token = _login(
        client, "/api/user/auth/login", "shanghai-reporter", "shanghai-reporter-password"
    )
    uploaded = client.post(
        "/api/user/browser-activity",
        headers=_bearer(shanghai_token),
        json=_report(
            _page(
                "https://tracked-platform.example.test/other",
                visits=2,
                urlParams="advid=shanghai01",
            ),
            sessionKey="0000018f2c4a1b3d0000123400000002",
            platformId=platform["id"],
        ),
    )
    assert uploaded.status_code == 200, uploaded.text

    headers = _bearer(
        _login(client, "/api/admin/auth/login", "beijing-admin", "beijing-admin-password")
    )

    # Session list: only the bound reporter's sessions.
    sessions = payload(client.get("/api/admin/browser-sessions", headers=headers))
    assert sessions["total"] == 1
    assert sessions["items"][0]["username"] == "beijing-reporter"
    assert sessions["items"][0]["visits"] == 3

    # An explicit filter outside the scope cannot widen it.
    super_headers = _bearer(admin_token)
    shanghai_session = next(
        item
        for item in payload(
            client.get("/api/admin/browser-sessions", headers=super_headers)
        )["items"]
        if item["username"] == "shanghai-reporter"
    )
    narrowed = payload(
        client.get(
            "/api/admin/browser-sessions",
            headers=headers,
            params={"userId": shanghai_session["userId"]},
        )
    )
    assert narrowed["total"] == 0

    # Detail of an outside session reads as not found.
    assert client.get(
        f"/api/admin/browser-sessions/{shanghai_session['id']}", headers=headers
    ).status_code == 404

    # The advid export counts only the bound reporter's rows; the super admin
    # sees both reporters' parameter values.
    exported = payload(
        client.get("/api/admin/browser-activity/export-advids", headers=headers)
    )
    assert exported["total"] == 1
    assert exported["items"][0]["paramValue"] == "beijing01"
    assert exported["items"][0]["usernames"] == "beijing-reporter"

    exported_super = payload(
        client.get("/api/admin/browser-activity/export-advids", headers=super_headers)
    )
    assert {item["paramValue"] for item in exported_super["items"]} == {
        "beijing01",
        "shanghai01",
    }


def test_super_admin_sees_everything_including_unbound_users(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    _create_user(client, admin_token, "orphan-user")
    other_admin = _create_admin(client, admin_token, "other-admin")
    _create_user(client, admin_token, "owned-user", boundAdminId=other_admin["id"])

    listed = items(client.get("/api/admin/users", headers=_bearer(admin_token)))
    assert {entry["username"] for entry in listed} == {"orphan-user", "owned-user"}
    stats = payload(client.get("/api/admin/stats", headers=_bearer(admin_token)))
    assert stats["total"] == 2

    # A super admin can bind or unbind users explicitly.
    orphan = next(entry for entry in listed if entry["username"] == "orphan-user")
    bound = client.patch(
        f"/api/admin/users/{orphan['id']}",
        headers=_bearer(admin_token),
        json={"boundAdminId": other_admin["id"]},
    )
    assert bound.status_code == 200, bound.text
    assert payload(bound)["boundAdminId"] == other_admin["id"]
    assert payload(bound)["boundAdminName"] == "other-admin"

    unbound = client.patch(
        f"/api/admin/users/{orphan['id']}",
        headers=_bearer(admin_token),
        json={"boundAdminId": None},
    )
    assert unbound.status_code == 200, unbound.text
    assert payload(unbound)["boundAdminId"] is None


def test_clearing_user_proxy_returns_to_default(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    default_proxy = _create_proxy(client, admin_token, "default-proxy", isDefault=True)
    private_proxy = _create_proxy(client, admin_token, "private-proxy")
    user = _create_user(client, admin_token, "clearable-user", proxyId=private_proxy["id"])
    user_token = _login(client, "/api/user/auth/login", "clearable-user", "clearable-user-password")

    assert payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))[
        "proxy"
    ]["id"] == private_proxy["id"]

    cleared = client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_bearer(admin_token),
        json={"proxyId": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert payload(cleared)["proxyId"] is None
    assert payload(client.get("/api/user/desktop-config", headers=_bearer(user_token)))[
        "proxy"
    ]["id"] == default_proxy["id"]
