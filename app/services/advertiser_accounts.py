"""Advertiser access views. Scope is applied to evidence before any aggregation."""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import select

from app.db.base import iso_datetime
from app.db.session import Database
from app.repositories import advertiser_accounts as advertiser_repo
from app.services.browser_activity import _scoped_user_ids
from app.services.errors import NotFoundError

_NAMES = {
    "advertiser_id": "advertiserId", "platform_id": "platformId", "platform_name": "platformName",
    "managed_account_count": "managedAccountCount", "user_count": "userCount", "session_count": "sessionCount",
    "page_count": "pageCount", "total_visits": "totalVisits", "unassociated_session_count": "unassociatedSessionCount",
    "first_seen_at": "firstSeenAt", "last_seen_at": "lastSeenAt", "managed_account_id": "managedAccountId",
    "managed_account_name": "managedAccountName", "remote_account_id": "remoteAccountId",
    "remote_display_name": "remoteDisplayName", "credential_version": "credentialVersion",
    "identity_source": "identitySource", "page_id": "pageId", "session_id": "sessionId",
    "user_id": "userId", "username": "username", "url": "url", "url_params": "urlParams",
    "visits": "visits", "clicks": "clicks", "inputs": "inputs", "submits": "submits",
}


def _serialize(row: Any) -> dict[str, Any]:
    return {
        public: iso_datetime(row[key]) if key in {"first_seen_at", "last_seen_at"} else row[key]
        for key, public in _NAMES.items() if key in row
    }


def query_accounts(
    database: Database, *, view: str = "accounts", page: int = 1, page_size: int = 50,
    visible_admin_id: Optional[int] = None, option_search: Optional[str] = None, **filters: Any,
) -> dict[str, Any]:
    page, page_size = max(1, page), min(max(1, page_size), 200)
    with database.session() as session:
        scoped_ids = _scoped_user_ids(session, filters.get("user_id"), visible_admin_id)
        rows = advertiser_repo.scoped_pages(user_ids=scoped_ids, **filters)
        if view == "options":
            return advertiser_repo.options(session, rows, page=page, page_size=page_size, search=option_search)
        if view != "accounts" and session.scalar(select(rows.c.page_id).limit(1)) is None:
            raise NotFoundError("广告账户访问记录不存在")
        loader = {"accounts": advertiser_repo.list_accounts, "associations": advertiser_repo.associations,
                  "sources": advertiser_repo.sources}[view]
        found, total = loader(session, rows, page=page, page_size=page_size)
        items = [_serialize(row) for row in found]
        if view == "accounts":
            keys = [(item["platformId"], item["advertiserId"]) for item in items]
            managed_names = advertiser_repo.name_summaries(session, rows, keys, managed=True)
            user_names = advertiser_repo.name_summaries(session, rows, keys, managed=False)
            for item in items:
                key = (item["platformId"], item["advertiserId"])
                item["managedAccountNames"] = managed_names.get(key, [])
                item["usernames"] = user_names.get(key, [])
        return {"items": items, "total": total, "page": page, "pageSize": page_size,
                "pages": (total + page_size - 1) // page_size}
