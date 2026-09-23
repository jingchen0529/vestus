"""Authentication request bodies."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.device import normalize_device_id


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    #: The machine identifier the desktop client read from the operating
    #: system.  Optional and never rejected -- see :mod:`app.core.device`.
    device_id: Optional[str] = Field(default=None, alias="deviceId")
    # ``extra="ignore"`` (the default) is deliberate here: desktop builds in the
    # field may send fields this server does not know yet, and a login must not
    # fail over that.  The activity upload keeps ``extra="forbid"``.
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    @field_validator("username")
    @classmethod
    def trim_username(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("username must not be empty")
        return value

    @field_validator("device_id")
    @classmethod
    def canonical_device_id(cls, value: Optional[str]) -> Optional[str]:
        return normalize_device_id(value)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(alias="currentPassword", min_length=1, max_length=256)
    new_password: str = Field(alias="newPassword", min_length=6, max_length=256)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PasswordReset(BaseModel):
    password: str = Field(min_length=6, max_length=256)
