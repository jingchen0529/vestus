"""Desktop client account queries."""

from __future__ import annotations

from typing import Any, Dict, Optional, Sequence

from sqlalchemy import desc, func, or_, select
from sqlalchemy.orm import Session

from app.db.base import parse_datetime, utc_now
from app.db.models import User


def get_active(session: Session, user_id: int | str) -> Optional[User]:
    return session.scalar(select(User).where(User.id == int(user_id), User.deleted_at.is_(None)))


def get_active_for_update(session: Session, user_id: int | str) -> Optional[User]:
    return session.scalar(
        select(User).where(User.id == int(user_id), User.deleted_at.is_(None)).with_for_update()
    )


def find_by_username(session: Session, username: str) -> Optional[User]:
    return session.scalar(
        select(User).where(
            func.lower(User.username) == username.strip().lower(), User.deleted_at.is_(None)
        )
    )


def list_all(
    session: Session, search: Optional[str] = None, status: Optional[str] = None
) -> Sequence[User]:
    stmt = select(User).where(User.deleted_at.is_(None))
    if search:
        pattern = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(User.username.like(pattern), User.name.like(pattern), User.company.like(pattern))
        )
    if status:
        stmt = stmt.where(User.status == status)
    return session.scalars(stmt.order_by(desc(User.created_at), desc(User.id))).all()


def create(session: Session, values: Dict[str, Any], password_hash: str) -> User:
    item = User(
        username=values["username"].strip(),
        password_hash=password_hash,
        name=values["name"].strip(),
        company=values.get("company"),
        phone=values.get("phone"),
        status=values.get("status", "active"),
        expires_at=parse_datetime(values.get("expires_at"), end_of_day=True),
        max_sessions=int(values.get("max_sessions", 1)),
        created_by=values.get("created_by"),
        remark=values.get("remark"),
        must_change_password=bool(values.get("must_change_password", False)),
    )
    session.add(item)
    session.flush()
    return item


def stats(session: Session) -> Dict[str, int]:
    now = utc_now()
    rows = session.execute(
        select(User.status, func.count(User.id))
        .where(User.deleted_at.is_(None), or_(User.expires_at.is_(None), User.expires_at > now))
        .group_by(User.status)
    ).all()
    result: Dict[str, int] = {"total": 0, "active": 0, "disabled": 0, "locked": 0, "expired": 0}
    for key, count in rows:
        result[str(key)] = int(count)
        result["total"] += int(count)
    expired_count = int(
        session.scalar(
            select(func.count(User.id)).where(
                User.deleted_at.is_(None), User.expires_at.is_not(None), User.expires_at <= now
            )
        )
        or 0
    )
    result["expired"] = expired_count
    result["total"] += expired_count
    return result


__all__ = [
    "create",
    "find_by_username",
    "get_active",
    "get_active_for_update",
    "list_all",
    "stats",
]
