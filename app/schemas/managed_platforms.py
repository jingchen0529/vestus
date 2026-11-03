"""Request validation for managed platform accounts and browser grants."""

from __future__ import annotations

from typing import Any, List, Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.db.base import parse_datetime


def _validate_allowed_hosts(values: List[str]) -> List[str]:
    result: List[str] = []
    for value in values:
        host = value.strip().lower()
        parsed = urlsplit(f"//{host}")
        if not host or parsed.hostname is None or parsed.path not in {"", "/"} or parsed.port:
            raise ValueError("allowedHosts contains an invalid host")
        if host not in result:
            result.append(host)
    return result


class ManagedCookie(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    value: str = Field(min_length=1, max_length=16_384)
    domain: str = Field(min_length=1, max_length=512)
    path: str = Field(default="/", min_length=1, max_length=2048)
    secure: bool = True
    http_only: bool = Field(default=False, alias="httpOnly")
    same_site: Optional[str] = Field(default=None, alias="sameSite")
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")
    partition_key: Optional[Any] = Field(default=None, alias="partitionKey")
    priority: Optional[str] = None
    source_scheme: Optional[str] = Field(default=None, alias="sourceScheme")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("domain")
    @classmethod
    def valid_domain(cls, value: str) -> str:
        value = value.strip().lower()
        if not value or any(ch.isspace() for ch in value) or "/" in value or ":" in value:
            raise ValueError("cookie domain is invalid")
        return value

    @field_validator("path")
    @classmethod
    def valid_path(cls, value: str) -> str:
        if not value.startswith("/"):
            raise ValueError("cookie path must start with '/'")
        return value

    @field_validator("same_site")
    @classmethod
    def valid_same_site(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in {"Strict", "Lax", "None", "strict", "lax", "none"}:
            raise ValueError("cookie sameSite is invalid")
        return value.title() if value else None

    @field_validator("expires_at")
    @classmethod
    def valid_expiry(cls, value: Optional[str]) -> Optional[str]:
        if value is not None:
            parse_datetime(value)
        return value


class ManagedPlatformAccountCreate(BaseModel):
    platform_id: int = Field(alias="platformId", ge=1)
    name: str = Field(min_length=1, max_length=100)
    auth_mode: str = Field(default="cookie", alias="authMode")
    username: Optional[str] = Field(default=None, max_length=256)
    password: Optional[str] = Field(default=None, max_length=512)
    cookie_bundle: Optional[List[ManagedCookie]] = Field(default=None, alias="cookieBundle", max_length=256)
    allowed_hosts: List[str] = Field(default_factory=list, alias="allowedHosts", max_length=64)
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")
    status: str = Field(default="active", pattern="^(active|expired|revoked|invalid)$")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name", "username")
    @classmethod
    def trim_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("auth_mode")
    @classmethod
    def valid_auth_mode(cls, value: str) -> str:
        if value not in {"cookie", "server_login", "official_sso"}:
            raise ValueError("authMode must be cookie, server_login or official_sso")
        return value

    @field_validator("allowed_hosts")
    @classmethod
    def valid_hosts(cls, values: List[str]) -> List[str]:
        return _validate_allowed_hosts(values)

    @field_validator("expires_at")
    @classmethod
    def valid_expiry(cls, value: Optional[str]) -> Optional[str]:
        if value is not None:
            parse_datetime(value)
        return value


class ManagedPlatformAccountUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    auth_mode: Optional[str] = Field(default=None, alias="authMode")
    username: Optional[str] = Field(default=None, max_length=256)
    password: Optional[str] = Field(default=None, max_length=512)
    cookie_bundle: Optional[List[ManagedCookie]] = Field(default=None, alias="cookieBundle", max_length=256)
    allowed_hosts: Optional[List[str]] = Field(default=None, alias="allowedHosts", max_length=64)
    expires_at: Optional[str] = Field(default=None, alias="expiresAt")
    status: Optional[str] = Field(default=None, pattern="^(active|expired|revoked|invalid)$")
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name", "username")
    @classmethod
    def trim_optional_text(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() if value is not None else None

    @field_validator("auth_mode")
    @classmethod
    def valid_optional_auth_mode(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in {"cookie", "server_login", "official_sso"}:
            raise ValueError("authMode must be cookie, server_login or official_sso")
        return value

    @field_validator("allowed_hosts")
    @classmethod
    def valid_hosts(cls, values: Optional[List[str]]) -> Optional[List[str]]:
        return _validate_allowed_hosts(values) if values is not None else None

    @field_validator("expires_at")
    @classmethod
    def valid_optional_expiry(cls, value: Optional[str]) -> Optional[str]:
        if value is not None:
            parse_datetime(value)
        return value


class ManagedBindingCreate(BaseModel):
    user_id: int = Field(alias="userId", ge=1)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ManagedAccountBindingCreate(BaseModel):
    managed_account_id: int = Field(alias="managedAccountId", ge=1)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ManagedPlatformUserConfig(BaseModel):
    """The reduced, user-scoped administrator configuration payload."""

    auth_mode: str = Field(alias="authMode")
    username: Optional[str] = Field(default=None, max_length=256)
    password: Optional[str] = Field(default=None, max_length=512)
    cookie_bundle: Optional[List[ManagedCookie]] = Field(default=None, alias="cookieBundle", max_length=256)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("username")
    @classmethod
    def trim_credentials(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("auth_mode")
    @classmethod
    def valid_user_auth_mode(cls, value: str) -> str:
        if value not in {"cookie", "server_login"}:
            raise ValueError("authMode must be cookie or server_login")
        return value

    @model_validator(mode="after")
    def require_selected_credentials(self) -> "ManagedPlatformUserConfig":
        if self.auth_mode == "server_login" and (not self.username or not self.password):
            raise ValueError("server_login 必须提供账号和密码")
        if self.auth_mode == "cookie" and not self.cookie_bundle:
            raise ValueError("cookie 模式必须提供 Cookie 包")
        return self


class ManagedPlatformUserAccountCreate(ManagedPlatformUserConfig):
    """Create a new Ark managed account and bind it to the target user."""

    name: Optional[str] = Field(default=None, max_length=100)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None


class ManagedPlatformUserAccountUpdate(BaseModel):
    """Update a specific bound managed account's alias and/or credentials."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    auth_mode: Optional[str] = Field(default=None, alias="authMode")
    username: Optional[str] = Field(default=None, max_length=256)
    password: Optional[str] = Field(default=None, max_length=512)
    cookie_bundle: Optional[List[ManagedCookie]] = Field(default=None, alias="cookieBundle", max_length=256)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("name", "username")
    @classmethod
    def trim_optional_fields(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("auth_mode")
    @classmethod
    def valid_optional_user_auth_mode(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in {"cookie", "server_login"}:
            raise ValueError("authMode must be cookie or server_login")
        return value


class ManagedBootstrapRequest(BaseModel):
    managed_account_id: Optional[int] = Field(default=None, alias="managedAccountId", ge=1)
    device_id: Optional[str] = Field(default=None, alias="deviceId", max_length=64)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ManagedBootstrapConsumeRequest(BaseModel):
    bootstrap_token: str = Field(alias="bootstrapToken", min_length=32, max_length=256)
    device_id: Optional[str] = Field(default=None, alias="deviceId", max_length=64)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class ManagedSessionExpiredRequest(BaseModel):
    managed_account_id: int = Field(alias="managedAccountId", strict=True, ge=1, le=2**63 - 1)
    credential_version: int = Field(alias="credentialVersion", strict=True, ge=1, le=2**31 - 1)
    session_id: str = Field(alias="sessionId", pattern=r"^[1-9][0-9]*$", max_length=19)
    device_id: Optional[str] = Field(default=None, alias="deviceId", max_length=64)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("session_id")
    @classmethod
    def valid_session_id(cls, value: str) -> str:
        if int(value) > 2**63 - 1:
            raise ValueError("sessionId is outside the supported range")
        return value


__all__ = [
    "ManagedAccountBindingCreate",
    "ManagedBindingCreate",
    "ManagedBootstrapConsumeRequest",
    "ManagedBootstrapRequest",
    "ManagedSessionExpiredRequest",
    "ManagedCookie",
    "ManagedPlatformAccountCreate",
    "ManagedPlatformAccountUpdate",
    "ManagedPlatformUserAccountCreate",
    "ManagedPlatformUserAccountUpdate",
    "ManagedPlatformUserConfig",
]
