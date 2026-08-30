"""Managed upload bookkeeping and the shared image-reference check.

:func:`validated_image_reference` needs a ``Session`` -- it proves the reference
points at a real, inline-safe upload -- so it lives here rather than in
:mod:`app.schemas.serializers`, which stays pure.  Branding and platform icons
both go through it.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.uploads import is_inline_safe, normalize_upload_reference
from app.db.models import UploadedFile
from app.db.session import Database
from app.repositories import uploads as uploads_repo
from app.schemas.serializers import uploaded_file_dict
from app.services.errors import BadRequestError


def validated_image_reference(
    session: Session, value: Optional[str]
) -> Tuple[str, Optional[UploadedFile]]:
    """Resolve a managed upload reference, refusing anything unverifiable.

    An empty value clears the reference.  Anything else must match a stored
    upload whose extension and content type make it safe to serve inline.
    """

    try:
        normalized = normalize_upload_reference(value or "")
    except ValueError as exc:
        raise BadRequestError(str(exc)) from exc
    if not normalized:
        return "", None
    uploaded_file = uploads_repo.get_by_path(session, normalized)
    if uploaded_file is None or not is_inline_safe(
        uploaded_file.path, uploaded_file.content_type
    ):
        raise BadRequestError("图片必须引用已上传的安全图片文件")
    return normalized, uploaded_file


def create_uploaded_file(
    database: Database,
    *,
    original_name: str,
    path: str,
    content_type: str,
    size: int,
    uploaded_by: int,
) -> Dict[str, Any]:
    if not path.startswith("/uploads/") or "://" in path:
        raise BadRequestError("invalid upload path")
    with database.session() as session:
        item = uploads_repo.create(
            session,
            original_name=original_name,
            path=path,
            content_type=content_type,
            size=size,
            uploaded_by=uploaded_by,
        )
        return uploaded_file_dict(item)


def get_uploaded_file_by_path(database: Database, path: str) -> Optional[Dict[str, Any]]:
    with database.session() as session:
        item = uploads_repo.get_by_path(session, path)
        return uploaded_file_dict(item) if item else None


__all__ = ["create_uploaded_file", "get_uploaded_file_by_path", "validated_image_reference"]
