"""Audit-log reads.

Writes live in :mod:`app.services.audit`, which joins the caller's transaction.
This module only reads, so it opens its own short session.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional

from app.db.session import Database
from app.repositories import logs as logs_repo
from app.schemas.serializers import log_dict
from app.services.errors import NotFoundError

MISSING_LOG_DETAIL = "日志不存在"


def list_logs(
    database: Database,
    *,
    page: int = 1,
    page_size: int = 50,
    actor_type: Optional[str] = None,
    actor_id: Optional[int] = None,
    action: Optional[str] = None,
    status: Optional[str] = None,
    target_id: Optional[int] = None,
    start_at: Any = None,
    end_at: Any = None,
) -> Dict[str, Any]:
    """Return one page of audit rows plus the pagination envelope."""

    page, page_size = max(int(page), 1), min(max(int(page_size), 1), 200)
    with database.session() as session:
        items, total = logs_repo.list_page(
            session,
            page=page,
            page_size=page_size,
            actor_type=actor_type,
            actor_id=actor_id,
            action=action,
            status=status,
            target_id=target_id,
            start_at=start_at,
            end_at=end_at,
        )
        return {
            "items": [log_dict(item) for item in items],
            "total": total,
            "page": page,
            "pageSize": page_size,
            "pages": math.ceil(total / page_size) if total else 0,
        }


def list_recent(
    database: Database, *, limit: int = 100, actor_id: Optional[int] = None
) -> List[Dict[str, Any]]:
    """The bare-list shape kept for the two legacy log endpoints."""

    with database.session() as session:
        items, _total = logs_repo.list_page(
            session, page=1, page_size=limit, actor_id=actor_id
        )
        return [log_dict(item) for item in items]


def get_log(database: Database, log_id: int | str) -> Dict[str, Any]:
    with database.session() as session:
        item = logs_repo.get(session, log_id)
        if item is None:
            raise NotFoundError(MISSING_LOG_DETAIL)
        return log_dict(item)


__all__ = ["get_log", "list_logs", "list_recent"]
