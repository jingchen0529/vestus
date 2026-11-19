from __future__ import annotations

from datetime import datetime
from typing import Any, Optional, Sequence

from sqlalchemy import and_, delete, func, select
from sqlalchemy.orm import Session

from app.db.models import NetworkMetric, User


def find_sample(session: Session, sample_id: str, user_id: Optional[int] = None) -> Optional[NetworkMetric]:
    stmt = select(NetworkMetric).where(NetworkMetric.sample_id == sample_id)
    if user_id is not None:
        stmt = stmt.where(NetworkMetric.user_id == user_id)
    return session.scalar(stmt)


def visible_user_ids(session: Session, admin_id: Optional[int]) -> Optional[Sequence[int]]:
    if admin_id is None:
        return None
    return list(session.scalars(select(User.id).where(User.bound_admin_id == admin_id, User.deleted_at.is_(None))))


def delete_expired(session: Session, cutoff: datetime, *, batch_size: int = 1000) -> int:
    ids = list(session.scalars(select(NetworkMetric.id).where(NetworkMetric.received_at < cutoff).limit(batch_size)))
    if not ids:
        return 0
    result = session.execute(delete(NetworkMetric).where(NetworkMetric.id.in_(ids)))
    return int(getattr(result, "rowcount", 0) or 0)


def query(
    session: Session,
    *,
    user_ids: Optional[Sequence[int]],
    user_id: Optional[int],
    device_id: Optional[str],
    route: Optional[str],
    network_mode: Optional[str],
    status: Optional[str],
    start_at: Optional[datetime],
    end_at: Optional[datetime],
    page: int,
    page_size: int,
) -> tuple[list[NetworkMetric], int]:
    conditions: list[Any] = []
    if user_ids is not None:
        conditions.append(NetworkMetric.user_id.in_(user_ids))
    if user_id is not None:
        conditions.append(NetworkMetric.user_id == user_id)
    if device_id:
        conditions.append(NetworkMetric.device_id == device_id)
    if route:
        conditions.append(NetworkMetric.route == route)
    if network_mode:
        conditions.append(NetworkMetric.network_mode == network_mode)
    if status:
        conditions.append(NetworkMetric.status == status)
    if start_at:
        conditions.append(NetworkMetric.measured_at >= start_at)
    if end_at:
        conditions.append(NetworkMetric.measured_at <= end_at)
    where = and_(*conditions) if conditions else None
    count = int(
        session.scalar(
            select(func.count(NetworkMetric.id)).where(where)
            if where is not None
            else select(func.count(NetworkMetric.id))
        )
        or 0
    )
    stmt = select(NetworkMetric).order_by(NetworkMetric.measured_at.desc(), NetworkMetric.id.desc())
    if where is not None:
        stmt = stmt.where(where)
    rows = list(session.scalars(stmt.offset((page - 1) * page_size).limit(page_size)))
    return rows, count


def summary_values(
    session: Session,
    *,
    user_ids: Optional[Sequence[int]],
    user_id: Optional[int],
    device_id: Optional[str],
    route: Optional[str],
    network_mode: Optional[str],
    status: Optional[str],
    start_at: Optional[datetime],
    end_at: Optional[datetime],
) -> list[NetworkMetric]:
    rows, _ = query(
        session,
        user_ids=user_ids,
        user_id=user_id,
        device_id=device_id,
        route=route,
        network_mode=network_mode,
        status=status,
        start_at=start_at,
        end_at=end_at,
        page=1,
        page_size=2_147_483_647,
    )
    return rows
