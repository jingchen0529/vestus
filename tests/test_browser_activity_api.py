"""Browser-activity reporting: the delta contract, the privacy boundary, the views.

The three properties worth locking down here are the ones a future change is most
likely to break by accident:

* batches **add**, so a retried or duplicated upload cannot rewrite history;
* the stored address never carries a query string, a fragment or credentials,
  whatever the client sends;
* a report only ever touches the reporting user's own session row.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select

from tests.envelope import code, payload

SESSION_KEY = "0000018f2c4a1b3d000012340000002a"
OTHER_SESSION_KEY = "0000018f2c4a1b3d00001234000000ff"


def _login(client: Any, path: str, username: str, password: str) -> str:
    response = client.post(path, json={"username": username, "password": password})
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
        "sessionKey": SESSION_KEY,
        "browserId": 1,
        "platformId": 1,
        "directMode": False,
        "reportedAtMs": 1_700_000_001_000,
        "droppedPages": 0,
        "pages": list(pages),
    }
    body.update(overrides)
    return body


def _setup(client: Any, username: str = "browsing-user") -> tuple[str, str, int]:
    """Returns ``(admin_token, user_token, platform_id)``."""

    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    _create_user(client, admin_token, username)
    user_token = _login(client, "/api/user/auth/login", username, f"{username}-password")
    platform = _create_platform(client, admin_token, "reported-platform")
    return admin_token, user_token, int(platform["id"])


def test_repeated_reports_accumulate_into_one_session(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform_id = _setup(client)

    first = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(
            _page("https://shop.example.test/orders", visits=1, clicks=3, dwellMs=4_000),
            _page("https://shop.example.test/items", visits=1, scrolls=2, dwellMs=1_000),
            platformId=platform_id,
        ),
    )
    assert first.status_code == 200, first.text
    assert payload(first)["newPages"] == 2

    second = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(
            _page("https://shop.example.test/orders", clicks=2, inputs=5, dwellMs=6_000),
            platformId=platform_id,
        ),
    )
    assert second.status_code == 200, second.text
    # The address was already known, so nothing new was created.
    assert payload(second)["newPages"] == 0
    assert payload(first)["sessionId"] == payload(second)["sessionId"]

    listing = payload(client.get("/api/admin/browser-sessions", headers=_bearer(admin_token)))
    assert listing["total"] == 1
    session_row = listing["items"][0]
    assert session_row["username"] == "browsing-user"
    assert session_row["platformName"] == "reported-platform"
    assert session_row["pageCount"] == 2
    assert session_row["visits"] == 2
    assert session_row["clicks"] == 5
    assert session_row["inputs"] == 5
    assert session_row["scrolls"] == 2
    assert session_row["dwellMs"] == 11_000
    assert session_row["ipAddress"] == "198.51.100.27"

    detail = payload(
        client.get(
            f"/api/admin/browser-sessions/{session_row['id']}",
            headers=_bearer(admin_token),
        )
    )
    by_url = {row["url"]: row for row in detail["pages"]}
    assert by_url["https://shop.example.test/orders"]["clicks"] == 5
    assert by_url["https://shop.example.test/orders"]["dwellMs"] == 10_000
    assert by_url["https://shop.example.test/items"]["scrolls"] == 2


def test_the_stored_address_keeps_the_path_and_drops_everything_else(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform_id = _setup(client)

    response = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(
            _page(
                "https://shop.example.test/orders/42?token=secret&q=name#section",
                visits=1,
            ),
            platformId=platform_id,
        ),
    )
    assert response.status_code == 200, response.text

    detail = payload(
        client.get(
            f"/api/admin/browser-sessions/{payload(response)['sessionId']}",
            headers=_bearer(admin_token),
        )
    )
    assert detail["pages"][0]["url"] == "https://shop.example.test/orders/42"


def test_a_report_is_rejected_when_the_address_is_not_a_web_page(api: Any) -> None:
    client, _module = api
    _admin_token, user_token, platform_id = _setup(client)

    for url in (
        "file:///Users/someone/private.txt",
        "javascript:alert(1)",
        "https://user:secret@shop.example.test/orders",
        "not-a-url",
    ):
        response = client.post(
            "/api/user/browser-activity",
            headers=_bearer(user_token),
            json=_report(_page(url, visits=1), platformId=platform_id),
        )
        assert response.status_code == 422, f"{url} should not be accepted: {response.text}"
        assert code(response) == 42200


def test_one_user_cannot_write_into_another_users_session(api: Any) -> None:
    client, _module = api
    admin_token = _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")
    _create_user(client, admin_token, "first-user")
    _create_user(client, admin_token, "second-user")
    first_token = _login(client, "/api/user/auth/login", "first-user", "first-user-password")
    second_token = _login(client, "/api/user/auth/login", "second-user", "second-user-password")
    platform_id = int(_create_platform(client, admin_token, "shared-platform")["id"])

    body = _report(_page("https://shop.example.test/a", visits=1), platformId=platform_id)
    first = client.post("/api/user/browser-activity", headers=_bearer(first_token), json=body)
    second = client.post("/api/user/browser-activity", headers=_bearer(second_token), json=body)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    # Same session key, two users: two rows, because the key is only unique
    # within one account.
    assert payload(first)["sessionId"] != payload(second)["sessionId"]

    listing = payload(client.get("/api/admin/browser-sessions", headers=_bearer(admin_token)))
    assert listing["total"] == 2
    assert {row["username"] for row in listing["items"]} == {"first-user", "second-user"}


def test_only_the_reporting_user_and_admins_can_reach_the_endpoints(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform_id = _setup(client)
    body = _report(_page("https://shop.example.test/a", visits=1), platformId=platform_id)

    # The admin login left a session cookie on the client, and a cookie-authenticated
    # write is refused without a same-origin ``Origin`` -- the CSRF guard, before
    # the account type is even considered.
    assert client.post("/api/user/browser-activity", json=body).status_code == 403
    client.cookies.clear()
    assert client.post("/api/user/browser-activity", json=body).status_code == 401
    # An admin token is not a desktop token.
    assert (
        client.post(
            "/api/user/browser-activity", headers=_bearer(admin_token), json=body
        ).status_code
        == 403
    )
    assert client.get("/api/admin/browser-sessions").status_code == 401
    assert (
        client.get("/api/admin/browser-sessions", headers=_bearer(user_token)).status_code == 403
    )


def test_an_implausible_client_clock_falls_back_to_server_time(api: Any) -> None:
    client, module = api
    admin_token, user_token, platform_id = _setup(client)
    before = module.utc_now()

    response = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(
            _page(
                "https://shop.example.test/a",
                visits=1,
                firstSeenAtMs=253_402_300_799_000,  # year 9999
                lastSeenAtMs=253_402_300_799_000,
            ),
            platformId=platform_id,
            reportedAtMs=0,
        ),
    )
    assert response.status_code == 200, response.text

    detail = payload(
        client.get(
            f"/api/admin/browser-sessions/{payload(response)['sessionId']}",
            headers=_bearer(admin_token),
        )
    )
    # Not the client's year 9999, and not before the request either.
    assert detail["pages"][0]["firstSeenAt"] >= before.isoformat(timespec="seconds") + "Z"
    assert detail["startedAt"] >= before.isoformat(timespec="seconds") + "Z"


def test_a_report_must_stay_within_the_declared_limits(api: Any) -> None:
    client, _module = api
    _admin_token, user_token, platform_id = _setup(client)

    from app.schemas.browser_activity import MAX_PAGES_PER_REPORT

    too_many = [
        _page(f"https://shop.example.test/{index}", visits=1)
        for index in range(MAX_PAGES_PER_REPORT + 1)
    ]
    response = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(*too_many, platformId=platform_id),
    )
    assert response.status_code == 422, response.text

    for overrides in (
        {"pages": []},
        {"sessionKey": "short"},
        {"sessionKey": "has spaces and is long enough"},
    ):
        response = client.post(
            "/api/user/browser-activity",
            headers=_bearer(user_token),
            json=_report(
                _page("https://shop.example.test/a", visits=1),
                platformId=platform_id,
                **overrides,
            ),
        )
        assert response.status_code == 422, f"{overrides} should be rejected: {response.text}"

    # An unknown counter name is a client/server mismatch, not something to store.
    body = _report(_page("https://shop.example.test/a", visits=1), platformId=platform_id)
    body["pages"][0]["keystrokes"] = 12
    assert (
        client.post(
            "/api/user/browser-activity", headers=_bearer(user_token), json=body
        ).status_code
        == 422
    )


def test_a_deleted_platform_leaves_the_recorded_name_intact(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform_id = _setup(client)

    response = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(_page("https://shop.example.test/a", visits=1), platformId=platform_id),
    )
    assert response.status_code == 200, response.text
    assert (
        client.delete(
            f"/api/admin/platforms/{platform_id}", headers=_bearer(admin_token)
        ).status_code
        == 200
    )

    listing = payload(client.get("/api/admin/browser-sessions", headers=_bearer(admin_token)))
    assert listing["items"][0]["platformName"] == "reported-platform"


def test_an_unknown_platform_is_recorded_without_a_name(api: Any) -> None:
    client, _module = api
    admin_token, user_token, _platform_id = _setup(client)

    response = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(_page("https://shop.example.test/a", visits=1), platformId=999_999),
    )
    assert response.status_code == 200, response.text

    listing = payload(client.get("/api/admin/browser-sessions", headers=_bearer(admin_token)))
    assert listing["items"][0]["platformId"] == 999_999
    assert listing["items"][0]["platformName"] is None


def test_the_admin_listing_filters_by_user_platform_and_mode(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform_id = _setup(client)
    user_id = payload(
        client.get("/api/admin/users", headers=_bearer(admin_token))
    )["items"][0]["id"]

    for key, direct in ((SESSION_KEY, False), (OTHER_SESSION_KEY, True)):
        response = client.post(
            "/api/user/browser-activity",
            headers=_bearer(user_token),
            json=_report(
                _page("https://shop.example.test/a", visits=1),
                sessionKey=key,
                platformId=platform_id,
                directMode=direct,
            ),
        )
        assert response.status_code == 200, response.text

    def listed(**params: Any) -> list[dict[str, Any]]:
        result = client.get(
            "/api/admin/browser-sessions", headers=_bearer(admin_token), params=params
        )
        assert result.status_code == 200, result.text
        return payload(result)["items"]

    assert len(listed()) == 2
    assert len(listed(directMode="true")) == 1
    assert listed(directMode="true")[0]["sessionKey"] == OTHER_SESSION_KEY
    # ``false`` has to filter as well as ``true`` does: the admin console's
    # "went through the proxy" choice sends exactly this.
    assert len(listed(directMode="false")) == 1
    assert listed(directMode="false")[0]["sessionKey"] == SESSION_KEY
    assert len(listed(userId=user_id)) == 2
    assert len(listed(userId=user_id + 1000)) == 0
    assert len(listed(platformId=platform_id)) == 2
    assert len(listed(platformId=platform_id + 1000)) == 0


def test_the_admin_listing_filters_by_date_range(api: Any) -> None:
    """``startAt`` / ``endAt`` take plain dates, and ``endAt`` includes its own day."""

    client, _module = api
    admin_token, user_token, platform_id = _setup(client)
    response = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(_page("https://shop.example.test/a", visits=1), platformId=platform_id),
    )
    assert response.status_code == 200, response.text

    # The fixture's client timestamps are years old, so the session is dated with
    # server time -- the window is anchored on today either way.
    today = datetime.now(timezone.utc).date()
    yesterday = (today - timedelta(days=1)).isoformat()
    tomorrow = (today + timedelta(days=1)).isoformat()

    def listed(**params: Any) -> list[dict[str, Any]]:
        result = client.get(
            "/api/admin/browser-sessions", headers=_bearer(admin_token), params=params
        )
        assert result.status_code == 200, result.text
        return payload(result)["items"]

    assert len(listed(startAt=yesterday, endAt=tomorrow)) == 1
    assert len(listed(endAt=today.isoformat())) == 1
    assert len(listed(startAt=tomorrow)) == 0
    assert len(listed(endAt=yesterday)) == 0


def test_a_missing_session_reads_as_not_found(api: Any) -> None:
    client, _module = api
    admin_token, _user_token, _platform_id = _setup(client)
    response = client.get("/api/admin/browser-sessions/424242", headers=_bearer(admin_token))
    assert response.status_code == 404
    assert code(response) == 40400


def test_the_client_overflow_counter_is_kept_monotonic(api: Any) -> None:
    client, _module = api
    admin_token, user_token, platform_id = _setup(client)

    for dropped in (7, 3, 9):
        response = client.post(
            "/api/user/browser-activity",
            headers=_bearer(user_token),
            json=_report(
                _page("https://shop.example.test/a", visits=1),
                platformId=platform_id,
                droppedPages=dropped,
            ),
        )
        assert response.status_code == 200, response.text

    listing = payload(client.get("/api/admin/browser-sessions", headers=_bearer(admin_token)))
    # The client sends a running total, so an out-of-order batch must not lower it.
    assert listing["items"][0]["droppedPages"] == 9


def test_the_page_table_stores_the_digest_not_a_long_index(api: Any) -> None:
    client, module = api
    _admin_token, user_token, platform_id = _setup(client)
    url = "https://shop.example.test/" + "a" * 400

    response = client.post(
        "/api/user/browser-activity",
        headers=_bearer(user_token),
        json=_report(_page(url, visits=1), platformId=platform_id),
    )
    assert response.status_code == 200, response.text

    from app.db.models import BrowserPageVisit
    from app.repositories.browser_activity import url_hash

    with module.db.session() as session:
        row = session.scalars(select(BrowserPageVisit)).one()
        assert row.url == url
        assert row.url_hash == url_hash(url)
        assert len(row.url_hash) == 64
