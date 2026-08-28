"""Vestus Python web administration and desktop-user authentication API.

Run from the repository root with::

    VESTUS_DATABASE_URL='mysql+pymysql://user:pass@127.0.0.1:3306/vestus?charset=utf8mb4' \
      VESTUS_SECRET_KEY='a-long-random-secret' uvicorn app:app --reload

The service creates account/audit tables and desktop proxy/platform assignment
tables. For local tests, explicitly set ``VESTUS_DATABASE_URL=sqlite:///...``.
MySQL remains
the default and a failed MySQL connection is reported by ``/healthz`` rather
than silently creating a second production database.
"""

from __future__ import annotations

import ipaddress
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

try:
    from dotenv import load_dotenv

    # The backend lives at the repository root, so ``.env`` sits next to this
    # module. Do not override values explicitly supplied by the process
    # environment.
    _project_env = Path(__file__).resolve().with_name(".env")
    load_dotenv(_project_env, override=False)
except ImportError:  # Direct environment variables still work without this optional convenience.
    pass

from db import Admin, Database, LastSuperAdminError, Platform, Proxy, User, UserLog, UserPlatformAssignment, UserProxyAssignment, _admin_dict, _log_dict, _user_dict, iso_datetime, parse_datetime, utc_now
from file_storage import EmptyUploadError, UploadTooLargeError, is_inline_safe, normalize_upload_reference, remove_stored_file, resolve_upload_path, store_upload
from security import create_access_token, decode_access_token, hash_password, password_needs_rehash, verify_password
from upload_middleware import UploadBodyLimitMiddleware


SESSION_COOKIE = "vestus_admin_session"
DEFAULT_TOKEN_TTL_SECONDS = 900
SAFE_HTTP_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


def _int_env(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
        return value if value > 0 else default
    except (TypeError, ValueError):
        return default


def _cors_origins() -> List[str]:
    raw = os.getenv("VESTUS_CORS_ORIGINS", "http://localhost:5174,http://127.0.0.1:5174")
    return [item.strip() for item in raw.split(",") if item.strip()]


def _product_name() -> str:
    value = os.getenv("VESTUS_PRODUCT_NAME", "Vestus").strip()
    if not value or len(value) > 100 or any(not character.isprintable() for character in value):
        return "Vestus"
    return value


db = Database()
app = FastAPI(title="Vestus Web Admin API", version="2.0.0", description="管理员管理桌面端用户和审计日志的 MySQL 后台")
app.add_middleware(CORSMiddleware, allow_origins=_cors_origins(), allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
app.add_middleware(UploadBodyLimitMiddleware)


@app.middleware("http")
async def security_headers(request: Request, call_next: Any) -> Response:
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.url.path in {"/admin", "/admin/"}:
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; connect-src 'self'; "
            "img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )
        response.headers.setdefault("Cache-Control", "no-store")
    return response


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)

    @field_validator("username")
    @classmethod
    def trim_username(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("username must not be empty")
        return value


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(alias="currentPassword", min_length=1, max_length=256)
    new_password: str = Field(alias="newPassword", min_length=6, max_length=256)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PasswordReset(BaseModel):
    password: str = Field(min_length=6, max_length=256)


class AdminCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=6, max_length=256)
    name: str = Field(min_length=1, max_length=100)
    role: str = Field(default="admin", pattern="^(admin|super_admin)$")
    status: str = Field(default="active", pattern="^(active|disabled)$")

    @field_validator("username", "name")
    @classmethod
    def trim_required(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value


class AdminUpdate(BaseModel):
    username: Optional[str] = Field(default=None, min_length=1, max_length=64)
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    role: Optional[str] = Field(default=None, pattern="^(admin|super_admin)$")
    status: Optional[str] = Field(default=None, pattern="^(active|disabled)$")

    @field_validator("username", "name")
    @classmethod
    def trim_optional(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=6, max_length=256)
    name: str = Field(min_length=1, max_length=100)
    company: Optional[str] = Field(default=None, max_length=200)
    phone: Optional[str] = Field(default=None, max_length=32)
    status: str = Field(default="active", pattern="^(active|disabled|locked)$")
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")
    max_sessions: int = Field(default=1, alias="maxSessions", ge=1, le=999)
    must_change_password: bool = Field(default=False, alias="mustChangePassword")
    remark: Optional[str] = Field(default=None, max_length=500)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("username", "name")
    @classmethod
    def trim_required(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

    @field_validator("expires_at")
    @classmethod
    def valid_expiry(cls, value: Optional[str]) -> Optional[str]:
        if value is not None:
            parse_datetime(value)
        return value


class UserUpdate(BaseModel):
    username: Optional[str] = Field(default=None, min_length=1, max_length=64)
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    company: Optional[str] = Field(default=None, max_length=200)
    phone: Optional[str] = Field(default=None, max_length=32)
    status: Optional[str] = Field(default=None, pattern="^(active|disabled|locked)$")
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")
    max_sessions: Optional[int] = Field(default=None, alias="maxSessions", ge=1, le=999)
    must_change_password: Optional[bool] = Field(default=None, alias="mustChangePassword")
    remark: Optional[str] = Field(default=None, max_length=500)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("username", "name")
    @classmethod
    def trim_optional(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

    @field_validator("expires_at")
    @classmethod
    def valid_expiry(cls, value: Optional[str]) -> Optional[str]:
        if value is not None:
            parse_datetime(value)
        return value


class SettingsUpdate(BaseModel):
    product_name: Optional[str] = Field(default=None, alias="productName")
    logo_url: Optional[str] = Field(default=None, alias="logoUrl")
    admin_title: Optional[str] = Field(default=None, alias="adminTitle")
    admin_logo_url: Optional[str] = Field(default=None, alias="adminLogoUrl")
    admin_theme_color: Optional[str] = Field(
        default=None,
        alias="adminThemeColor",
        pattern="^(blue|indigo|purple|emerald|amber|rose|cyan)$",
    )
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    @field_validator("logo_url", "admin_logo_url")
    @classmethod
    def validate_image_reference(cls, value: Optional[str]) -> Optional[str]:
        return normalize_upload_reference(value) if value is not None else None


MAX_BYPASS_HOSTS = 32
MAX_BYPASS_HOST_LENGTH = 253
MAX_BYPASS_LABEL_LENGTH = 63


def _validate_bypass_hosts(values: List[str]) -> List[str]:
    """Normalize the direct-connect exception list.

    The rules mirror ``desktop/src-tauri/src/bypass.rs`` exactly: the desktop
    client re-validates whatever it receives and refuses the whole configuration
    on any bad entry, so accepting something here that Rust rejects would only
    break the client.  ``host`` matches that host, ``*.host`` (or ``.host``)
    matches its subdomains and is stored in the ``*.`` form.

    IP literals and ``localhost`` are refused because a direct-connect entry
    bypasses the proxy entirely; a name that resolves to loopback is rejected
    again at connect time on the client.
    """
    if len(values) > MAX_BYPASS_HOSTS:
        raise ValueError(f"at most {MAX_BYPASS_HOSTS} direct-connect hosts are allowed")
    normalized: List[str] = []
    for raw in values:
        if not isinstance(raw, str):
            raise ValueError("direct-connect host must be a string")
        text = raw.strip()
        if not text:
            raise ValueError("direct-connect host must not be empty")
        if not text.isascii():
            raise ValueError(f"direct-connect host must be ASCII (use punycode): {text}")
        lowered = text.lower()
        if (
            "://" in lowered
            or "/" in lowered
            or "@" in lowered
            or ":" in lowered
            or any(character.isspace() or not character.isprintable() for character in lowered)
        ):
            raise ValueError(f"direct-connect host must be a bare hostname: {text}")

        subdomain_only = False
        if lowered.startswith("*."):
            host, subdomain_only = lowered[2:], True
        elif lowered.startswith("."):
            host, subdomain_only = lowered[1:], True
        else:
            host = lowered
        host = host.rstrip(".")

        if not host or len(host) > MAX_BYPASS_HOST_LENGTH:
            raise ValueError(f"direct-connect host length is invalid: {text}")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError(f"direct-connect list accepts hostnames, not IP addresses: {text}")
        if host == "localhost" or host.endswith(".localhost"):
            raise ValueError("direct-connect list must not contain localhost")
        if "." not in host:
            raise ValueError(f"direct-connect host must contain a dot: {text}")
        for label in host.split("."):
            if (
                not label
                or len(label) > MAX_BYPASS_LABEL_LENGTH
                or label.startswith("-")
                or label.endswith("-")
                or any(
                    not (character.isascii() and (character.isalnum() or character in "-_"))
                    for character in label
                )
            ):
                raise ValueError(f"direct-connect host is malformed: {text}")

        entry = f"*.{host}" if subdomain_only else host
        if entry not in normalized:
            normalized.append(entry)
    return normalized


class ProxyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=1024)
    bypass_hosts: List[str] = Field(default_factory=list, alias="bypassHosts")
    status: str = Field(default="active", pattern="^(active|disabled)$")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name")
    @classmethod
    def trim_proxy_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(not character.isprintable() for character in value):
            raise ValueError("value must not be empty")
        return value

    @field_validator("host")
    @classmethod
    def validate_proxy_host(cls, value: str) -> str:
        value = value.strip()
        if (
            not value
            or "://" in value
            or "/" in value
            or "@" in value
            or any(character.isspace() for character in value)
        ):
            raise ValueError("proxy host must be a bare IP address or hostname")
        return value

    @field_validator("username")
    @classmethod
    def trim_proxy_username(cls, value: str) -> str:
        value = value.strip()
        if not value or ":" in value:
            raise ValueError("proxy username must not be empty or contain a colon")
        return value

    @field_validator("bypass_hosts")
    @classmethod
    def normalize_bypass_hosts(cls, value: List[str]) -> List[str]:
        return _validate_bypass_hosts(value)


class ProxyUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    host: Optional[str] = Field(default=None, min_length=1, max_length=255)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    username: Optional[str] = Field(default=None, min_length=1, max_length=255)
    password: Optional[str] = Field(default=None, min_length=1, max_length=1024)
    bypass_hosts: Optional[List[str]] = Field(default=None, alias="bypassHosts")
    status: Optional[str] = Field(default=None, pattern="^(active|disabled)$")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name")
    @classmethod
    def trim_proxy_optional_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value or any(not character.isprintable() for character in value):
            raise ValueError("value must not be empty")
        return value

    @field_validator("host")
    @classmethod
    def validate_proxy_optional_host(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if (
            not value
            or "://" in value
            or "/" in value
            or "@" in value
            or any(character.isspace() for character in value)
        ):
            raise ValueError("proxy host must be a bare IP address or hostname")
        return value

    @field_validator("username")
    @classmethod
    def trim_proxy_optional_username(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value or ":" in value:
            raise ValueError("proxy username must not be empty or contain a colon")
        return value

    @field_validator("bypass_hosts")
    @classmethod
    def normalize_optional_bypass_hosts(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return None
        return _validate_bypass_hosts(value)


def _validate_platform_url(value: str) -> str:
    normalized = value.strip()
    if any(character.isspace() for character in normalized):
        raise ValueError("platform URL is invalid")
    try:
        parsed = urlsplit(normalized)
        # Accessing ``port`` detects malformed values such as ``:not-a-port``.
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("platform URL is invalid") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("platform URL must use http or https and must not contain credentials")
    return normalized


class PlatformCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    url: str = Field(min_length=1, max_length=2048)
    icon_url: Optional[str] = Field(default=None, alias="iconUrl", max_length=1_048_576)
    sort_order: int = Field(default=0, alias="sortOrder", ge=-1_000_000, le=1_000_000)
    status: str = Field(default="active", pattern="^(active|disabled)$")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name")
    @classmethod
    def trim_platform_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return _validate_platform_url(value)

    @field_validator("icon_url")
    @classmethod
    def validate_icon_reference(cls, value: Optional[str]) -> Optional[str]:
        return normalize_upload_reference(value) if value is not None else None


class PlatformUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    url: Optional[str] = Field(default=None, min_length=1, max_length=2048)
    icon_url: Optional[str] = Field(default=None, alias="iconUrl", max_length=1_048_576)
    sort_order: Optional[int] = Field(default=None, alias="sortOrder", ge=-1_000_000, le=1_000_000)
    status: Optional[str] = Field(default=None, pattern="^(active|disabled)$")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name")
    @classmethod
    def trim_platform_optional_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("value must not be empty")
        return value

    @field_validator("url")
    @classmethod
    def validate_optional_url(cls, value: Optional[str]) -> Optional[str]:
        return _validate_platform_url(value) if value is not None else None

    @field_validator("icon_url")
    @classmethod
    def validate_optional_icon_reference(cls, value: Optional[str]) -> Optional[str]:
        return normalize_upload_reference(value) if value is not None else None


def _client_ip(request: Request) -> str:
    # Only trust forwarding headers when explicitly enabled by deployment.
    if os.getenv("VESTUS_TRUST_PROXY", "0") == "1":
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()[:64]
    return request.client.host[:64] if request.client else "unknown"


def _request_id(request: Request) -> str:
    return request.headers.get("x-request-id", "")[:36] or os.urandom(16).hex()


def _auth_error(detail: str = "登录凭证无效或已过期") -> HTTPException:
    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def _extract_bearer_token(authorization: Optional[str]) -> Optional[str]:
    if authorization:
        scheme, _, value = authorization.partition(" ")
        if scheme.lower() == "bearer" and value.strip():
            return value.strip()
    return None


def _normalized_origin(value: str) -> Optional[tuple[str, str, int]]:
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


def _require_same_origin_for_cookie_auth(request: Request) -> None:
    if request.method.upper() in SAFE_HTTP_METHODS:
        return
    supplied_origin = _normalized_origin(request.headers.get("origin", ""))
    current_origin = _normalized_origin(str(request.base_url))
    if supplied_origin is None or supplied_origin != current_origin:
        raise HTTPException(status_code=403, detail="Cookie 认证的写请求来源无效")


def _safe_int_subject(value: Any) -> int:
    try:
        result = int(value)
        if result <= 0:
            raise ValueError
        return result
    except (TypeError, ValueError) as exc:
        raise _auth_error() from exc


async def current_account(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    admin_cookie: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
) -> Dict[str, Any]:
    bearer_token = _extract_bearer_token(authorization)
    raw = bearer_token or admin_cookie
    if not raw:
        raise _auth_error("需要登录后才能访问此资源")
    try:
        claims = decode_access_token(raw)
    except ValueError:
        raise _auth_error()
    account_type, account_id = claims["typ"], _safe_int_subject(claims["sub"])
    if account_type == "admin":
        model = db.get_admin_model(account_id)
    else:
        model = db.get_user_model(account_id)
    if model is None or model.deleted_at is not None:
        raise _auth_error()
    if int(model.token_version or 1) != int(claims.get("tv", 0)):
        raise _auth_error("登录凭证已失效，请重新登录")
    if model.status != "active":
        raise HTTPException(status_code=403, detail="账号已被禁用或锁定")
    if isinstance(model, User) and model.expires_at is not None and utc_now() >= model.expires_at:
        raise HTTPException(status_code=403, detail="账号授权已过期")
    if isinstance(model, User) and model.locked_until is not None:
        if utc_now() < model.locked_until:
            raise HTTPException(status_code=403, detail="账号暂时锁定")
    if account_type == "admin" and bearer_token is None:
        _require_same_origin_for_cookie_auth(request)
    return {"type": account_type, "id": account_id, "model": model, "claims": claims, "ip": _client_ip(request), "request_id": _request_id(request), "user_agent": request.headers.get("user-agent", "")[:512]}


async def admin_auth(auth: Dict[str, Any] = Depends(current_account)) -> Dict[str, Any]:
    if auth["type"] != "admin":
        raise HTTPException(status_code=403, detail="仅管理员可执行此操作")
    return auth


async def super_admin_auth(auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    if auth["model"].role != "super_admin":
        raise HTTPException(status_code=403, detail="仅超级管理员可管理管理员账号")
    return auth


async def user_auth(auth: Dict[str, Any] = Depends(current_account)) -> Dict[str, Any]:
    if auth["type"] != "user":
        raise HTTPException(status_code=403, detail="仅桌面端用户可访问此资源")
    return auth


def _token_response(account_type: str, model: Any, token: str, expires: int) -> Dict[str, Any]:
    result: Dict[str, Any] = {"access_token": token, "accessToken": token, "token_type": "bearer", "expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat(), "expiresAt": datetime.fromtimestamp(expires, timezone.utc).isoformat()}
    result["admin" if account_type == "admin" else "user"] = _admin_dict(model) if account_type == "admin" else _user_dict(model)
    return result


def _log(auth: Optional[Dict[str, Any]], request: Request, action: str, summary: str, result: str = "SUCCESS", **kwargs: Any) -> None:
    try:
        model = auth.get("model") if auth else None
        db.add_log(actor_type=auth["type"] if auth else "system", actor_id=auth.get("id") if auth else None, actor_username=getattr(model, "username", None), actor_role=getattr(model, "role", None), action=action, summary=summary, ip=_client_ip(request), user_agent=request.headers.get("user-agent"), status=result, request_id=_request_id(request), **kwargs)
    except SQLAlchemyError:
        # A failed audit write must not leak a database traceback to clients.
        pass


def _login_failure(request: Request, account_type: str, username: str, summary: str, model: Any = None) -> None:
    auth = {"type": account_type, "id": getattr(model, "id", None), "model": model} if model else None
    _log(auth, request, "LOGIN", f"{username}: {summary}", "FAILED")


def _login(account_type: str, payload: LoginRequest, request: Request, response: Response) -> Dict[str, Any]:
    model = db.find_admin_by_username(payload.username) if account_type == "admin" else db.find_user_by_username(payload.username)
    if model is None:
        _login_failure(request, account_type, payload.username, "账号不存在")
        raise HTTPException(status_code=401, detail="账号或密码错误")
    if not verify_password(payload.password, model.password_hash):
        db.record_failed_login(
            account_type,
            model.id,
            max_attempts=_int_env("VESTUS_LOGIN_MAX_ATTEMPTS", 5),
            lock_minutes=_int_env("VESTUS_LOGIN_LOCK_MINUTES", 15),
        )
        _login_failure(request, account_type, model.username, "密码错误", model)
        raise HTTPException(status_code=401, detail="账号或密码错误")
    if model.status != "active":
        _login_failure(request, account_type, model.username, "账号不可用", model)
        raise HTTPException(status_code=403, detail="账号已被禁用或锁定")
    if isinstance(model, User) and model.expires_at is not None and utc_now() >= model.expires_at:
        _login_failure(request, account_type, model.username, "账号已过期", model)
        raise HTTPException(status_code=403, detail="账号授权已过期")
    if isinstance(model, User) and model.locked_until is not None and utc_now() < model.locked_until:
        raise HTTPException(status_code=403, detail="账号暂时锁定")
    if password_needs_rehash(model.password_hash):
        # Rehash on successful login, without exposing the old format.
        with db.session() as session:
            fresh = session.get(Admin if account_type == "admin" else User, model.id)
            if fresh:
                fresh.password_hash = hash_password(payload.password)
    if account_type == "admin":
        db.mark_admin_login(model.id, _client_ip(request))
    else:
        db.mark_user_login(model.id, _client_ip(request))
    ttl = _int_env("VESTUS_ACCESS_TOKEN_TTL_SECONDS", DEFAULT_TOKEN_TTL_SECONDS)
    token, expires = create_access_token(account_type, model.id, int(model.token_version or 1), ttl)
    _log({"type": account_type, "id": model.id, "model": model}, request, "LOGIN", "登录成功")
    if account_type == "admin":
        response.set_cookie(SESSION_COOKIE, token, max_age=ttl, httponly=True, secure=os.getenv("VESTUS_COOKIE_SECURE", "0") == "1", samesite="lax", path="/")
    return _token_response(account_type, model, token, expires)


@app.get("/", tags=["system"])
async def root() -> Dict[str, str]:
    return {"service": "vestus", "status": "ok", "docs": "/docs"}


@app.get("/healthz", tags=["system"])
async def healthz() -> Dict[str, Any]:
    # 反向代理会把这个端点暴露在公网且不带鉴权，所以只回存活状态。
    # 数据库地址、库名一律不外泄；本机排障请看 journalctl。
    ok = db.ping()
    return {"status": "ok" if ok else "degraded", "database": "ok" if ok else "unavailable"}


def _absolute_upload_reference(request: Request, relative_path: str) -> str:
    if not relative_path:
        return ""
    return f"{str(request.base_url).rstrip('/')}{relative_path}"


def _externalize_platform_icons(request: Request, result: Dict[str, Any]) -> None:
    for platform in result.get("platforms", []):
        platform["iconUrl"] = _absolute_upload_reference(
            request, platform.get("iconUrl", "")
        )


@app.get("/api/product", tags=["system"])
async def product(request: Request, response: Response) -> Dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    branding = db.get_branding()
    return {
        "productName": branding["productName"],
        "logoUrl": _absolute_upload_reference(
            request, branding.get("logoUrl", "")
        ),
    }


def _uploaded_file_response(request: Request, item: Dict[str, Any]) -> Dict[str, Any]:
    relative_path = item["path"]
    return {**item, "url": f"{str(request.base_url).rstrip('/')}{relative_path}"}


@app.post("/api/admin/uploads", status_code=201, tags=["uploads"])
async def upload_file(
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
) -> Dict[str, Any]:
    async with request.form(max_files=1, max_fields=0) as form:
        files = form.getlist("file")
        if len(files) != 1 or not isinstance(files[0], UploadFile):
            raise HTTPException(status_code=422, detail="必须提供唯一的 file 文件字段")
        file = files[0]
        original_name = Path((file.filename or "file").replace("\\", "/")).name[:255] or "file"
        content_type = (file.content_type or "application/octet-stream").strip()[:255] or "application/octet-stream"
        try:
            stored = await run_in_threadpool(store_upload, file)
        except EmptyUploadError as exc:
            raise HTTPException(status_code=400, detail="上传文件不能为空") from exc
        except UploadTooLargeError as exc:
            raise HTTPException(status_code=413, detail="上传文件超过大小限制") from exc
        except OSError as exc:
            raise HTTPException(status_code=507, detail="文件存储空间不可用") from exc

    try:
        item = await run_in_threadpool(
            db.create_uploaded_file,
            original_name=original_name,
            path=stored.relative_path,
            content_type=content_type,
            size=stored.size,
            uploaded_by=auth["id"],
        )
    except Exception:
        await run_in_threadpool(remove_stored_file, stored.relative_path)
        raise
    return _uploaded_file_response(request, item)


@app.get("/uploads/{file_path:path}", tags=["uploads"])
async def uploaded_file(file_path: str) -> Response:
    relative_path = f"/uploads/{file_path}"
    item = db.get_uploaded_file_by_path(relative_path)
    if item is None:
        raise HTTPException(status_code=404, detail="文件不存在")
    try:
        absolute_path = resolve_upload_path(relative_path)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="文件不存在") from exc
    if not absolute_path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    disposition = "inline" if is_inline_safe(relative_path, item["contentType"]) else "attachment"
    return FileResponse(
        absolute_path,
        media_type=item["contentType"],
        filename=item["name"],
        content_disposition_type=disposition,
    )


@app.get("/api/admin/settings", tags=["system"])
async def get_admin_settings(auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    return db.get_branding()


@app.put("/api/admin/settings", tags=["system"])
@app.post("/api/admin/settings", tags=["system"])
async def update_admin_settings(
    payload: SettingsUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
) -> Dict[str, Any]:
    name = (payload.product_name or "").strip() if payload.product_name is not None else None
    if name and (len(name) > 100 or any(not c.isprintable() for c in name)):
        raise HTTPException(status_code=400, detail="桌面端产品名称格式无效")
    admin_title = (payload.admin_title or "").strip() if payload.admin_title is not None else None
    if admin_title and (len(admin_title) > 100 or any(not c.isprintable() for c in admin_title)):
        raise HTTPException(status_code=400, detail="管理端系统名称格式无效")

    try:
        branding = db.set_branding(
            product_name=name,
            logo_url=payload.logo_url,
            admin_title=admin_title,
            admin_logo_url=payload.admin_logo_url,
            admin_theme_color=payload.admin_theme_color,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _log(
        auth,
        request,
        "SYSTEM_SETTINGS_UPDATE",
        f"更新系统配置：桌面端产品名称为 {branding['productName']}，管理端名称为 {branding['adminTitle']}",
        target_type="system",
        target_name="branding",
    )
    return branding


# ---- Authentication -----------------------------------------------------------------------
@app.post("/api/admin/auth/login", tags=["admin-auth"])
async def admin_login(payload: LoginRequest, request: Request, response: Response) -> Dict[str, Any]:
    return _login("admin", payload, request, response)


@app.post("/api/user/auth/login", tags=["user-auth"])
async def user_login(payload: LoginRequest, request: Request, response: Response) -> Dict[str, Any]:
    return _login("user", payload, request, response)


@app.get("/api/admin/auth/me", tags=["admin-auth"])
async def admin_me(auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    return _admin_dict(auth["model"])


@app.get("/api/user/auth/me", tags=["user-auth"])
async def user_me(auth: Dict[str, Any] = Depends(user_auth)) -> Dict[str, Any]:
    return _user_dict(auth["model"])


@app.get("/api/user/desktop-config", tags=["desktop-config"])
async def user_desktop_config(
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(user_auth),
) -> Dict[str, Any]:
    # This response contains the reversible upstream credential for the Rust
    # process. It must never be cached by a browser, reverse proxy or CDN.
    response.headers["Cache-Control"] = "no-store"
    result = db.get_user_desktop_config_with_lease(auth["id"])
    if result is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    _externalize_platform_icons(request, result)
    _log(auth, request, "DESKTOP_CONFIG_READ", "读取桌面配置")
    return result


@app.get("/api/user/desktop-config/lease", tags=["desktop-config"])
async def user_desktop_config_lease(
    response: Response,
    auth: Dict[str, Any] = Depends(user_auth),
) -> Dict[str, str]:
    response.headers["Cache-Control"] = "no-store"
    lease = db.get_user_desktop_lease(auth["id"])
    if lease is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {"lease": lease}


@app.post("/api/admin/auth/logout", tags=["admin-auth"])
async def admin_logout(request: Request, response: Response, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, bool]:
    db.bump_token_version("admin", auth["id"])
    _log(auth, request, "LOGOUT", "退出登录")
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"success": True}


@app.post("/api/user/auth/logout", tags=["user-auth"])
async def user_logout(request: Request, auth: Dict[str, Any] = Depends(user_auth)) -> Dict[str, bool]:
    db.bump_token_version("user", auth["id"])
    _log(auth, request, "LOGOUT", "退出登录")
    return {"success": True}


@app.post("/api/user/auth/change-password", tags=["user-auth"])
async def user_change_password(payload: ChangePasswordRequest, request: Request, auth: Dict[str, Any] = Depends(user_auth)) -> Dict[str, bool]:
    if not verify_password(payload.current_password, auth["model"].password_hash):
        _log(auth, request, "CHANGE_PASSWORD", "修改密码失败", "FAILED")
        raise HTTPException(status_code=400, detail="当前密码错误")
    db.update_user(auth["id"], {"password": payload.new_password, "must_change_password": False})
    _log(auth, request, "CHANGE_PASSWORD", "修改密码成功")
    return {"success": True}


# Legacy aliases used by the first desktop/admin prototypes.
@app.post("/api/auth/login", include_in_schema=False)
async def legacy_login(payload: LoginRequest, request: Request, response: Response) -> Dict[str, Any]:
    # The old endpoint accepted either account type.  Preserve that behavior
    # while returning the old `user` field as well.
    model = db.find_admin_by_username(payload.username)
    account_type = "admin" if model else "user"
    result = _login(account_type, payload, request, response)
    if "admin" in result:
        result["user"] = result["admin"]
    return result


@app.get("/api/auth/me", include_in_schema=False)
async def legacy_me(auth: Dict[str, Any] = Depends(current_account)) -> Dict[str, Any]:
    return _admin_dict(auth["model"]) if auth["type"] == "admin" else _user_dict(auth["model"])


@app.post("/api/auth/logout", include_in_schema=False)
async def legacy_logout(request: Request, response: Response, auth: Dict[str, Any] = Depends(current_account)) -> Dict[str, bool]:
    db.bump_token_version(auth["type"], auth["id"])
    _log(auth, request, "LOGOUT", "退出登录")
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"success": True}


# ---- Administrator management -------------------------------------------------------------
@app.get("/api/admin/admins", tags=["admins"])
async def list_admins(search: Optional[str] = Query(default=None, max_length=100), status_filter: Optional[str] = Query(default=None, alias="status"), _auth: Dict[str, Any] = Depends(super_admin_auth)) -> List[Dict[str, Any]]:
    return db.list_admins(search, status_filter)


@app.post("/api/admin/admins", status_code=201, tags=["admins"])
async def create_admin(payload: AdminCreate, request: Request, auth: Dict[str, Any] = Depends(super_admin_auth)) -> Dict[str, Any]:
    try:
        result = db.insert_admin(payload.model_dump())
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="管理员账号名已存在") from exc
    _log(auth, request, "ADMIN_CREATE", f"创建管理员 {result['username']}", target_type="admin", target_id=result["id"], target_name=result["username"])
    return result


@app.get("/api/admin/admins/{admin_id}", tags=["admins"])
async def get_admin(admin_id: int, _auth: Dict[str, Any] = Depends(super_admin_auth)) -> Dict[str, Any]:
    result = db.get_admin(admin_id)
    if result is None: raise HTTPException(status_code=404, detail="管理员不存在")
    return result


@app.patch("/api/admin/admins/{admin_id}", tags=["admins"])
async def update_admin(admin_id: int, payload: AdminUpdate, request: Request, auth: Dict[str, Any] = Depends(super_admin_auth)) -> Dict[str, Any]:
    existing = db.get_admin_model(admin_id)
    if existing is None: raise HTTPException(status_code=404, detail="管理员不存在")
    changes = payload.model_dump(exclude_unset=True)
    if admin_id == auth["id"] and changes.get("status") == "disabled":
        raise HTTPException(status_code=400, detail="不能停用当前登录管理员")
    if changes.get("role") == "admin" and existing.role == "super_admin":
        with db.session() as session:
            count = session.scalar(select(func.count(Admin.id)).where(Admin.role == "super_admin", Admin.status == "active", Admin.deleted_at.is_(None))) or 0
            if int(count) <= 1: raise HTTPException(status_code=400, detail="不能降级唯一的超级管理员")
    if changes.get("status") == "disabled" and existing.role == "super_admin" and existing.status == "active":
        with db.session() as session:
            count = session.scalar(select(func.count(Admin.id)).where(Admin.role == "super_admin", Admin.status == "active", Admin.deleted_at.is_(None))) or 0
            if int(count) <= 1: raise HTTPException(status_code=400, detail="不能停用唯一的超级管理员")
    try:
        result = db.update_admin(admin_id, changes)
    except LastSuperAdminError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="管理员账号名已存在") from exc
    if result is None: raise HTTPException(status_code=404, detail="管理员不存在")
    _log(auth, request, "ADMIN_UPDATE", f"更新管理员 {result['username']}", target_type="admin", target_id=admin_id, target_name=result["username"], details={"fields": list(changes)})
    return result


@app.post("/api/admin/admins/{admin_id}/enable", tags=["admins"])
async def enable_admin(admin_id: int, request: Request, auth: Dict[str, Any] = Depends(super_admin_auth)) -> Dict[str, Any]:
    try:
        result = db.set_admin_status(admin_id, "active")
    except LastSuperAdminError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if result is None: raise HTTPException(status_code=404, detail="管理员不存在")
    _log(auth, request, "ADMIN_ENABLE", f"启用管理员 {result['username']}", target_type="admin", target_id=admin_id, target_name=result["username"])
    return result


@app.post("/api/admin/admins/{admin_id}/disable", tags=["admins"])
async def disable_admin(admin_id: int, request: Request, auth: Dict[str, Any] = Depends(super_admin_auth)) -> Dict[str, Any]:
    if admin_id == auth["id"]: raise HTTPException(status_code=400, detail="不能停用当前登录管理员")
    existing = db.get_admin_model(admin_id)
    if existing is None: raise HTTPException(status_code=404, detail="管理员不存在")
    if existing.role == "super_admin":
        with db.session() as session:
            count = session.scalar(select(func.count(Admin.id)).where(Admin.role == "super_admin", Admin.status == "active", Admin.deleted_at.is_(None))) or 0
            if int(count) <= 1: raise HTTPException(status_code=400, detail="不能停用唯一的超级管理员")
    try:
        result = db.set_admin_status(admin_id, "disabled")
    except LastSuperAdminError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _log(auth, request, "ADMIN_DISABLE", f"停用管理员 {existing.username}", target_type="admin", target_id=admin_id, target_name=existing.username)
    return result or {}


@app.post("/api/admin/admins/{admin_id}/reset-password", tags=["admins"])
@app.post("/api/admin/admins/{admin_id}/password", include_in_schema=False)
async def reset_admin_password(admin_id: int, payload: PasswordReset, request: Request, auth: Dict[str, Any] = Depends(super_admin_auth)) -> Dict[str, bool]:
    existing = db.get_admin(admin_id)
    if existing is None: raise HTTPException(status_code=404, detail="管理员不存在")
    db.update_admin(admin_id, {"password": payload.password})
    _log(auth, request, "ADMIN_RESET_PASSWORD", f"重置管理员 {existing['username']} 密码", target_type="admin", target_id=admin_id, target_name=existing["username"])
    return {"success": True}


@app.delete("/api/admin/admins/{admin_id}", tags=["admins"])
async def delete_admin(admin_id: int, request: Request, auth: Dict[str, Any] = Depends(super_admin_auth)) -> Dict[str, bool]:
    if admin_id == auth["id"]:
        raise HTTPException(status_code=400, detail="不能删除当前登录管理员")
    existing = db.get_admin(admin_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="管理员不存在")
    try:
        deleted = db.soft_delete_admin(admin_id)
    except LastSuperAdminError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if deleted:
        _log(auth, request, "ADMIN_DELETE", f"删除管理员 {existing['username']}", target_type="admin", target_id=admin_id, target_name=existing["username"])
    return {"success": deleted}


# ---- Desktop proxy and platform management -----------------------------------------------
@app.get("/api/admin/proxies", tags=["desktop-config"])
async def list_proxies(_auth: Dict[str, Any] = Depends(admin_auth)) -> List[Dict[str, Any]]:
    return db.list_proxies()


@app.post("/api/admin/proxies", status_code=201, tags=["desktop-config"])
async def create_proxy(payload: ProxyCreate, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    try:
        result = db.insert_proxy(payload.model_dump())
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="代理名称已存在") from exc
    _log(
        auth, request, "PROXY_CREATE", f"创建代理 {result['name']}",
        target_type="proxy", target_id=result["id"], target_name=result["name"],
    )
    return result


@app.patch("/api/admin/proxies/{proxy_id}", tags=["desktop-config"])
async def update_proxy(proxy_id: int, payload: ProxyUpdate, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail="至少提供一个待更新字段")
    try:
        result = db.update_proxy(proxy_id, changes)
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="代理名称已存在") from exc
    if result is None:
        raise HTTPException(status_code=404, detail="代理不存在")
    safe_fields = [field for field in changes if field != "password"]
    _log(
        auth, request, "PROXY_UPDATE", f"更新代理 {result['name']}",
        target_type="proxy", target_id=proxy_id, target_name=result["name"],
        details={"fields": safe_fields, "passwordChanged": "password" in changes},
    )
    return result


@app.get("/api/admin/platforms", tags=["desktop-config"])
async def list_platforms(_auth: Dict[str, Any] = Depends(admin_auth)) -> List[Dict[str, Any]]:
    return db.list_platforms()


@app.post("/api/admin/platforms", status_code=201, tags=["desktop-config"])
async def create_platform(payload: PlatformCreate, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    try:
        result = db.insert_platform(payload.model_dump(by_alias=False))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="平台名称已存在") from exc
    _log(
        auth, request, "PLATFORM_CREATE", f"创建平台 {result['name']}",
        target_type="platform", target_id=result["id"], target_name=result["name"],
    )
    return result


@app.patch("/api/admin/platforms/{platform_id}", tags=["desktop-config"])
async def update_platform(platform_id: int, payload: PlatformUpdate, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    changes = payload.model_dump(exclude_unset=True, by_alias=False)
    if not changes:
        raise HTTPException(status_code=400, detail="至少提供一个待更新字段")
    try:
        result = db.update_platform(platform_id, changes)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="平台名称已存在") from exc
    if result is None:
        raise HTTPException(status_code=404, detail="平台不存在")
    _log(
        auth, request, "PLATFORM_UPDATE", f"更新平台 {result['name']}",
        target_type="platform", target_id=platform_id, target_name=result["name"],
        details={"fields": list(changes)},
    )
    return result


@app.delete("/api/admin/platforms/{platform_id}", tags=["desktop-config"])
async def delete_platform(platform_id: int, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, bool]:
    platform = db.get_platform(platform_id)
    if platform is None:
        raise HTTPException(status_code=404, detail="平台不存在")
    target_name = platform["name"]
    success = db.delete_platform(platform_id)
    if not success:
        raise HTTPException(status_code=404, detail="平台不存在")
    _log(
        auth, request, "PLATFORM_DELETE", f"删除平台 {target_name}",
        target_type="platform", target_id=platform_id, target_name=target_name,
    )
    return {"success": True}


@app.delete("/api/admin/proxies/{proxy_id}", tags=["desktop-config"])
async def delete_proxy(proxy_id: int, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, bool]:
    proxy = db.get_proxy(proxy_id)
    if proxy is None:
        raise HTTPException(status_code=404, detail="代理不存在")
    target_name = proxy["name"]
    success = db.delete_proxy(proxy_id)
    if not success:
        raise HTTPException(status_code=404, detail="代理不存在")
    _log(
        auth, request, "PROXY_DELETE", f"删除代理 {target_name}",
        target_type="proxy", target_id=proxy_id, target_name=target_name,
    )
    return {"success": True}


# ---- Desktop-user management --------------------------------------------------------------
@app.get("/api/admin/users", tags=["users"])
async def list_users(search: Optional[str] = Query(default=None, max_length=100), status_filter: Optional[str] = Query(default=None, alias="status"), _auth: Dict[str, Any] = Depends(admin_auth)) -> List[Dict[str, Any]]:
    return db.list_users(search, status_filter)


@app.post("/api/admin/users", status_code=201, tags=["users"])
async def create_user(payload: UserCreate, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    try:
        values = payload.model_dump(by_alias=False)
        values["created_by"] = auth["id"]
        result = db.insert_user(values)
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="用户账号名已存在") from exc
    _log(auth, request, "USER_CREATE", f"创建用户 {result['username']}", target_type="user", target_id=result["id"], target_name=result["username"])
    return result


@app.get("/api/admin/users/{user_id}", tags=["users"])
async def get_user(user_id: int, _auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    result = db.get_user(user_id)
    if result is None: raise HTTPException(status_code=404, detail="用户不存在")
    return result


@app.patch("/api/admin/users/{user_id}", tags=["users"])
async def update_user(user_id: int, payload: UserUpdate, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    changes = payload.model_dump(exclude_unset=True, by_alias=False)
    try:
        result = db.update_user(user_id, changes)
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="用户账号名已存在") from exc
    if result is None: raise HTTPException(status_code=404, detail="用户不存在")
    _log(auth, request, "USER_UPDATE", f"更新用户 {result['username']}", target_type="user", target_id=user_id, target_name=result["username"], details={"fields": list(changes)})
    return result


@app.post("/api/admin/users/{user_id}/enable", tags=["users"])
async def enable_user(user_id: int, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    result = db.set_user_status(user_id, "active")
    if result is None: raise HTTPException(status_code=404, detail="用户不存在")
    _log(auth, request, "USER_ENABLE", f"启用用户 {result['username']}", target_type="user", target_id=user_id, target_name=result["username"])
    return result


@app.post("/api/admin/users/{user_id}/disable", tags=["users"])
async def disable_user(user_id: int, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    result = db.set_user_status(user_id, "disabled")
    if result is None: raise HTTPException(status_code=404, detail="用户不存在")
    _log(auth, request, "USER_DISABLE", f"停用用户 {result['username']}", target_type="user", target_id=user_id, target_name=result["username"])
    return result


@app.post("/api/admin/users/{user_id}/reset-password", tags=["users"])
@app.post("/api/admin/users/{user_id}/password", include_in_schema=False)
async def reset_user_password(user_id: int, payload: PasswordReset, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, bool]:
    existing = db.get_user(user_id)
    if existing is None: raise HTTPException(status_code=404, detail="用户不存在")
    db.update_user(user_id, {"password": payload.password, "must_change_password": False})
    _log(auth, request, "USER_RESET_PASSWORD", f"重置用户 {existing['username']} 密码", target_type="user", target_id=user_id, target_name=existing["username"])
    return {"success": True}


@app.delete("/api/admin/users/{user_id}", tags=["users"])
async def delete_user(user_id: int, request: Request, auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, bool]:
    existing = db.get_user(user_id)
    if existing is None: raise HTTPException(status_code=404, detail="用户不存在")
    deleted = db.soft_delete_user(user_id)
    if deleted: _log(auth, request, "USER_DELETE", f"删除用户 {existing['username']}", target_type="user", target_id=user_id, target_name=existing["username"])
    return {"success": deleted}


@app.get("/api/admin/users/{user_id}/desktop-config", tags=["desktop-config"], deprecated=True)
async def get_user_desktop_config(user_id: int, _auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    raise HTTPException(
        status_code=410,
        detail="桌面代理和平台已改为全局共享配置",
    )


@app.patch("/api/admin/users/{user_id}/desktop-config", tags=["desktop-config"], deprecated=True)
async def update_user_desktop_config(user_id: int, _auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    raise HTTPException(
        status_code=410,
        detail="桌面代理和平台已改为全局共享配置",
    )


@app.get("/api/admin/stats", tags=["users"])
async def admin_stats(_auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, int]:
    return db.stats()


# ---- Logs --------------------------------------------------------------------------------
@app.get("/api/admin/user-logs", tags=["logs"])
async def user_logs(page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200, alias="pageSize"), actor_type: Optional[str] = Query(None, alias="actorType"), actor_id: Optional[int] = Query(None, alias="actorId"), action: Optional[str] = None, log_status: Optional[str] = Query(None, alias="status"), target_id: Optional[int] = Query(None, alias="targetId"), start_at: Optional[str] = Query(None, alias="startAt"), end_at: Optional[str] = Query(None, alias="endAt"), _auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    items, total = db.list_logs(page=page, page_size=page_size, actor_type=actor_type, actor_id=actor_id, action=action, status=log_status, target_id=target_id, start_at=start_at, end_at=end_at)
    return {"items": items, "total": total, "page": page, "pageSize": page_size, "pages": math.ceil(total / page_size) if total else 0}


@app.get("/api/admin/user-logs/{log_id}", tags=["logs"])
async def user_log_detail(log_id: int, _auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    with db.session() as session:
        item = session.get(UserLog, log_id)
        if item is None: raise HTTPException(status_code=404, detail="日志不存在")
        return _log_dict(item)


@app.get("/api/admin/audit-logs", include_in_schema=False)
@app.get("/api/admin/logs", include_in_schema=False)
async def legacy_logs(limit: int = Query(100, ge=1, le=500), user_id: Optional[int] = Query(None), _auth: Dict[str, Any] = Depends(admin_auth)) -> List[Dict[str, Any]]:
    items, _ = db.list_logs(page=1, page_size=limit, actor_id=user_id)
    return items


@app.get("/api/client/me", include_in_schema=False)
async def client_me(auth: Dict[str, Any] = Depends(user_auth)) -> Dict[str, Any]:
    return _user_dict(auth["model"])


@app.get("/api/client/resource", include_in_schema=False)
async def protected_resource(auth: Dict[str, Any] = Depends(user_auth)) -> Dict[str, Any]:
    return {"authenticated": True, "user": _user_dict(auth["model"]), "serverTime": iso_datetime(utc_now())}


WEB_DIST_DIR = Path(__file__).resolve().parent / "web" / "dist"
ADMIN_DIST_PAGE = WEB_DIST_DIR / "index.html"
ADMIN_FALLBACK_PAGE = Path(__file__).resolve().parent / "web" / "admin.html"

if (WEB_DIST_DIR / "assets").is_dir():
    from starlette.staticfiles import StaticFiles
    app.mount("/assets", StaticFiles(directory=str(WEB_DIST_DIR / "assets")), name="admin_assets")


@app.get("/admin", include_in_schema=False)
async def admin_page() -> Response:
    page_to_serve = ADMIN_DIST_PAGE if ADMIN_DIST_PAGE.exists() else ADMIN_FALLBACK_PAGE
    if not page_to_serve.exists(): return JSONResponse({"detail": "admin page unavailable"}, status_code=404)
    return FileResponse(page_to_serve, media_type="text/html; charset=utf-8")


@app.exception_handler(SQLAlchemyError)
async def sqlalchemy_error_handler(_request: Request, _exc: SQLAlchemyError) -> JSONResponse:
    return JSONResponse({"detail": "数据库暂时不可用"}, status_code=503)


if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False)
