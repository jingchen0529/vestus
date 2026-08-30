"""Authentication: login, logout and self-service password change.

Login runs in a **single** transaction.  That matters for the rejection paths:
the failed-attempt counter, the lockout timestamp and the ``FAILED`` audit row
all have to survive a refused login, so the error is stashed in a local variable
and raised *after* the ``with`` block closes and commits.  Raising inside the
block would roll the counter back and let an attacker retry forever.

Only the cookie belongs to the HTTP layer, so :func:`login` returns the token
and its lifetime and lets the router decide whether to set one.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import (
    create_access_token,
    hash_password,
    password_needs_rehash,
    verify_password,
)
from app.db.base import ip_bytes, utc_now
from app.db.models import Admin, User
from app.db.session import Database
from app.repositories import admins as admins_repo
from app.repositories import users as users_repo
from app.schemas.serializers import admin_dict, user_dict
from app.services.audit import AuditContext, record
from app.services.errors import (
    AccountUnavailableError,
    AuthenticationError,
    BadRequestError,
    ServiceError,
)
from app.services.users import apply_changes

INVALID_CREDENTIALS_DETAIL = "账号或密码错误"
ACCOUNT_UNAVAILABLE_DETAIL = "账号已被禁用或锁定"
ACCOUNT_EXPIRED_DETAIL = "账号授权已过期"
ACCOUNT_LOCKED_DETAIL = "账号暂时锁定"
WRONG_CURRENT_PASSWORD_DETAIL = "当前密码错误"


@dataclass(frozen=True)
class TokenGrant:
    """A successful login: the response body plus what the cookie needs."""

    payload: Dict[str, Any]
    token: str
    ttl_seconds: int


def find_admin_by_username(database: Database, username: str) -> Optional[Dict[str, Any]]:
    """Used by the legacy combined-login endpoint to pick an account type."""

    with database.session() as session:
        item = admins_repo.find_by_username(session, username)
        return admin_dict(item) if item else None


def load_account_model(database: Database, account_type: str, account_id: int | str) -> Any:
    """Return the live account row for a token subject, or ``None``."""

    with database.session() as session:
        if account_type == "admin":
            return admins_repo.get_active(session, account_id)
        return users_repo.get_active(session, account_id)


def _account_dict(account_type: str, model: Any) -> Dict[str, Any]:
    return admin_dict(model) if account_type == "admin" else user_dict(model)


def _token_payload(account_type: str, model: Any, token: str, expires: int) -> Dict[str, Any]:
    """Both snake_case and camelCase keys: existing clients read either."""

    expires_at = datetime.fromtimestamp(expires, timezone.utc).isoformat()
    result: Dict[str, Any] = {
        "access_token": token,
        "accessToken": token,
        "token_type": "bearer",
        "expires_at": expires_at,
        "expiresAt": expires_at,
    }
    result["admin" if account_type == "admin" else "user"] = _account_dict(account_type, model)
    return result


def _reject(
    session: Session,
    audit: Optional[AuditContext],
    account_type: str,
    username: str,
    reason: str,
    error: ServiceError,
    *,
    model: Any = None,
) -> ServiceError:
    """Write the ``FAILED`` login row and hand the error back to the caller."""

    context = audit.for_account(account_type, model) if audit and model is not None else audit
    record(session, context, "LOGIN", f"{username}: {reason}", status="FAILED")
    return error


def _register_failed_attempt(model: Any, *, max_attempts: int, lock_minutes: int) -> None:
    """Count a wrong password and lock the account once the limit is reached.

    Administrators are deliberately exempt: locking the only super admin out of
    the console is a worse outcome than the brute-force risk, which the audit
    log already surfaces.
    """

    if not isinstance(model, User):
        return
    model.failed_login_count = int(model.failed_login_count or 0) + 1
    if model.failed_login_count >= max(int(max_attempts), 1):
        model.locked_until = utc_now() + timedelta(minutes=max(int(lock_minutes), 1))


def _mark_login(model: Any, ip: Optional[str]) -> None:
    model.last_login_at = utc_now()
    model.last_login_ip = ip_bytes(ip)
    if isinstance(model, User):
        model.failed_login_count = 0
        model.locked_until = None


def _refuse_login(
    session: Session,
    audit: Optional[AuditContext],
    account_type: str,
    model: Any,
    password: str,
) -> Optional[ServiceError]:
    """Run every rejection rule in the original order; ``None`` means allowed."""

    settings = get_settings()
    if not verify_password(password, model.password_hash):
        _register_failed_attempt(
            model,
            max_attempts=settings.login_max_attempts,
            lock_minutes=settings.login_lock_minutes,
        )
        return _reject(
            session,
            audit,
            account_type,
            model.username,
            "密码错误",
            AuthenticationError(INVALID_CREDENTIALS_DETAIL),
            model=model,
        )
    if model.status != "active":
        return _reject(
            session,
            audit,
            account_type,
            model.username,
            "账号不可用",
            AccountUnavailableError(ACCOUNT_UNAVAILABLE_DETAIL),
            model=model,
        )
    if isinstance(model, User) and model.expires_at is not None and utc_now() >= model.expires_at:
        return _reject(
            session,
            audit,
            account_type,
            model.username,
            "账号已过期",
            AccountUnavailableError(ACCOUNT_EXPIRED_DETAIL),
            model=model,
        )
    if isinstance(model, User) and model.locked_until is not None and utc_now() < model.locked_until:
        # A lockout is the consequence of attempts that were already logged;
        # logging it again would only pad the audit trail.
        return AccountUnavailableError(ACCOUNT_LOCKED_DETAIL)
    return None


def login(
    database: Database,
    account_type: str,
    username: str,
    password: str,
    *,
    audit: Optional[AuditContext] = None,
) -> TokenGrant:
    """Authenticate one account, committing the outcome either way.

    See the module docstring for why the failure is raised after the block.
    """

    failure: Optional[ServiceError] = None
    grant: Optional[TokenGrant] = None
    with database.session() as session:
        model: Admin | User | None
        if account_type == "admin":
            model = admins_repo.find_by_username(session, username)
        else:
            model = users_repo.find_by_username(session, username)
        if model is None:
            failure = _reject(
                session,
                audit,
                account_type,
                username,
                "账号不存在",
                AuthenticationError(INVALID_CREDENTIALS_DETAIL),
            )
        else:
            failure = _refuse_login(session, audit, account_type, model, password)
        if failure is None and model is not None:
            if password_needs_rehash(model.password_hash):
                # Upgrade the stored hash silently; the old format is never exposed.
                model.password_hash = hash_password(password)
            _mark_login(model, audit.ip if audit else None)
            ttl = get_settings().access_token_ttl_seconds
            token, expires = create_access_token(
                account_type, model.id, int(model.token_version or 1), ttl
            )
            record(session, audit.for_account(account_type, model) if audit else None, "LOGIN", "登录成功")
            grant = TokenGrant(
                payload=_token_payload(account_type, model, token, expires),
                token=token,
                ttl_seconds=ttl,
            )
    if failure is not None:
        raise failure
    assert grant is not None
    return grant


def logout(
    database: Database,
    account_type: str,
    account_id: int | str,
    *,
    audit: Optional[AuditContext] = None,
) -> None:
    """Invalidate every token issued to the account and log the event."""

    with database.session() as session:
        model: Admin | User | None
        if account_type == "admin":
            model = admins_repo.get_active(session, account_id)
        else:
            model = users_repo.get_active(session, account_id)
        if model is not None:
            model.token_version = int(model.token_version or 1) + 1
        record(session, audit, "LOGOUT", "退出登录")


def change_password(
    database: Database,
    user_id: int | str,
    current_password: str,
    new_password: str,
    *,
    audit: Optional[AuditContext] = None,
) -> None:
    """Desktop-user self-service password change.

    A wrong current password still has to commit its ``FAILED`` audit row, so
    this uses the same commit-then-raise shape as :func:`login`.
    """

    failure: Optional[ServiceError] = None
    with database.session() as session:
        model = users_repo.get_active(session, user_id)
        if model is None or not verify_password(current_password, model.password_hash):
            record(session, audit, "CHANGE_PASSWORD", "修改密码失败", status="FAILED")
            failure = BadRequestError(WRONG_CURRENT_PASSWORD_DETAIL)
        else:
            apply_changes(
                session, model, {"password": new_password, "must_change_password": False}
            )
            record(session, audit, "CHANGE_PASSWORD", "修改密码成功")
    if failure is not None:
        raise failure


__all__ = [
    "TokenGrant",
    "change_password",
    "find_admin_by_username",
    "load_account_model",
    "login",
    "logout",
]
