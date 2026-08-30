"""Administrator management request bodies."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, field_validator


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
