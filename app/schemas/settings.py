"""Branding settings request body."""

from __future__ import annotations

import re
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.uploads import normalize_upload_reference

MAX_REPO_LENGTH = 100

#: ``owner/repo`` restricted to the characters GitHub itself accepts.  Lives
#: here rather than in the router because both the request body and the release
#: lookup validate against it, and they must agree: a value the settings form
#: accepts has to be one the lookup can still use.  ``..`` is refused
#: separately -- it satisfies the character class but reads as a parent
#: directory to anything that normalizes the URL path on the way to GitHub.
REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


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
    desktop_version: Optional[str] = Field(default=None, alias="desktopVersion", max_length=50)
    github_repo: Optional[str] = Field(default=None, alias="githubRepo", max_length=MAX_REPO_LENGTH)
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    @field_validator("logo_url", "admin_logo_url")
    @classmethod
    def validate_image_reference(cls, value: Optional[str]) -> Optional[str]:
        return normalize_upload_reference(value) if value is not None else None

    @field_validator("github_repo")
    @classmethod
    def validate_github_repo(cls, value: Optional[str]) -> Optional[str]:
        """Refuse a repository that the release lookup would reject later.

        Blank is allowed and means "fall back to the built-in default"; anything
        else has to be ``owner/repo``, so an invalid value is reported while the
        operator is still looking at the field rather than when the next release
        check fails.
        """
        if value is None:
            return None
        repo = value.strip()
        if not repo:
            return ""
        if ".." in repo or not REPO_PATTERN.match(repo):
            raise ValueError("GitHub 仓库名称格式无效，应为 owner/repo 格式")
        return repo
