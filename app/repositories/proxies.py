"""Proxy queries, including the stale per-user reference cleanup."""

from __future__ import annotations

from typing import Any, Dict, Optional, Sequence

from sqlalchemy import delete, desc, select, update
from sqlalchemy.orm import Session

from app.db.models import Proxy, User, UserProxyAssignment


def get(session: Session, proxy_id: int | str) -> Optional[Proxy]:
    return session.get(Proxy, int(proxy_id))


def get_for_update(session: Session, proxy_id: int | str) -> Optional[Proxy]:
    return session.scalar(select(Proxy).where(Proxy.id == int(proxy_id)).with_for_update())


def list_all(session: Session) -> Sequence[Proxy]:
    return session.scalars(select(Proxy).order_by(desc(Proxy.created_at), desc(Proxy.id))).all()


def defaults_for_update(session: Session, *, exclude_id: Optional[int] = None) -> Sequence[Proxy]:
    """Every row currently carrying the default mark, optionally excluding one.

    Rows are locked so the caller can clear the previous default holder while
    concurrent ``is_default`` writes wait on the global proxy lock.
    """
    stmt = select(Proxy).where(Proxy.is_default.is_(True))
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
    """Delete a proxy plus every user reference pointing at it.

    Users assigned to the deleted node fall back to the default proxy; their
    stale ``proxy_id`` is dropped here instead of leaving dead ids in the table.
    """
    session.execute(delete(UserProxyAssignment).where(UserProxyAssignment.proxy_id == item.id))
    session.execute(update(User).where(User.proxy_id == item.id).values(proxy_id=None))
    session.delete(item)
    session.flush()


__all__ = [
    "create",
    "defaults_for_update",
    "get",
    "get_for_update",
    "list_all",
    "remove",
]
