"""Browser activity: recording the desktop client's reports and reading them back.

The recording side has three jobs beyond the obvious write:

* **Adopt or create the session row.**  A run reports many times; the first
  report creates the row and the rest add to it, keyed on
  ``(user_id, session_key)``.  Two batches racing on a fresh session both try to
  insert, so the loser retries as an adopt -- see :func:`_session_for_report`.
* **Distrust the client's clock.**  The report carries epoch milliseconds from a
  machine we do not control.  They are only used to order and to date rows
  *within* a plausible window; anything outside it collapses to server time, and
  the audit columns are server time unconditionally.
* **Strip the address again.**  :func:`~app.schemas.browser_activity.normalize_reported_url`
  already ran in the request model; the URL that reaches the database has no
  query, no fragment and no credentials regardless of what the client sent.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.base import utc_now
from app.db.session import Database
from app.repositories import browser_activity as activity_repo
from app.repositories import platforms as platforms_repo
from app.schemas.browser_activity import BrowserActivityReport, BrowserPageReport
from app.schemas.serializers import browser_page_visit_dict, browser_session_dict
from app.services.errors import NotFoundError

MISSING_SESSION_DETAIL = "浏览器会话记录不存在"

#: How far a client timestamp may sit from server time before we stop believing
#: it.  Generous in the past because a report can be retried across a long
#: outage; tight in the future because a clock ahead of ours is always wrong.
MAX_CLOCK_SKEW_PAST = timedelta(days=7)
MAX_CLOCK_SKEW_FUTURE = timedelta(minutes=5)

_COUNTERS = ("visits", "clicks", "inputs", "submits", "scrolls", "dwell_ms")


def _server_time(value_ms: int, now: datetime) -> datetime:
    """Convert a client epoch-ms value, falling back to ``now`` when implausible."""

    if value_ms <= 0:
        return now
    try:
        moment = datetime.fromtimestamp(value_ms / 1000.0, tz=timezone.utc).replace(tzinfo=None)
    except (OverflowError, OSError, ValueError):
        return now
    if moment > now + MAX_CLOCK_SKEW_FUTURE or moment < now - MAX_CLOCK_SKEW_PAST:
        return now
    return moment


def _deltas(page: BrowserPageReport) -> Dict[str, int]:
    return {name: int(getattr(page, name)) for name in _COUNTERS}


def _session_for_report(
    session: Session,
    report: BrowserActivityReport,
    *,
    user_id: int,
    username: str,
    ip: Optional[str],
    now: datetime,
) -> Any:
    """The session row this report belongs to, creating it on first sight.

    Two reports from the same run can reach two workers at once, and both will
    find no row.  The unique constraint decides which insert wins; the loser
    rolls its savepoint back and reads the winner's row instead of failing the
    upload.
    """

    existing = activity_repo.get_session_by_key(
        session, user_id=user_id, session_key=report.session_key
    )
    if existing is not None:
        return existing
    platform = platforms_repo.get(session, report.platform_id)
    started_at = min(
        (_server_time(page.first_seen_at_ms, now) for page in report.pages), default=now
    )
    try:
        with session.begin_nested():
            return activity_repo.create_session(
                session,
                user_id=user_id,
                username=username,
                session_key=report.session_key,
                browser_id=report.browser_id,
                platform_id=report.platform_id,
                platform_name=getattr(platform, "name", None),
                direct_mode=report.direct_mode,
                ip=ip,
                started_at=started_at,
            )
    except IntegrityError:
        adopted = activity_repo.get_session_by_key(
            session, user_id=user_id, session_key=report.session_key
        )
        if adopted is None:
            raise
        return adopted


def record_activity(
    database: Database,
    report: BrowserActivityReport,
    *,
    user_id: int,
    username: str,
    ip: Optional[str] = None,
) -> Dict[str, Any]:
    """Merge one batch of deltas into its session.  Returns what was accepted."""

    now = utc_now()
    with database.session() as session:
        item = _session_for_report(
            session, report, user_id=user_id, username=username, ip=ip, now=now
        )
        totals = dict.fromkeys(_COUNTERS, 0)
        new_pages = 0
        for page in report.pages:
            deltas = _deltas(page)
            for name in _COUNTERS:
                totals[name] += deltas[name]
            first_seen = _server_time(page.first_seen_at_ms, now)
            last_seen = max(first_seen, _server_time(page.last_seen_at_ms, now))
            if activity_repo.merge_page(
                session,
                session_id=item.id,
                url=page.url,
                deltas=deltas,
                first_seen_at=first_seen,
                last_seen_at=last_seen,
            ):
                new_pages += 1
        activity_repo.add_session_totals(
            item,
            deltas=totals,
            new_pages=new_pages,
            dropped_pages=report.dropped_pages,
            reported_at=_server_time(report.reported_at_ms, now),
            ip=ip,
        )
        session.flush()
        return {"sessionId": item.id, "acceptedPages": len(report.pages), "newPages": new_pages}


def list_sessions(
    database: Database,
    *,
    page: int = 1,
    page_size: int = 50,
    user_id: Optional[int] = None,
    platform_id: Optional[int] = None,
    direct_mode: Optional[bool] = None,
    start_at: Any = None,
    end_at: Any = None,
) -> Dict[str, Any]:
    """One page of browser sessions, newest first."""

    page, page_size = max(int(page), 1), min(max(int(page_size), 1), 200)
    with database.session() as session:
        items, total = activity_repo.list_sessions_page(
            session,
            page=page,
            page_size=page_size,
            user_id=user_id,
            platform_id=platform_id,
            direct_mode=direct_mode,
            start_at=start_at,
            end_at=end_at,
        )
        return {
            "items": [browser_session_dict(item) for item in items],
            "total": total,
            "page": page,
            "pageSize": page_size,
            "pages": math.ceil(total / page_size) if total else 0,
        }


def get_session_detail(
    database: Database, session_id: int | str, *, page_limit: int = 500
) -> Dict[str, Any]:
    """One session with the addresses visited during it, oldest first."""

    with database.session() as session:
        item = activity_repo.get_session(session, session_id)
        if item is None:
            raise NotFoundError(MISSING_SESSION_DETAIL)
        pages: List[Dict[str, Any]] = [
            browser_page_visit_dict(row)
            for row in activity_repo.list_pages(session, item.id, limit=page_limit)
        ]
        return {**browser_session_dict(item), "pages": pages}


__all__ = [
    "get_session_detail",
    "list_sessions",
    "record_activity",
]
