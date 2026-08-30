"""Desktop-user management.

Each function owns exactly one transaction: the account change and the audit row
describing it commit together.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.db.base import parse_datetime, utc_now
from app.db.models import User
from app.db.session import Database
from app.repositories import users as users_repo
from app.schemas.serializers import user_dict
from app.services.audit import AuditContext, record
from app.services.errors import ConflictError, NotFoundError

DUPLICATE_USERNAME_DETAIL = "用户账号名已存在"
MISSING_USER_DETAIL = "用户不存在"

_TEXT_FIELDS = ("username", "name")
_DIRECT_FIELDS = (
    "username",
    "name",
    "company",
    "phone",
    "status",
    "max_sessions",
    "remark",
    "must_change_password",
)
# Any of these invalidates issued tokens: the account changed identity, access
# window or credential.
_TOKEN_INVALIDATING_FIELDS = (
    "password",
    "username",
    "status",
    "expires_at",
    "must_change_password",
)


def apply_changes(session: Session, item: User, values: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a partial update to an already-loaded user row."""

    for key in _DIRECT_FIELDS:
        if key in values:
            value = values[key]
            setattr(
                item,
                key,
                value.strip() if isinstance(value, str) and key in _TEXT_FIELDS else value,
            )
    if "expires_at" in values:
        item.expires_at = parse_datetime(values["expires_at"], end_of_day=True)
    if values.get("status") == "active":
        item.failed_login_count = 0
        item.locked_until = None
    if values.get("password"):
        item.password_hash = hash_password(values["password"])
    if any(key in values for key in _TOKEN_INVALIDATING_FIELDS):
        item.token_version = int(item.token_version or 1) + 1
    session.flush()
    return user_dict(item)


def list_users(
    database: Database, search: Optional[str] = None, status: Optional[str] = None
) -> List[Dict[str, Any]]:
    with database.session() as session:
        return [user_dict(item) for item in users_repo.list_all(session, search, status)]


def get_user(database: Database, user_id: int | str) -> Optional[Dict[str, Any]]:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        return user_dict(item) if item else None


def create_user(
    database: Database, values: Dict[str, Any], *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    with database.session() as session:
        try:
            item = users_repo.create(session, values, hash_password(values["password"]))
        except IntegrityError as exc:
            raise ConflictError(DUPLICATE_USERNAME_DETAIL) from exc
        result = user_dict(item)
        record(
            session,
            audit,
            "USER_CREATE",
            f"创建用户 {result['username']}",
            target_type="user",
            target_id=result["id"],
            target_name=result["username"],
        )
        return result


def update_user(
    database: Database,
    user_id: int | str,
    values: Dict[str, Any],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            raise NotFoundError(MISSING_USER_DETAIL)
        try:
            result = apply_changes(session, item, values)
        except IntegrityError as exc:
            raise ConflictError(DUPLICATE_USERNAME_DETAIL) from exc
        record(
            session,
            audit,
            "USER_UPDATE",
            f"更新用户 {result['username']}",
            target_type="user",
            target_id=int(user_id),
            target_name=result["username"],
            details={"fields": list(values)},
        )
        return result


def _set_status(
    database: Database,
    user_id: int | str,
    status_value: str,
    *,
    action: str,
    verb: str,
    audit: Optional[AuditContext],
) -> Dict[str, Any]:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            raise NotFoundError(MISSING_USER_DETAIL)
        result = apply_changes(session, item, {"status": status_value})
        record(
            session,
            audit,
            action,
            f"{verb}用户 {result['username']}",
            target_type="user",
            target_id=int(user_id),
            target_name=result["username"],
        )
        return result


def enable_user(
    database: Database, user_id: int | str, *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    return _set_status(
        database, user_id, "active", action="USER_ENABLE", verb="启用", audit=audit
    )


def disable_user(
    database: Database, user_id: int | str, *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    return _set_status(
        database, user_id, "disabled", action="USER_DISABLE", verb="停用", audit=audit
    )


def reset_password(
    database: Database,
    user_id: int | str,
    password: str,
    *,
    audit: Optional[AuditContext] = None,
) -> None:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            raise NotFoundError(MISSING_USER_DETAIL)
        username = item.username
        apply_changes(session, item, {"password": password, "must_change_password": False})
        record(
            session,
            audit,
            "USER_RESET_PASSWORD",
            f"重置用户 {username} 密码",
            target_type="user",
            target_id=int(user_id),
            target_name=username,
        )


def delete_user(
    database: Database, user_id: int | str, *, audit: Optional[AuditContext] = None
) -> bool:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            raise NotFoundError(MISSING_USER_DETAIL)
        username = item.username
        item.deleted_at = utc_now()
        item.status = "disabled"
        item.token_version = int(item.token_version or 1) + 1
        session.flush()
        record(
            session,
            audit,
            "USER_DELETE",
            f"删除用户 {username}",
            target_type="user",
            target_id=int(user_id),
            target_name=username,
        )
        return True


def stats(database: Database) -> Dict[str, int]:
    with database.session() as session:
        return users_repo.stats(session)


__all__ = [
    "apply_changes",
    "create_user",
    "delete_user",
    "disable_user",
    "enable_user",
    "get_user",
    "list_users",
    "reset_password",
    "stats",
    "update_user",
]
