"""Proxy management.

Any number of proxies may be ``active`` at once -- each desktop user is pointed
at its own node, or at the single ``is_default`` one.  That default mark is the
only global invariant left, so both writers take the shared advisory lock
(``lock_global_proxy_activation``) *before* reading any proxy row -- two
concurrent "set default" writes otherwise both see "no other default" and
commit, leaving two.  The lock-before-select order is asserted by
``test_proxy_default_locks_singleton_before_target_row``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import encrypt_proxy_password
from app.db.base import utc_now
from app.db.models import Proxy
from app.db.session import Database, lock_global_proxy_activation
from app.repositories import proxies as proxies_repo
from app.schemas.serializers import proxy_dict
from app.services.audit import AuditContext, record
from app.services.errors import ConflictError, NotFoundError

DUPLICATE_NAME_DETAIL = "代理名称已存在"
MISSING_PROXY_DETAIL = "代理不存在"

_TEXT_FIELDS = ("name", "host", "username")
_DIRECT_FIELDS = ("name", "host", "port", "username", "status")


def _claim_default(session: Session, item: Proxy) -> None:
    """Mark ``item`` as the default proxy, clearing the previous holder.

    Callers must already hold ``lock_global_proxy_activation`` so two writers
    cannot both observe "no other default" and commit two default rows.
    """

    replaced_at = utc_now()
    for other in proxies_repo.defaults_for_update(session, exclude_id=item.id):
        other.is_default = False
        other.updated_at = replaced_at
    item.is_default = True


def list_proxies(database: Database) -> List[Dict[str, Any]]:
    with database.session() as session:
        return [proxy_dict(item) for item in proxies_repo.list_all(session)]


def get_proxy(database: Database, proxy_id: int | str) -> Optional[Dict[str, Any]]:
    with database.session() as session:
        item = proxies_repo.get(session, proxy_id)
        return proxy_dict(item) if item else None


def create_proxy(
    database: Database, values: Dict[str, Any], *, audit: Optional[AuditContext] = None
) -> Dict[str, Any]:
    with database.session() as session:
        status = values.get("status", "active")
        wants_default = bool(values.get("is_default"))
        # Before any proxy row is written: see the module docstring.
        if wants_default:
            lock_global_proxy_activation(session)
        try:
            item = proxies_repo.create(
                session, values, encrypt_proxy_password(values["password"]), status
            )
        except IntegrityError as exc:
            raise ConflictError(DUPLICATE_NAME_DETAIL) from exc
        if wants_default:
            _claim_default(session, item)
        result = proxy_dict(item)
        record(
            session,
            audit,
            "PROXY_CREATE",
            f"创建代理 {result['name']}",
            target_type="proxy",
            target_id=result["id"],
            target_name=result["name"],
        )
        return result


def update_proxy(
    database: Database,
    proxy_id: int | str,
    values: Dict[str, Any],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    numeric_id = int(proxy_id)
    with database.session() as session:
        claims_default = bool(values.get("is_default"))
        # Before the target row is even read: see the module docstring.
        if claims_default:
            lock_global_proxy_activation(session)
        item = proxies_repo.get_for_update(session, numeric_id)
        if item is None:
            raise NotFoundError(MISSING_PROXY_DETAIL)
        try:
            result = _apply_changes(session, item, values)
        except IntegrityError as exc:
            raise ConflictError(DUPLICATE_NAME_DETAIL) from exc
        safe_fields = [field for field in values if field != "password"]
        record(
            session,
            audit,
            "PROXY_UPDATE",
            f"更新代理 {result['name']}",
            target_type="proxy",
            target_id=numeric_id,
            target_name=result["name"],
            details={"fields": safe_fields, "passwordChanged": "password" in values},
        )
        return result


def _apply_changes(session: Session, item: Proxy, values: Dict[str, Any]) -> Dict[str, Any]:
    for key in _DIRECT_FIELDS:
        if key not in values:
            continue
        value = values[key]
        # ``username`` is nullable, so the isinstance guard covers it too: the old
        # unguarded ``value.strip()`` raised on an explicit ``"username": null``.
        if key in _TEXT_FIELDS and isinstance(value, str):
            value = value.strip()
        setattr(item, key, value)
    if "bypass_hosts" in values:
        item.bypass_hosts = list(values["bypass_hosts"] or [])
    if "password" in values and values["password"] is not None:
        item.encrypted_password = encrypt_proxy_password(values["password"])
    if "is_default" in values:
        # ``update_proxy`` took the lock before reading the row whenever this
        # flag is being claimed, so the previous holder is cleared safely here.
        if values["is_default"]:
            _claim_default(session, item)
        else:
            item.is_default = False
    item.updated_at = utc_now()
    session.flush()
    return proxy_dict(item)


def delete_proxy(
    database: Database, proxy_id: int | str, *, audit: Optional[AuditContext] = None
) -> bool:
    with database.session() as session:
        item = proxies_repo.get(session, proxy_id)
        if item is None:
            raise NotFoundError(MISSING_PROXY_DETAIL)
        target_name = item.name
        proxies_repo.remove(session, item)
        record(
            session,
            audit,
            "PROXY_DELETE",
            f"删除代理 {target_name}",
            target_type="proxy",
            target_id=int(proxy_id),
            target_name=target_name,
        )
        return True


__all__ = [
    "create_proxy",
    "delete_proxy",
    "get_proxy",
    "list_proxies",
    "update_proxy",
]
