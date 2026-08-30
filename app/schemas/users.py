"""Desktop-user management request bodies."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.db.base import parse_datetime


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
