"""Browser-activity reads and the delta-merging writes.

Every write here is additive: a report carries what happened since the previous
one, so the row either does not exist yet or has its counters increased.  Nothing
in this module overwrites a counter, which is what makes a re-sent batch harmless
and a lost one recoverable.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Any, List, Optional, Sequence, Tuple

from sqlalchemy import and_, asc, desc, func, select
from sqlalchemy.orm import Session

from app.db.base import ip_bytes, parse_datetime
from app.db.models import BrowserPageVisit, BrowserSession

#: Counter columns shared by both tables, in report order.
_COUNTERS = ("visits", "clicks", "inputs", "submits", "scrolls", "dwell_ms")


def url_hash(url: str, url_params: Optional[str] = None) -> str:
    """The digest the per-session address-plus-parameters uniqueness rides on.

    Keeping the historic digest for an address without parameters means an
    upgraded deployment continues merging into its pre-migration rows.
    """

    identity = url if not url_params else f"{url}?{url_params}"
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def get_session_by_key(session: Session, *, user_id: int, session_key: str) -> Optional[BrowserSession]:
    stmt = select(BrowserSession).where(
        BrowserSession.user_id == user_id, BrowserSession.session_key == session_key
    )
    return session.scalars(stmt).one_or_none()


def create_session(
    session: Session,
    *,
    user_id: int,
    username: str,
    session_key: str,
    browser_id: int,
    platform_id: int,
    platform_name: Optional[str],
    direct_mode: bool,
    client_version: Optional[str] = None,
    ip: Optional[str],
    started_at: datetime,
) -> BrowserSession:
    item = BrowserSession(
        user_id=user_id,
        username=username[:64],
        session_key=session_key,
        browser_id=browser_id,
        platform_id=platform_id,
        platform_name=(platform_name or None) and platform_name[:100],
        direct_mode=direct_mode,
        client_version=(client_version or None) and client_version[:50],
        ip_address=ip_bytes(ip),
        started_at=started_at,
        last_report_at=started_at,
    )
    session.add(item)
    session.flush()
    return item


def add_session_totals(
    item: BrowserSession,
    *,
    deltas: dict,
    new_pages: int,
    dropped_pages: int,
    reported_at: datetime,
    client_version: Optional[str] = None,
    ip: Optional[str],
) -> None:
    for name in _COUNTERS:
        setattr(item, name, int(getattr(item, name) or 0) + int(deltas.get(name, 0)))
    item.page_count = int(item.page_count or 0) + new_pages
    # ``dropped_pages`` is the client's own running total, not a delta -- taking
    # the larger value keeps it monotonic even if reports arrive out of order.
    item.dropped_pages = max(int(item.dropped_pages or 0), dropped_pages)
    item.last_report_at = max(item.last_report_at, reported_at)
    if client_version and not item.client_version:
        item.client_version = client_version[:50]
    if ip:
        item.ip_address = ip_bytes(ip)


def merge_page(
    session: Session,
    *,
    session_id: int,
    url: str,
    url_params: Optional[str],
    deltas: dict,
    first_seen_at: datetime,
    last_seen_at: datetime,
    input_snapshot: Optional[dict],
    input_snapshot_at: Optional[datetime],
    submit_snapshot: Optional[dict],
    submit_snapshot_at: Optional[datetime],
) -> bool:
    """Add one address's deltas.  Returns whether the address was new."""

    digest = url_hash(url, url_params)
    stmt = select(BrowserPageVisit).where(
        BrowserPageVisit.session_id == session_id, BrowserPageVisit.url_hash == digest
    )
    item = session.scalars(stmt).one_or_none()
    if item is None:
        session.add(
            BrowserPageVisit(
                session_id=session_id,
                url=url,
                url_params=url_params,
                url_hash=digest,
                input_snapshot=(
                    input_snapshot if input_snapshot_at is not None else None
                ),
                input_snapshot_at=(
                    input_snapshot_at if input_snapshot is not None else None
                ),
                submit_snapshot=(
                    submit_snapshot if submit_snapshot_at is not None else None
                ),
                submit_snapshot_at=(
                    submit_snapshot_at if submit_snapshot is not None else None
                ),
                first_seen_at=first_seen_at,
                last_seen_at=last_seen_at,
                **{name: int(deltas.get(name, 0)) for name in _COUNTERS},
            )
        )
        return True
    for name in _COUNTERS:
        setattr(item, name, int(getattr(item, name) or 0) + int(deltas.get(name, 0)))
    item.first_seen_at = min(item.first_seen_at, first_seen_at)
    item.last_seen_at = max(item.last_seen_at, last_seen_at)
    if input_snapshot is not None and input_snapshot_at is not None and (
        item.input_snapshot_at is None or input_snapshot_at > item.input_snapshot_at
    ):
        item.input_snapshot = input_snapshot
        item.input_snapshot_at = input_snapshot_at
    if submit_snapshot is not None and submit_snapshot_at is not None and (
        item.submit_snapshot_at is None or submit_snapshot_at > item.submit_snapshot_at
    ):
        item.submit_snapshot = submit_snapshot
        item.submit_snapshot_at = submit_snapshot_at
    return False


def list_sessions_page(
    session: Session,
    *,
    page: int = 1,
    page_size: int = 50,
    user_id: Optional[int] = None,
    platform_id: Optional[int] = None,
    direct_mode: Optional[bool] = None,
    start_at: Any = None,
    end_at: Any = None,
) -> Tuple[Sequence[BrowserSession], int]:
    page, page_size = max(int(page), 1), min(max(int(page_size), 1), 200)
    conditions: List[Any] = []
    if user_id is not None:
        conditions.append(BrowserSession.user_id == user_id)
    if platform_id is not None:
        conditions.append(BrowserSession.platform_id == platform_id)
    if direct_mode is not None:
        conditions.append(BrowserSession.direct_mode.is_(direct_mode))
    if start_at:
        conditions.append(BrowserSession.started_at >= parse_datetime(start_at))
    if end_at:
        conditions.append(BrowserSession.started_at <= parse_datetime(end_at, end_of_day=True))
    where = and_(*conditions) if conditions else None

    count_stmt = select(func.count(BrowserSession.id))
    if where is not None:
        count_stmt = count_stmt.where(where)
    total = int(session.scalar(count_stmt) or 0)

    stmt = (
        select(BrowserSession)
        .order_by(desc(BrowserSession.started_at), desc(BrowserSession.id))
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    if where is not None:
        stmt = stmt.where(where)
    return session.scalars(stmt).all(), total


def get_session(session: Session, session_id: int | str) -> Optional[BrowserSession]:
    return session.get(BrowserSession, int(session_id))


def list_pages(session: Session, session_id: int, *, limit: int = 500) -> Sequence[BrowserPageVisit]:
    stmt = (
        select(BrowserPageVisit)
        .where(BrowserPageVisit.session_id == session_id)
        .order_by(asc(BrowserPageVisit.first_seen_at), asc(BrowserPageVisit.id))
        .limit(min(max(int(limit), 1), 1000))
    )
    return session.scalars(stmt).all()


__all__ = [
    "add_session_totals",
    "create_session",
    "get_session",
    "get_session_by_key",
    "list_pages",
    "list_sessions_page",
    "merge_page",
    "url_hash",
]
