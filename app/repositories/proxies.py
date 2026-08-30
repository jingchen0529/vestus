"""Proxy queries, including the legacy assignment cleanup."""

from __future__ import annotations

from typing import Any, Dict, Optional, Sequence

from sqlalchemy import delete, desc, select
from sqlalchemy.orm import Session

from app.db.models import Proxy, UserProxyAssignment


def get(session: Session, proxy_id: int | str) -> Optional[Proxy]:
    return session.get(Proxy, int(proxy_id))


def get_for_update(session: Session, proxy_id: int | str) -> Optional[Proxy]:
    return session.scalar(select(Proxy).where(Proxy.id == int(proxy_id)).with_for_update())


def list_all(session: Session) -> Sequence[Proxy]:
    return session.scalars(select(Proxy).order_by(desc(Proxy.created_at), desc(Proxy.id))).all()


def active_for_update(session: Session, *, exclude_id: Optional[int] = None) -> Sequence[Proxy]:
    stmt = select(Proxy).where(Proxy.status == "active")
    if exclude_id is not None:
        stmt = stmt.where(Proxy.id != exclude_id)
    return session.scalars(stmt.with_for_update()).all()


def create(session: Session, values: Dict[str, Any], encrypted_password: bytes, status: str) -> Proxy:
    item = Proxy(
        name=values["name"].strip(),
        host=values["host"].strip(),
        port=int(values["port"]),
        username=values["username"].strip(),
        encrypted_password=encrypted_password,
        bypass_hosts=list(values.get("bypass_hosts") or []),
        status=status,
    )
    session.add(item)
    session.flush()
    return item


def remove(session: Session, item: Proxy) -> None:
    """Delete a proxy plus the legacy per-user assignment rows pointing at it."""
    session.execute(delete(UserProxyAssignment).where(UserProxyAssignment.proxy_id == item.id))
    session.delete(item)
    session.flush()


__all__ = [
    "active_for_update",
    "create",
    "get",
    "get_for_update",
    "list_all",
    "remove",
]
