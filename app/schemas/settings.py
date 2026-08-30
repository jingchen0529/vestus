"""Branding settings request body."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.uploads import normalize_upload_reference


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
