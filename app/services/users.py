"""Desktop-user management.

Each function owns exactly one transaction: the account change and the audit row
describing it commit together.

Reads and writes accept an optional ``visible_admin_id`` scope: a plain
administrator only sees and manages the accounts bound to them
(``User.bound_admin_id``), and anything outside that scope is reported as not
found rather than forbidden, so the API does not leak which accounts exist.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.db.base import parse_datetime, utc_now
from app.db.models import Admin, Proxy, User
from app.db.session import Database
from app.repositories import proxies as proxies_repo
from app.repositories import users as users_repo
from app.schemas.serializers import user_dict
from app.services.admins import MISSING_ADMIN_DETAIL
from app.services.audit import AuditContext, record
from app.services.errors import ConflictError, NotFoundError
from app.services.proxies import MISSING_PROXY_DETAIL

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


def _resolve_proxy_id(session: Session, value: Any) -> Optional[int]:
    """Validate a per-user VPN assignment; ``None`` means "use the default"."""

    if value is None:
        return None
    if proxies_repo.get(session, value) is None:
        raise NotFoundError(MISSING_PROXY_DETAIL)
    return int(value)


def _resolve_bound_admin_id(session: Session, value: Any) -> Optional[int]:
    """Validate an administrator binding; ``None`` means "unbound"."""

    if value is None:
        return None
    admin = session.scalar(
        select(Admin).where(Admin.id == int(value), Admin.deleted_at.is_(None))
    )
    if admin is None:
        raise NotFoundError(MISSING_ADMIN_DETAIL)
    return int(value)


def _ensure_visible(item: User, visible_admin_id: Optional[int]) -> None:
    if visible_admin_id is not None and item.bound_admin_id != int(visible_admin_id):
        raise NotFoundError(MISSING_USER_DETAIL)


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
    if "proxy_id" in values:
        item.proxy_id = _resolve_proxy_id(session, values["proxy_id"])
    if "bound_admin_id" in values:
        item.bound_admin_id = _resolve_bound_admin_id(session, values["bound_admin_id"])
    if values.get("status") == "active":
        item.failed_login_count = 0
        item.locked_until = None
    if values.get("password"):
        item.password_hash = hash_password(values["password"])
    if any(key in values for key in _TOKEN_INVALIDATING_FIELDS):
        item.token_version = int(item.token_version or 1) + 1
    session.flush()
    return user_dict(item)


def _assignment_name_maps(
    session: Session, results: List[Dict[str, Any]]
) -> Tuple[Dict[int, str], Dict[int, str]]:
    proxy_ids = {entry["proxyId"] for entry in results if entry.get("proxyId")}
    admin_ids = {entry["boundAdminId"] for entry in results if entry.get("boundAdminId")}
    proxy_names: Dict[int, str] = {}
    admin_names: Dict[int, str] = {}
    if proxy_ids:
        proxy_names = dict(
            session.execute(select(Proxy.id, Proxy.name).where(Proxy.id.in_(proxy_ids))).all()
        )
    if admin_ids:
        admin_names = dict(
            session.execute(select(Admin.id, Admin.name).where(Admin.id.in_(admin_ids))).all()
        )
    return proxy_names, admin_names


def _enrich(
    session: Session, results: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Attach display names for the assigned VPN and the bound administrator."""

    proxy_names, admin_names = _assignment_name_maps(session, results)
    for entry in results:
        entry["proxyName"] = proxy_names.get(entry["proxyId"]) if entry.get("proxyId") else None
        entry["boundAdminName"] = (
            admin_names.get(entry["boundAdminId"]) if entry.get("boundAdminId") else None
        )
    return results


def list_users(
    database: Database,
    search: Optional[str] = None,
    status: Optional[str] = None,
    visible_admin_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    with database.session() as session:
        items = users_repo.list_all(session, search, status, visible_admin_id)
        return _enrich(session, [user_dict(item) for item in items])


def get_user(
    database: Database, user_id: int | str, *, visible_admin_id: Optional[int] = None
) -> Optional[Dict[str, Any]]:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            return None
        _ensure_visible(item, visible_admin_id)
        return _enrich(session, [user_dict(item)])[0]


def create_user(
    database: Database, values: Dict[str, Any], *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    with database.session() as session:
        # Reject unknown references before the insert so a typo'd id does not
        # half-create the account.
        values["proxy_id"] = _resolve_proxy_id(session, values.get("proxy_id"))
        values["bound_admin_id"] = _resolve_bound_admin_id(session, values.get("bound_admin_id"))
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
    visible_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            raise NotFoundError(MISSING_USER_DETAIL)
        _ensure_visible(item, visible_admin_id)
        try:
            result = _enrich(session, [apply_changes(session, item, values)])[0]
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
    visible_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            raise NotFoundError(MISSING_USER_DETAIL)
        _ensure_visible(item, visible_admin_id)
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
    database: Database,
    user_id: int | str,
    *,
    visible_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    return _set_status(
        database,
        user_id,
        "active",
        action="USER_ENABLE",
        verb="启用",
        visible_admin_id=visible_admin_id,
        audit=audit,
    )


def disable_user(
    database: Database,
    user_id: int | str,
    *,
    visible_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    return _set_status(
        database,
        user_id,
        "disabled",
        action="USER_DISABLE",
        verb="停用",
        visible_admin_id=visible_admin_id,
        audit=audit,
    )


def reset_password(
    database: Database,
    user_id: int | str,
    password: str,
    *,
    visible_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> None:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            raise NotFoundError(MISSING_USER_DETAIL)
        _ensure_visible(item, visible_admin_id)
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
    database: Database,
    user_id: int | str,
    *,
    visible_admin_id: Optional[int] = None,
    audit: Optional[AuditContext] = None,
) -> bool:
    with database.session() as session:
        item = users_repo.get_active(session, user_id)
        if item is None:
            raise NotFoundError(MISSING_USER_DETAIL)
        _ensure_visible(item, visible_admin_id)
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


def stats(database: Database, *, visible_admin_id: Optional[int] = None) -> Dict[str, int]:
    with database.session() as session:
        return users_repo.stats(session, visible_admin_id)


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
