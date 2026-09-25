"""Browser-activity reads and the delta-merging writes.

Every write here is additive: a report carries what happened since the previous
one, so the row either does not exist yet or has its counters increased.  Nothing
in this module overwrites a counter, which is what makes a re-sent batch harmless
and a lost one recoverable.
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qsl

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
    device_id: Optional[str] = None,
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
        device_id=(device_id or None) and device_id[:64],
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
    user_ids: Optional[Sequence[int]] = None,
    platform_id: Optional[int] = None,
    direct_mode: Optional[bool] = None,
    start_at: Any = None,
    end_at: Any = None,
) -> Tuple[Sequence[BrowserSession], int]:
    page, page_size = max(int(page), 1), min(max(int(page_size), 1), 200)
    conditions: List[Any] = []
    # ``user_ids`` is the visibility scope (the users bound to an admin); it
    # takes precedence so an id outside the scope cannot widen the result.
    if user_ids is not None:
        conditions.append(BrowserSession.user_id.in_(user_ids))
    elif user_id is not None:
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


def list_distinct_url_params(
    session: Session,
    *,
    param: str = "advid",
    user_id: Optional[int] = None,
    user_ids: Optional[Sequence[int]] = None,
    platform_id: Optional[int] = None,
    direct_mode: Optional[bool] = None,
    start_at: Any = None,
    end_at: Any = None,
) -> List[Dict[str, Any]]:
    """提取指定参数的所有去重取值及聚合统计。"""
    conditions: List[Any] = [
        BrowserPageVisit.url_params.contains(param, autoescape=True)
    ]
    if user_ids is not None:
        conditions.append(BrowserSession.user_id.in_(user_ids))
    elif user_id is not None:
        conditions.append(BrowserSession.user_id == user_id)
    if platform_id is not None:
        conditions.append(BrowserSession.platform_id == platform_id)
    if direct_mode is not None:
        conditions.append(BrowserSession.direct_mode.is_(direct_mode))
    if start_at:
        conditions.append(BrowserPageVisit.last_seen_at >= parse_datetime(start_at))
    if end_at:
        conditions.append(BrowserPageVisit.first_seen_at <= parse_datetime(end_at, end_of_day=True))

    stmt = (
        select(BrowserPageVisit, BrowserSession)
        .join(BrowserSession, BrowserPageVisit.session_id == BrowserSession.id)
        .where(*conditions)
        .order_by(asc(BrowserSession.id), asc(BrowserPageVisit.first_seen_at))
    )

    stats: Dict[str, Dict[str, Any]] = {}
    for visit, sess in session.execute(stmt):
        if not visit.url_params:
            continue
        pairs = parse_qsl(visit.url_params, keep_blank_values=True)
        for name, val in pairs:
            if name != param:
                continue
            if val not in stats:
                stats[val] = {
                    "param_value": val,
                    "occurrences": 0,
                    "total_visits": 0,
                    "first_seen_at": visit.first_seen_at,
                    "last_seen_at": visit.last_seen_at,
                    "usernames": set(),
                    "platforms": set(),
                }
            item = stats[val]
            item["occurrences"] += 1
            item["total_visits"] += int(visit.visits or 0)
            if visit.first_seen_at and (item["first_seen_at"] is None or visit.first_seen_at < item["first_seen_at"]):
                item["first_seen_at"] = visit.first_seen_at
            if visit.last_seen_at and (item["last_seen_at"] is None or visit.last_seen_at > item["last_seen_at"]):
                item["last_seen_at"] = visit.last_seen_at
            if sess.username:
                item["usernames"].add(sess.username)
            if sess.platform_name:
                item["platforms"].add(sess.platform_name)

    results: List[Dict[str, Any]] = []
    for val in sorted(stats.keys()):
        item = stats[val]
        results.append({
            "param_value": item["param_value"],
            "occurrences": item["occurrences"],
            "total_visits": item["total_visits"],
            "first_seen_at": item["first_seen_at"],
            "last_seen_at": item["last_seen_at"],
            "usernames": "; ".join(sorted(item["usernames"])),
            "platforms": "; ".join(sorted(item["platforms"])),
        })
    return results


def daily_activity_rows(
    session: Session,
    *,
    page: int = 1,
    page_size: int = 50,
    user_id: Optional[int] = None,
    user_ids: Optional[Sequence[int]] = None,
    platform_id: Optional[int] = None,
    direct_mode: Optional[bool] = None,
    start_at: Any = None,
    end_at: Any = None,
) -> Tuple[Sequence[Any], int]:
    """One row per user × device × platform × calendar day, counters summed.

    Sessions are grouped by the Asia/Shanghai calendar day of their start:
    clients and admins both live in that zone, so it is the day a session
    "belongs to" in every report the admins read.  A session that crosses
    midnight carries its whole running total into the day it started -- the
    session row stores totals, not per-day slices, so the alternative would be
    to invent data.  ``direct_mode`` filters which sessions are summed but does
    not split the grouping: one user's day is one row regardless of how they
    connected.  ``device_id`` may be ``None`` (clients too old to report one);
    those sessions still count, grouped under their own "unknown device" key.
    """

    page, page_size = max(int(page), 1), min(max(int(page_size), 1), 200)
    # Fixed-offset conversion needs no timezone tables on MySQL; SQLite takes
    # the same shift as a date() modifier.  Both shift the UTC column into the
    # zone where every client and admin of this deployment lives.
    bind = session.get_bind()
    if bind.dialect.name == "sqlite":
        local_day = func.date(BrowserSession.started_at, "+8 hours")
    else:
        local_day = func.date(
            func.convert_tz(BrowserSession.started_at, "+00:00", "+08:00")
        )
    conditions: List[Any] = []
    if user_ids is not None:
        conditions.append(BrowserSession.user_id.in_(user_ids))
    elif user_id is not None:
        conditions.append(BrowserSession.user_id == user_id)
    if platform_id is not None:
        conditions.append(BrowserSession.platform_id == platform_id)
    if direct_mode is not None:
        conditions.append(BrowserSession.direct_mode.is_(direct_mode))
    # The filters mean "days in this range", so they compare against the grouped
    # day directly instead of the raw UTC instant the session list filters on.
    if start_at:
        conditions.append(local_day >= str(start_at)[:10])
    if end_at:
        conditions.append(local_day <= str(end_at)[:10])
    where = and_(*conditions) if conditions else None

    grouped = select(
        BrowserSession.user_id,
        BrowserSession.username,
        BrowserSession.device_id,
        BrowserSession.platform_id,
        BrowserSession.platform_name,
        local_day.label("day"),
        func.count(BrowserSession.id).label("sessions"),
        func.sum(BrowserSession.page_count).label("page_count"),
        *[func.sum(getattr(BrowserSession, name)).label(name) for name in _COUNTERS],
        func.min(BrowserSession.started_at).label("first_at"),
        func.max(BrowserSession.last_report_at).label("last_at"),
    ).group_by(
        BrowserSession.user_id,
        BrowserSession.username,
        BrowserSession.device_id,
        BrowserSession.platform_id,
        BrowserSession.platform_name,
        local_day,
    )
    if where is not None:
        grouped = grouped.where(where)
    # Newest day first; within a day, a stable read order by user then platform.
    subquery = grouped.subquery()
    total = int(session.scalar(select(func.count()).select_from(subquery)) or 0)
    rows = session.execute(
        select(subquery)
        .order_by(
            desc(subquery.c.day),
            asc(subquery.c.user_id),
            asc(subquery.c.platform_id),
            asc(subquery.c.device_id),
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return rows, total


__all__ = [
    "add_session_totals",
    "create_session",
    "daily_activity_rows",
    "get_session",
    "get_session_by_key",
    "list_distinct_url_params",
    "list_pages",
    "list_sessions_page",
    "merge_page",
    "url_hash",
]
