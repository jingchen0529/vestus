"""Platform queries.  Icons are joined so serialization can verify them."""

from __future__ import annotations

from typing import List, Optional, Sequence, Tuple

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.db.models import Platform, UploadedFile, UserPlatformAssignment

PlatformWithIcon = Tuple[Platform, Optional[UploadedFile]]


def get(session: Session, platform_id: int | str) -> Optional[Platform]:
    return session.get(Platform, int(platform_id))


def get_with_icon(session: Session, platform_id: int | str) -> Optional[PlatformWithIcon]:
    row = session.execute(
        select(Platform, UploadedFile)
        .outerjoin(UploadedFile, UploadedFile.path == Platform.icon_url)
        .where(Platform.id == int(platform_id))
    ).one_or_none()
    return (row[0], row[1]) if row else None


def list_with_icons(session: Session) -> List[PlatformWithIcon]:
    rows = session.execute(
        select(Platform, UploadedFile)
        .outerjoin(UploadedFile, UploadedFile.path == Platform.icon_url)
        .order_by(Platform.sort_order, Platform.id)
    ).all()
    return [(item, uploaded_file) for item, uploaded_file in rows]


def find_by_ids(session: Session, platform_ids: Sequence[int]) -> List[Platform]:
    return list(session.scalars(select(Platform).where(Platform.id.in_(platform_ids))).all())


def create(session: Session, *, name: str, url: str, icon_url: Optional[str], sort_order: int, status: str) -> Platform:
    item = Platform(name=name, url=url, icon_url=icon_url, sort_order=sort_order, status=status)
    session.add(item)
    session.flush()
    return item


def remove(session: Session, item: Platform) -> None:
    """Delete a platform plus the legacy per-user assignment rows for it."""
    session.execute(delete(UserPlatformAssignment).where(UserPlatformAssignment.platform_id == item.id))
    session.delete(item)
    session.flush()


__all__ = [
    "PlatformWithIcon",
    "create",
    "find_by_ids",
    "get",
    "get_with_icon",
    "list_with_icons",
    "remove",
]
