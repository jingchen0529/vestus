"""Administrator management.

The "last active super administrator" rules are enforced inside the same
transaction as the change they guard, so two concurrent requests cannot each
observe two active super admins and then both remove one.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.db.base import utc_now
from app.db.models import Admin
from app.db.session import Database
from app.repositories import admins as admins_repo
from app.schemas.serializers import admin_dict
from app.services.audit import AuditContext, record
from app.services.errors import (
    BadRequestError,
    ConflictError,
    LastSuperAdminError,
    NotFoundError,
)

DUPLICATE_USERNAME_DETAIL = "管理员账号名已存在"
MISSING_ADMIN_DETAIL = "管理员不存在"
SELF_DISABLE_DETAIL = "不能停用当前登录管理员"
SELF_DELETE_DETAIL = "不能删除当前登录管理员"
LAST_SUPER_ADMIN_DEMOTE_DETAIL = "不能降级唯一的超级管理员"
LAST_SUPER_ADMIN_DISABLE_DETAIL = "不能停用唯一的超级管理员"

_DIRECT_FIELDS = ("username", "name", "role", "status")
_TOKEN_INVALIDATING_FIELDS = ("password", "username", "role", "status")


def _apply_changes(session: Session, item: Admin, values: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a partial update to an already-locked administrator row."""

    removes_active_super = (
        item.role == "super_admin"
        and item.status == "active"
        and (values.get("role") == "admin" or values.get("status") == "disabled")
    )
    if removes_active_super:
        active_ids = admins_repo.active_super_admin_ids_for_update(session)
        if len(active_ids) <= 1:
            raise LastSuperAdminError("不能停用或降级唯一的超级管理员")
    for key in _DIRECT_FIELDS:
        if key in values and values[key] is not None:
            value = values[key]
            setattr(item, key, value.strip() if isinstance(value, str) else value)
    if "password" in values and values["password"]:
        item.password_hash = hash_password(values["password"])
        item.password_changed_at = utc_now()
    if any(key in values for key in _TOKEN_INVALIDATING_FIELDS):
        item.token_version = int(item.token_version or 1) + 1
    session.flush()
    return admin_dict(item)


def list_admins(
    database: Database, search: Optional[str] = None, status: Optional[str] = None
) -> List[Dict[str, Any]]:
    with database.session() as session:
        return [admin_dict(item) for item in admins_repo.list_all(session, search, status)]


def get_admin(database: Database, admin_id: int | str) -> Optional[Dict[str, Any]]:
    with database.session() as session:
        item = admins_repo.get_active(session, admin_id)
        return admin_dict(item) if item else None


def create_admin(
    database: Database, values: Dict[str, Any], *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    with database.session() as session:
        try:
            item = admins_repo.create(session, values, hash_password(values["password"]))
        except IntegrityError as exc:
            raise ConflictError(DUPLICATE_USERNAME_DETAIL) from exc
        result = admin_dict(item)
        record(
            session,
            audit,
            "ADMIN_CREATE",
            f"创建管理员 {result['username']}",
            target_type="admin",
            target_id=result["id"],
            target_name=result["username"],
        )
        return result


def update_admin(
    database: Database,
    admin_id: int | str,
    values: Dict[str, Any],
    *,
    actor_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    with database.session() as session:
        item = admins_repo.get_active_for_update(session, admin_id)
        if item is None:
            raise NotFoundError(MISSING_ADMIN_DETAIL)
        if (
            actor_admin_id is not None
            and int(admin_id) == int(actor_admin_id)
            and values.get("status") == "disabled"
        ):
            raise BadRequestError(SELF_DISABLE_DETAIL)
        if (
            values.get("role") == "admin"
            and item.role == "super_admin"
            and admins_repo.count_active_super_admins(session) <= 1
        ):
            raise BadRequestError(LAST_SUPER_ADMIN_DEMOTE_DETAIL)
        if (
            values.get("status") == "disabled"
            and item.role == "super_admin"
            and item.status == "active"
            and admins_repo.count_active_super_admins(session) <= 1
        ):
            raise BadRequestError(LAST_SUPER_ADMIN_DISABLE_DETAIL)
        try:
            result = _apply_changes(session, item, values)
        except IntegrityError as exc:
            raise ConflictError(DUPLICATE_USERNAME_DETAIL) from exc
        record(
            session,
            audit,
            "ADMIN_UPDATE",
            f"更新管理员 {result['username']}",
            target_type="admin",
            target_id=int(admin_id),
            target_name=result["username"],
            details={"fields": list(values)},
        )
        return result


def enable_admin(
    database: Database, admin_id: int | str, *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    with database.session() as session:
        item = admins_repo.get_active_for_update(session, admin_id)
        if item is None:
            raise NotFoundError(MISSING_ADMIN_DETAIL)
        result = _apply_changes(session, item, {"status": "active"})
        record(
            session,
            audit,
            "ADMIN_ENABLE",
            f"启用管理员 {result['username']}",
            target_type="admin",
            target_id=int(admin_id),
            target_name=result["username"],
        )
        return result


def disable_admin(
    database: Database,
    admin_id: int | str,
    *,
    actor_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    if actor_admin_id is not None and int(admin_id) == int(actor_admin_id):
        raise BadRequestError(SELF_DISABLE_DETAIL)
    with database.session() as session:
        item = admins_repo.get_active_for_update(session, admin_id)
        if item is None:
            raise NotFoundError(MISSING_ADMIN_DETAIL)
        username = item.username
        if item.role == "super_admin" and admins_repo.count_active_super_admins(session) <= 1:
            raise BadRequestError(LAST_SUPER_ADMIN_DISABLE_DETAIL)
        result = _apply_changes(session, item, {"status": "disabled"})
        record(
            session,
            audit,
            "ADMIN_DISABLE",
            f"停用管理员 {username}",
            target_type="admin",
            target_id=int(admin_id),
            target_name=username,
        )
        return result


def reset_password(
    database: Database,
    admin_id: int | str,
    password: str,
    *,
    audit: Optional[AuditContext] = None,
) -> None:
    with database.session() as session:
        item = admins_repo.get_active_for_update(session, admin_id)
        if item is None:
            raise NotFoundError(MISSING_ADMIN_DETAIL)
        username = item.username
        _apply_changes(session, item, {"password": password})
        record(
            session,
            audit,
            "ADMIN_RESET_PASSWORD",
            f"重置管理员 {username} 密码",
            target_type="admin",
            target_id=int(admin_id),
            target_name=username,
        )


def delete_admin(
    database: Database,
    admin_id: int | str,
    *,
    actor_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> bool:
    if actor_admin_id is not None and int(admin_id) == int(actor_admin_id):
        raise BadRequestError(SELF_DELETE_DETAIL)
    with database.session() as session:
        item = admins_repo.get_active_for_update(session, admin_id)
        if item is None:
            raise NotFoundError(MISSING_ADMIN_DETAIL)
        username = item.username
        if (
            item.role == "super_admin"
            and item.status == "active"
            and admins_repo.count_active_super_admins(session) <= 1
        ):
            raise LastSuperAdminError("不能删除系统中唯一的激活超级管理员")
        item.deleted_at = utc_now()
        item.status = "disabled"
        item.token_version = int(item.token_version or 1) + 1
        session.flush()
        record(
            session,
            audit,
            "ADMIN_DELETE",
            f"删除管理员 {username}",
            target_type="admin",
            target_id=int(admin_id),
            target_name=username,
        )
        return True


__all__ = [
    "create_admin",
    "delete_admin",
    "disable_admin",
    "enable_admin",
    "get_admin",
    "list_admins",
    "reset_password",
    "update_admin",
]
