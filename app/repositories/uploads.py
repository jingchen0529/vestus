"""Uploaded-file metadata queries."""

from __future__ import annotations

from typing import Dict, Iterable, Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import UploadedFile


def create(
    session: Session,
    *,
    original_name: str,
    path: str,
    content_type: str,
    size: int,
    uploaded_by: int,
) -> UploadedFile:
    item = UploadedFile(
        original_name=original_name,
        path=path,
        content_type=content_type,
        size=size,
        uploaded_by=uploaded_by,
    )
    session.add(item)
    session.flush()
    return item


def get_by_path(session: Session, path: str) -> Optional[UploadedFile]:
    return session.scalar(select(UploadedFile).where(UploadedFile.path == path))


def map_by_paths(session: Session, paths: Iterable[str]) -> Dict[str, UploadedFile]:
    wanted = [path for path in paths if path]
    if not wanted:
        return {}
    return {
        item.path: item
        for item in session.scalars(select(UploadedFile).where(UploadedFile.path.in_(wanted))).all()
    }
