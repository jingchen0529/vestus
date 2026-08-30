"""Request-scoped dependencies: the database handle, the caller and the audit context.

``current_account`` is a **sync** dependency on purpose.  It performs blocking
database I/O, so declaring it ``async`` would run that I/O on the event loop and
stall every other in-flight request; Starlette dispatches sync dependencies to a
threadpool instead.  The pure-predicate wrappers below stay ``async`` because
they only inspect the dictionary the account dependency already produced.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

from fastapi import Cookie, Depends, Header, HTTPException, Request

from app.core.security import decode_access_token
from app.db.base import utc_now
from app.db.models import User
from app.db.session import Database
from app.services import auth as auth_service
from app.services.audit import AuditContext

SESSION_COOKIE = "vestus_admin_session"
SAFE_HTTP_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}

INVALID_TOKEN_DETAIL = "登录凭证无效或已过期"
MISSING_TOKEN_DETAIL = "需要登录后才能访问此资源"
STALE_TOKEN_DETAIL = "登录凭证已失效，请重新登录"
ACCOUNT_UNAVAILABLE_DETAIL = "账号已被禁用或锁定"
ACCOUNT_EXPIRED_DETAIL = "账号授权已过期"
ACCOUNT_LOCKED_DETAIL = "账号暂时锁定"
CROSS_ORIGIN_COOKIE_DETAIL = "Cookie 认证的写请求来源无效"
ADMIN_ONLY_DETAIL = "仅管理员可执行此操作"
SUPER_ADMIN_ONLY_DETAIL = "仅超级管理员可管理管理员账号"
USER_ONLY_DETAIL = "仅桌面端用户可访问此资源"


def get_db(request: Request) -> Database:
    """The application's database handle, created once by ``create_app()``."""

    database: Database = request.app.state.db
    return database


def client_ip(request: Request) -> str:
    # Uvicorn validates trusted proxy peers and rewrites ASGI ``scope.client``.
    # Reading the raw forwarding header here would bypass that trust boundary.
    return request.client.host[:64] if request.client else "unknown"


def request_id(request: Request) -> str:
    return request.headers.get("x-request-id", "")[:36] or os.urandom(16).hex()


def auth_error(detail: str = INVALID_TOKEN_DETAIL) -> HTTPException:
    """A 401 that advertises the scheme; login failures deliberately do not."""

    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def extract_bearer_token(authorization: Optional[str]) -> Optional[str]:
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
    return None


def normalized_origin(value: str) -> Optional[Tuple[str, str, int]]:
    """Reduce an origin to ``(scheme, host, port)``, or ``None`` if unusable."""

    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname
    if (
        scheme not in {"http", "https"}
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return None
    return scheme, hostname.lower(), port or (443 if scheme == "https" else 80)


def require_same_origin_for_cookie_auth(request: Request) -> None:
    """CSRF guard for cookie-authenticated writes."""

    if request.method.upper() in SAFE_HTTP_METHODS:
        return
    supplied_origin = normalized_origin(request.headers.get("origin", ""))
    current_origin = normalized_origin(str(request.base_url))
    if supplied_origin is None or supplied_origin != current_origin:
        raise HTTPException(status_code=403, detail=CROSS_ORIGIN_COOKIE_DETAIL)


def safe_int_subject(value: Any) -> int:
    try:
        result = int(value)
        if result <= 0:
            raise ValueError
        return result
    except (TypeError, ValueError) as exc:
        raise auth_error() from exc


def audit_context(
    request: Request, auth: Optional[Dict[str, Any]] = None
) -> AuditContext:
    """Who is making this request, and from where.

    Authenticated routes reuse the values ``current_account`` already captured so
    every row written for one request shares a single request id.
    """

    if auth is None:
        return AuditContext(
            ip=client_ip(request),
            user_agent=request.headers.get("user-agent"),
            request_id=request_id(request),
        )
    model = auth.get("model")
    return AuditContext(
        actor_type=auth["type"],
        actor_id=auth.get("id"),
        actor_username=getattr(model, "username", None),
        actor_role=getattr(model, "role", None),
        ip=auth.get("ip"),
        user_agent=auth.get("user_agent"),
        request_id=auth.get("request_id"),
    )


def current_account(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    admin_cookie: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    """Resolve the bearer token or admin cookie into a live account row."""

    bearer_token = extract_bearer_token(authorization)
    raw = bearer_token or admin_cookie
    if not raw:
        raise auth_error(MISSING_TOKEN_DETAIL)
    try:
        claims = decode_access_token(raw)
    except ValueError:
        # The decode failure reason is deliberately not chained into the response.
        raise auth_error() from None
    account_type, account_id = claims["typ"], safe_int_subject(claims["sub"])
    model = auth_service.load_account_model(db, account_type, account_id)
    if model is None or model.deleted_at is not None:
        raise auth_error()
    if int(model.token_version or 1) != int(claims.get("tv", 0)):
        raise auth_error(STALE_TOKEN_DETAIL)
    if model.status != "active":
        raise HTTPException(status_code=403, detail=ACCOUNT_UNAVAILABLE_DETAIL)
    if isinstance(model, User) and model.expires_at is not None and utc_now() >= model.expires_at:
        raise HTTPException(status_code=403, detail=ACCOUNT_EXPIRED_DETAIL)
    if isinstance(model, User) and model.locked_until is not None and utc_now() < model.locked_until:
        raise HTTPException(status_code=403, detail=ACCOUNT_LOCKED_DETAIL)
    # A bearer token is not sent automatically by a browser, so only the cookie
    # path needs the CSRF check.
    if account_type == "admin" and bearer_token is None:
        require_same_origin_for_cookie_auth(request)
    return {
        "type": account_type,
        "id": account_id,
        "model": model,
        "claims": claims,
        "ip": client_ip(request),
        "request_id": request_id(request),
        "user_agent": request.headers.get("user-agent", "")[:512],
    }


async def admin_auth(auth: Dict[str, Any] = Depends(current_account)) -> Dict[str, Any]:
    if auth["type"] != "admin":
        raise HTTPException(status_code=403, detail=ADMIN_ONLY_DETAIL)
    return auth


async def super_admin_auth(auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    if auth["model"].role != "super_admin":
        raise HTTPException(status_code=403, detail=SUPER_ADMIN_ONLY_DETAIL)
    return auth


async def user_auth(auth: Dict[str, Any] = Depends(current_account)) -> Dict[str, Any]:
    if auth["type"] != "user":
        raise HTTPException(status_code=403, detail=USER_ONLY_DETAIL)
    return auth


__all__ = [
    "SAFE_HTTP_METHODS",
    "SESSION_COOKIE",
    "admin_auth",
    "audit_context",
    "auth_error",
    "client_ip",
    "current_account",
    "extract_bearer_token",
    "get_db",
    "normalized_origin",
    "request_id",
    "require_same_origin_for_cookie_auth",
    "safe_int_subject",
    "super_admin_auth",
    "user_auth",
]
