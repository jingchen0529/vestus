from __future__ import annotations

import hashlib
from typing import Any

import pytest

from tests.envelope import payload

ADVID = "1806535079613578"
URL = "https://localads.chengzijianzhan.cn/lamp/pc/cdp_promotion/promote-manage/project"


def login(client: Any, kind: str, username: str, password: str) -> dict[str, str]:
    response = client.post(f"/api/{kind}/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {payload(response)['accessToken']}"}


@pytest.fixture()
def activity(api: Any) -> tuple[Any, dict[str, str], dict[str, str], int, int]:
    client, _module = api
    admin = login(client, "admin", "test-admin", "test-admin-password")
    response = client.post("/api/admin/platforms", headers=admin, json={"name": "巨量方舟", "url": "https://agent.oceanengine.com/admin"})
    assert response.status_code == 201
    platform_id = payload(response)["id"]
    response = client.post("/api/admin/users", headers=admin, json={
        "username": "advertiser-user", "password": "test-password", "name": "广告测试用户", "expiresAt": "2099-12-31",
    })
    assert response.status_code == 201
    user_id = payload(response)["id"]
    user = login(client, "user", "advertiser-user", "test-password")
    return client, admin, user, platform_id, user_id


def report(client: Any, user: dict[str, str], platform_id: int, user_id: int, *,
           key: str = "session-first", batch: str = "first", advid: str = ADVID,
           managed_id: int | None = None, query: str | None = None, url: str = URL) -> Any:
    body = {
        "sessionKey": key, "browserId": 1, "platformId": platform_id,
        "ownerUserId": user_id, "protocolVersion": 2, "batchId": hashlib.sha256(batch.encode()).hexdigest(),
        "managedAccountId": managed_id,
        "pages": [{"url": url, "urlParams": query if query is not None else f"advid={advid}", "visits": 2, "clicks": 3}],
    }
    response = client.post("/api/user/browser-activity/v2", headers=user, json=body)
    assert response.status_code == 200, response.text
    return payload(response)


def test_activity_creates_queryable_advertiser_index_without_double_counting(activity: Any) -> None:
    client, admin, user, platform_id, user_id = activity
    first = report(client, user, platform_id, user_id)
    report(client, user, platform_id, user_id)
    report(client, user, platform_id, user_id, batch="second")
    response = client.get("/api/admin/advertiser-accounts", headers=admin)
    assert response.status_code == 200, response.text
    result = payload(response)
    assert result["total"] == 1
    row = result["items"][0]
    assert row["advertiserId"] == ADVID
    assert row["platformId"] == platform_id
    assert row["sessionCount"] == 1
    assert row["pageCount"] == 1
    assert row["totalVisits"] == 4
    assert row["unassociatedSessionCount"] == 1
    assert row["usernames"] == ["advertiser-user"]
    sources = client.get(f"/api/admin/advertiser-accounts/{platform_id}/{ADVID}/sources", headers=admin)
    assert sources.status_code == 200, sources.text
    source = payload(sources)["items"][0]
    assert source["sessionId"] == first["sessionId"]
    assert source["urlParams"] == f"advid={ADVID}"
    assert source["identitySource"] == "unassociated"


def managed(client: Any, admin: dict[str, str], user_id: int, name: str) -> int:
    response = client.post(f"/api/admin/users/{user_id}/managed-accounts", headers=admin, json={
        "name": name, "authMode": "cookie", "cookieBundle": [{"name": "sid", "value": "synthetic", "domain": ".oceanengine.com"}],
    })
    assert response.status_code == 201, response.text
    return payload(response)["managedAccountId"]


def test_one_advertiser_preserves_multiple_managed_accounts_and_historical_names(activity: Any) -> None:
    client, admin, user, platform_id, user_id = activity
    first_id = managed(client, admin, user_id, "巨量账号甲")
    second_id = managed(client, admin, user_id, "巨量账号乙")
    report(client, user, platform_id, user_id, key="session-account-a", batch="a", managed_id=first_id)
    report(client, user, platform_id, user_id, key="session-account-b", batch="b", managed_id=second_id)
    renamed = client.patch(f"/api/admin/managed-platform-accounts/{first_id}", headers=admin, json={"name": "现在的新名称"})
    assert renamed.status_code == 200
    row = payload(client.get("/api/admin/advertiser-accounts", headers=admin))["items"][0]
    assert row["managedAccountCount"] == 2
    assert row["sessionCount"] == 2
    assert set(row["managedAccountNames"]) == {"巨量账号甲", "巨量账号乙"}
    response = client.get(f"/api/admin/advertiser-accounts/{platform_id}/{ADVID}/associations", headers=admin)
    assert response.status_code == 200, response.text
    assert payload(response)["total"] == 2
    assert {item["identitySource"] for item in payload(response)["items"]} == {"historical"}
    narrowed = payload(client.get("/api/admin/advertiser-accounts", headers=admin, params={"managedAccountId": first_id}))
    assert narrowed["items"][0]["sessionCount"] == 1


def test_visibility_is_applied_before_aggregation_and_to_options_and_sources(activity: Any) -> None:
    client, admin, user, platform_id, user_id = activity
    created_admin = client.post("/api/admin/admins", headers=admin, json={
        "username": "scope-admin", "password": "scope-password", "name": "范围管理员", "role": "admin",
    })
    assert created_admin.status_code == 201
    scope_id = payload(created_admin)["id"]
    bound = client.patch(f"/api/admin/users/{user_id}", headers=admin, json={"boundAdminId": scope_id})
    assert bound.status_code == 200, bound.text
    first_id = managed(client, admin, user_id, "可见账号")
    report(client, user, platform_id, user_id, managed_id=first_id)
    other = client.post("/api/admin/users", headers=admin, json={
        "username": "hidden-user", "password": "test-password", "name": "不可见用户", "expiresAt": "2099-12-31",
    })
    assert other.status_code == 201
    other_id = payload(other)["id"]
    other_token = login(client, "user", "hidden-user", "test-password")
    hidden_id = managed(client, admin, other_id, "不可见巨量账号")
    report(client, other_token, platform_id, other_id, managed_id=hidden_id)
    report(client, other_token, platform_id, other_id, key="hidden-only-session", batch="hidden-only", advid="12345", managed_id=hidden_id)
    scope = login(client, "admin", "scope-admin", "scope-password")
    result = payload(client.get("/api/admin/advertiser-accounts", headers=scope))
    assert result["total"] == 1
    row = result["items"][0]
    assert row["managedAccountCount"] == row["userCount"] == row["sessionCount"] == 1
    assert row["managedAccountNames"] == ["可见账号"]
    assert row["usernames"] == ["advertiser-user"]
    options = payload(client.get("/api/admin/advertiser-accounts/options", headers=scope))
    assert options["managedAccounts"] == [{"id": first_id, "name": "可见账号"}]
    assert payload(client.get("/api/admin/advertiser-accounts", headers=scope, params={"userId": other_id}))["total"] == 0
    assert client.get(f"/api/admin/advertiser-accounts/{platform_id}/12345/sources", headers=scope).status_code == 404
    visible_sources = payload(client.get(f"/api/admin/advertiser-accounts/{platform_id}/{ADVID}/sources", headers=scope))
    assert visible_sources["total"] == 1
    assert visible_sources["items"][0]["userId"] == user_id


def test_index_rejects_ambiguous_and_nested_ids_and_paginates_groups(activity: Any) -> None:
    client, admin, user, platform_id, user_id = activity
    for index, query in enumerate(["advid=100&advid=100", "advid=200", "advid=300&advid=400", "from=%3Fadvid%3D500", "advid="]):
        report(client, user, platform_id, user_id, batch=f"page-{index}", query=query)
    result = payload(client.get("/api/admin/advertiser-accounts", headers=admin, params={"pageSize": 1}))
    assert result["total"] == 2
    assert result["pages"] == 2
    second = payload(client.get("/api/admin/advertiser-accounts", headers=admin, params={"pageSize": 1, "page": 2}))
    assert result["items"][0]["advertiserId"] != second["items"][0]["advertiserId"]
    narrowed = payload(client.get("/api/admin/advertiser-accounts", headers=admin, params={"advertiserId": "10"}))
    assert narrowed["total"] == 1
    assert narrowed["items"][0]["totalVisits"] == 2


def test_deleting_source_page_removes_its_index_on_sqlite(activity: Any, api: Any) -> None:
    from sqlalchemy import select

    from app.db.models import BrowserPageAdvertiser, BrowserPageVisit

    client, admin, user, platform_id, user_id = activity
    _client, module = api
    report(client, user, platform_id, user_id)
    with module.db.session() as session:
        page = session.scalar(select(BrowserPageVisit))
        assert session.get(BrowserPageAdvertiser, page.id) is not None
        session.delete(page)
    with module.db.session() as session:
        assert session.scalar(select(BrowserPageAdvertiser)) is None
    assert payload(client.get("/api/admin/advertiser-accounts", headers=admin))["total"] == 0


@pytest.mark.parametrize("params", [
    {"startAt": "2026-99-99"}, {"startAt": "2026-11-06", "endAt": "2026-11-01"},
    {"startAt": "0001-01-01"}, {"page": str(2**64)}, {"userId": str(2**64)},
])
def test_invalid_advertiser_date_filters_are_client_errors(activity: Any, params: dict) -> None:
    client, admin, _user, _platform_id, _user_id = activity
    response = client.get("/api/admin/advertiser-accounts", headers=admin, params=params)
    assert response.status_code == 422, response.text


def test_list_name_queries_are_bounded_for_multiple_advertisers(activity: Any, api: Any) -> None:
    from sqlalchemy import event

    client, admin, user, platform_id, user_id = activity
    _client, module = api
    for index in range(8):
        report(client, user, platform_id, user_id, batch=f"bulk-{index}", advid=str(1000 + index))
    statements = []

    def count_queries(_conn: Any, _cursor: Any, statement: str, _parameters: Any, _context: Any, _many: bool) -> None:
        if statement.lstrip().upper().startswith("SELECT"):
            # Deployment uses MySQL 5.7: SQLite accepting window functions must
            # not hide a query that the target server cannot execute.
            assert "ROW_NUMBER(" not in statement.upper()
            assert " OVER (" not in statement.upper()
            statements.append(statement)

    event.listen(module.db.engine, "before_cursor_execute", count_queries)
    try:
        response = client.get("/api/admin/advertiser-accounts", headers=admin, params={"pageSize": 200})
    finally:
        event.remove(module.db.engine, "before_cursor_execute", count_queries)
    assert response.status_code == 200, response.text
    assert payload(response)["total"] == 8
    assert len(statements) <= 6


def test_name_summaries_keep_three_distinct_names_per_scoped_advertiser(activity: Any) -> None:
    client, admin, user, platform_id, user_id = activity
    names = ["Delta", "Alpha", "Charlie", "Bravo", "Echo"]
    for index, name in enumerate(names):
        created = client.post("/api/admin/users", headers=admin, json={
            "username": f"summary-{name.lower()}", "password": "test-password",
            "name": name, "expiresAt": "2099-12-31",
        })
        assert created.status_code == 201, created.text
        owner_id = payload(created)["id"]
        owner = login(client, "user", f"summary-{name.lower()}", "test-password")
        account_id = managed(client, admin, owner_id, f"Account-{name}")
        report(client, owner, platform_id, owner_id, key=f"names-session-{index}", batch=f"names-{index}", managed_id=account_id)
        # Another source page must not consume a separate name slot.
        report(client, owner, platform_id, owner_id, key=f"repeat-{index}", batch=f"repeat-{index}", managed_id=account_id)
    other_id = managed(client, admin, user_id, "Other advertiser only")
    report(client, user, platform_id, user_id, key="other-advertiser", batch="other-advertiser", managed_id=other_id, advid="99999")
    response = client.get("/api/admin/advertiser-accounts", headers=admin)
    assert response.status_code == 200, response.text
    rows = {row["advertiserId"]: row for row in payload(response)["items"]}
    assert rows[ADVID]["managedAccountNames"] == ["Account-Alpha", "Account-Bravo", "Account-Charlie"]
    assert rows[ADVID]["usernames"] == ["summary-alpha", "summary-bravo", "summary-charlie"]
    assert rows[ADVID]["userCount"] == 5
    assert rows[ADVID]["pageCount"] == 10
    assert rows["99999"]["managedAccountNames"] == ["Other advertiser only"]
    assert rows["99999"]["usernames"] == ["advertiser-user"]
    narrowed = client.get("/api/admin/advertiser-accounts", headers=admin, params={"userId": owner_id})
    assert narrowed.status_code == 200, narrowed.text
    assert payload(narrowed)["items"][0]["managedAccountNames"] == ["Account-Echo"]
    assert payload(narrowed)["items"][0]["usernames"] == ["summary-echo"]


def test_filter_options_support_search_and_bounded_pages(activity: Any) -> None:
    client, admin, user, platform_id, user_id = activity
    for index in range(3):
        account_id = managed(client, admin, user_id, f"巨量选项{index}")
        report(client, user, platform_id, user_id, key=f"option-session-{index}", batch=f"option-{index}", managed_id=account_id)
    result = payload(client.get("/api/admin/advertiser-accounts/options", headers=admin, params={"pageSize": 1}))
    assert len(result["managedAccounts"]) == 1
    assert result["managedAccountsHasMore"] is True
    second = payload(client.get("/api/admin/advertiser-accounts/options", headers=admin, params={"pageSize": 1, "page": 2}))
    assert second["managedAccounts"][0]["id"] != result["managedAccounts"][0]["id"]
    found = payload(client.get("/api/admin/advertiser-accounts/options", headers=admin, params={"search": "选项2"}))
    assert [item["name"] for item in found["managedAccounts"]] == ["巨量选项2"]


def test_session_advertiser_list_is_limited_to_that_session(activity: Any) -> None:
    client, admin, user, platform_id, user_id = activity
    first_id = managed(client, admin, user_id, "本次会话账号")
    second_id = managed(client, admin, user_id, "另一次会话账号")
    first = report(client, user, platform_id, user_id, key="selected-session", batch="selected", managed_id=first_id)
    report(client, user, platform_id, user_id, key="other-session", batch="other", managed_id=second_id)
    report(client, user, platform_id, user_id, key="other-session", batch="other-advertiser", managed_id=second_id, advid="99999")
    query = {"sessionId": first["sessionId"]}
    result = payload(client.get("/api/admin/advertiser-accounts", headers=admin, params=query))
    assert result["total"] == 1
    row = result["items"][0]
    assert row["advertiserId"] == ADVID
    assert row["sessionCount"] == 1
    assert row["totalVisits"] == 2
    assert row["managedAccountNames"] == ["本次会话账号"]
    for view in ("sources", "associations"):
        result = payload(client.get(f"/api/admin/advertiser-accounts/{platform_id}/{ADVID}/{view}", headers=admin, params=query))
        assert result["total"] == 1
        assert result["items"][0]["managedAccountId"] == first_id
    missing = payload(client.get("/api/admin/advertiser-accounts", headers=admin, params={"sessionId": 999999}))
    assert missing["total"] == 0
