"""Audit-log writes and the paginated admin listing."""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import and_, desc, func, or_, select
from sqlalchemy.orm import Session

from app.db.base import ip_bytes, parse_datetime
from app.db.models import UserLog


def create(
    session: Session,
    *,
    actor_type: str,
    action: str,
    summary: str,
    actor_id: Optional[int] = None,
    actor_username: Optional[str] = None,
    actor_role: Optional[str] = None,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
    status: str = "SUCCESS",
    target_type: Optional[str] = None,
    target_id: Optional[int] = None,
    target_name: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    request_id: Optional[str] = None,
) -> UserLog:
    item = UserLog(
        request_id=request_id or str(uuid.uuid4()),
        actor_type=actor_type,
        actor_id=actor_id,
        actor_username=actor_username,
        actor_role=actor_role,
        action=action,
        target_type=target_type,
        target_id=target_id,
        target_name=target_name,
        summary=summary[:500],
        ip_address=ip_bytes(ip),
        user_agent=(user_agent or "")[:512] or None,
        status=status,
        details=details,
    )
    session.add(item)
    return item


def visibility_condition(
    admin_id: Optional[int], bound_user_ids: Optional[Sequence[int]]
) -> Optional[Any]:
    """Restrict a log listing to what one plain administrator may see.

    ``None`` means no restriction (a super administrator).  Otherwise the rows
    kept are: the administrator's own actions, whatever their bound users did,
    and whatever was done *to* those users.  Everything else -- other admins'
    actions, other tenants' users, and failed logins for unknown usernames
    (written as ``actor_type='system'`` with the attempted name in ``summary``)
    -- stays hidden, because those rows carry exactly the account names the
    binding is meant to keep apart.
    """

    if admin_id is None:
        return None
    clauses: List[Any] = [
        and_(UserLog.actor_type == "admin", UserLog.actor_id == int(admin_id))
    ]
    ids = [int(value) for value in (bound_user_ids or [])]
    if ids:
        clauses.append(and_(UserLog.actor_type == "user", UserLog.actor_id.in_(ids)))
        clauses.append(and_(UserLog.target_type == "user", UserLog.target_id.in_(ids)))
    return or_(*clauses)


def list_page(
    session: Session,
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
    visible: Optional[Any] = None,
) -> Tuple[Sequence[UserLog], int]:
    page, page_size = max(int(page), 1), min(max(int(page_size), 1), 200)
    conditions: List[Any] = []
    # The visibility scope is applied first and is never widened by a caller
    # supplied filter: ``actorId``/``targetId`` can only narrow the result.
    if visible is not None:
        conditions.append(visible)
    if actor_type:
        conditions.append(UserLog.actor_type == actor_type)
    if actor_id is not None:
        conditions.append(UserLog.actor_id == actor_id)
    if action:
        conditions.append(UserLog.action == action)
    if status:
        conditions.append(UserLog.status == status)
    if target_id is not None:
        conditions.append(UserLog.target_id == target_id)
    if start_at:
        conditions.append(UserLog.created_at >= parse_datetime(start_at))
    if end_at:
        conditions.append(UserLog.created_at <= parse_datetime(end_at, end_of_day=True))
    where = and_(*conditions) if conditions else None
    count_stmt = select(func.count(UserLog.id))
    if where is not None:
        count_stmt = count_stmt.where(where)
    total = int(session.scalar(count_stmt) or 0)
    stmt = (
        select(UserLog)
        .order_by(desc(UserLog.created_at), desc(UserLog.id))
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    if where is not None:
        stmt = stmt.where(where)
    return session.scalars(stmt).all(), total


def get(session: Session, log_id: int | str, *, visible: Optional[Any] = None) -> Optional[UserLog]:
    """One audit row, or ``None`` when it lies outside the caller's scope.

    Reading by id goes through the same visibility clause as the listing, so a
    row that the list hides cannot be fetched by guessing its id.
    """

    stmt = select(UserLog).where(UserLog.id == int(log_id))
    if visible is not None:
        stmt = stmt.where(visible)
    return session.scalar(stmt)


__all__ = ["create", "get", "list_page", "visibility_condition"]
