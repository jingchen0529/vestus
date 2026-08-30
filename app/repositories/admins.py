"""Administrator account queries."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

from sqlalchemy import desc, func, or_, select
from sqlalchemy.orm import Session

from app.db.base import utc_now
from app.db.models import Admin


def get_active(session: Session, admin_id: int | str) -> Optional[Admin]:
    return session.scalar(select(Admin).where(Admin.id == int(admin_id), Admin.deleted_at.is_(None)))


def get_active_for_update(session: Session, admin_id: int | str) -> Optional[Admin]:
    return session.scalar(
        select(Admin).where(Admin.id == int(admin_id), Admin.deleted_at.is_(None)).with_for_update()
    )


def find_by_username(session: Session, username: str) -> Optional[Admin]:
    return session.scalar(
        select(Admin).where(
            func.lower(Admin.username) == username.strip().lower(), Admin.deleted_at.is_(None)
        )
    )


def list_all(
    session: Session, search: Optional[str] = None, status: Optional[str] = None
) -> Sequence[Admin]:
    stmt = select(Admin).where(Admin.deleted_at.is_(None))
    if search:
        pattern = f"%{search.strip()}%"
        stmt = stmt.where(or_(Admin.username.like(pattern), Admin.name.like(pattern)))
    if status:
        stmt = stmt.where(Admin.status == status)
    return session.scalars(stmt.order_by(desc(Admin.created_at), desc(Admin.id))).all()


def active_super_admin_ids_for_update(session: Session) -> List[int]:
    """Lock the active super-admin set before demoting or disabling one."""
    return list(
        session.scalars(
            select(Admin.id)
            .where(Admin.role == "super_admin", Admin.status == "active", Admin.deleted_at.is_(None))
            .with_for_update()
        ).all()
    )


def count_active_super_admins(session: Session) -> int:
    return int(
        session.scalar(
            select(func.count(Admin.id)).where(
                Admin.role == "super_admin", Admin.status == "active", Admin.deleted_at.is_(None)
            )
        )
        or 0
    )


def create(session: Session, values: Dict[str, Any], password_hash: str) -> Admin:
    item = Admin(
        username=values["username"].strip(),
        password_hash=password_hash,
        name=values["name"].strip(),
        role=values.get("role", "admin"),
        status=values.get("status", "active"),
        password_changed_at=utc_now(),
    )
    session.add(item)
    session.flush()
    return item


__all__ = [
    "active_super_admin_ids_for_update",
    "count_active_super_admins",
    "create",
    "find_by_username",
    "get_active",
    "get_active_for_update",
    "list_all",
]
