"""Platform management request bodies."""

from __future__ import annotations

from typing import Optional
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.uploads import normalize_upload_reference


def validate_platform_url(value: str) -> str:
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
        return validate_platform_url(value)

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
        return validate_platform_url(value) if value is not None else None

    @field_validator("icon_url")
    @classmethod
    def validate_optional_icon_reference(cls, value: Optional[str]) -> Optional[str]:
        return normalize_upload_reference(value) if value is not None else None
