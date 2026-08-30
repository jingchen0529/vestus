"""Platform management.

Icon references are resolved through :func:`app.services.uploads.validated_image_reference`
so a platform can never point at an upload that is missing or unsafe to serve
inline.  Both the snake_case and camelCase spellings of the request fields are
accepted, because the previous implementation did and the desktop client relies
on it.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.uploads import normalize_upload_reference
from app.db.base import utc_now
from app.db.models import Platform, UploadedFile
from app.db.session import Database
from app.repositories import platforms as platforms_repo
from app.repositories import uploads as uploads_repo
from app.schemas.serializers import platform_dict
from app.services.audit import AuditContext, record
from app.services.errors import ConflictError, NotFoundError
from app.services.uploads import validated_image_reference

DUPLICATE_NAME_DETAIL = "平台名称已存在"
MISSING_PLATFORM_DETAIL = "平台不存在"

# Request keys mapped onto column names; both spellings reach the same column.
_FIELD_MAP = {
    "name": "name",
    "url": "url",
    "icon_url": "icon_url",
    "iconUrl": "icon_url",
    "sort_order": "sort_order",
    "sortOrder": "sort_order",
    "status": "status",
}
_TEXT_FIELDS = ("name", "url")
_ICON_FIELDS = ("icon_url", "iconUrl")


def list_platforms(database: Database) -> List[Dict[str, Any]]:
    with database.session() as session:
        return [
            platform_dict(item, uploaded_file=uploaded_file)
            for item, uploaded_file in platforms_repo.list_with_icons(session)
        ]


def get_platform(database: Database, platform_id: int | str) -> Optional[Dict[str, Any]]:
    with database.session() as session:
        row = platforms_repo.get_with_icon(session, platform_id)
        return platform_dict(row[0], uploaded_file=row[1]) if row else None


def create_platform(
    database: Database, values: Dict[str, Any], *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    with database.session() as session:
        icon_url, uploaded_file = validated_image_reference(
            session, values.get("icon_url") or values.get("iconUrl") or ""
        )
        try:
            item = platforms_repo.create(
                session,
                name=values["name"].strip(),
                url=values["url"].strip(),
                icon_url=icon_url or None,
                sort_order=int(values.get("sort_order", values.get("sortOrder", 0))),
                status=values.get("status", "active"),
            )
        except IntegrityError as exc:
            raise ConflictError(DUPLICATE_NAME_DETAIL) from exc
        result = platform_dict(item, uploaded_file=uploaded_file)
        record(
            session,
            audit,
            "PLATFORM_CREATE",
            f"创建平台 {result['name']}",
            target_type="platform",
            target_id=result["id"],
            target_name=result["name"],
        )
        return result


def _reread_icon(session: Session, item: Platform) -> Optional[UploadedFile]:
    """Look the current icon up again when the request did not touch it.

    Without this an untouched icon would serialize as if it had no upload row and
    silently disappear from the response.
    """

    try:
        normalized = normalize_upload_reference(item.icon_url or "")
    except ValueError:
        normalized = ""
    return uploads_repo.get_by_path(session, normalized) if normalized else None


def update_platform(
    database: Database,
    platform_id: int | str,
    values: Dict[str, Any],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    with database.session() as session:
        item = platforms_repo.get(session, platform_id)
        if item is None:
            raise NotFoundError(MISSING_PLATFORM_DETAIL)
        uploaded_file: Optional[UploadedFile] = None
        for key, attr in _FIELD_MAP.items():
            if key not in values:
                continue
            value = values[key]
            if key in _TEXT_FIELDS and isinstance(value, str):
                value = value.strip()
            elif key in _ICON_FIELDS and isinstance(value, str):
                normalized, uploaded_file = validated_image_reference(session, value)
                value = normalized or None
            setattr(item, attr, value)
        item.updated_at = utc_now()
        try:
            session.flush()
        except IntegrityError as exc:
            raise ConflictError(DUPLICATE_NAME_DETAIL) from exc
        if not any(key in values for key in _ICON_FIELDS):
            uploaded_file = _reread_icon(session, item)
        result = platform_dict(item, uploaded_file=uploaded_file)
        record(
            session,
            audit,
            "PLATFORM_UPDATE",
            f"更新平台 {result['name']}",
            target_type="platform",
            target_id=int(platform_id),
            target_name=result["name"],
            details={"fields": list(values)},
        )
        return result


def delete_platform(
    database: Database, platform_id: int | str, *, audit: Optional[AuditContext] = None
) -> bool:
    with database.session() as session:
        item = platforms_repo.get(session, platform_id)
        if item is None:
            raise NotFoundError(MISSING_PLATFORM_DETAIL)
        target_name = item.name
        platforms_repo.remove(session, item)
        record(
            session,
            audit,
            "PLATFORM_DELETE",
            f"删除平台 {target_name}",
            target_type="platform",
            target_id=int(platform_id),
            target_name=target_name,
        )
        return True


__all__ = [
    "create_platform",
    "delete_platform",
    "get_platform",
    "list_platforms",
    "update_platform",
]
