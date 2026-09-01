"""Branding settings.

``set_branding`` writes every key in **one** transaction.  The previous version
committed each key separately, so a rejected fifth value left the first four
applied -- a partially rebranded admin console with no way to tell what landed.
"""

from __future__ import annotations

from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db.session import Database
from app.repositories import settings as settings_repo
from app.repositories import uploads as uploads_repo
from app.schemas.serializers import safe_image_reference
from app.services.audit import AuditContext, record
from app.services.uploads import validated_image_reference

DEFAULT_ADMIN_TITLE = "Vestus Admin"
DEFAULT_ADMIN_THEME_COLOR = "blue"
#: Deliberately empty.  The server has no way to know which desktop build is
#: current -- the number lives in ``desktop/src-tauri/tauri.conf.json`` and is
#: stamped from the release tag -- so a default here could only be a guess that
#: goes stale on the next release.  Unset reads back as "" and the settings page
#: offers to fill it from the newest GitHub tag.
DEFAULT_DESKTOP_VERSION = ""
DEFAULT_GITHUB_REPO = "jingchen0529/vestus"

PRODUCT_NAME_KEY = "product_name"
PRODUCT_LOGO_KEY = "product_logo"
ADMIN_TITLE_KEY = "admin_title"
ADMIN_LOGO_KEY = "admin_logo"
ADMIN_THEME_COLOR_KEY = "admin_theme_color"
DESKTOP_VERSION_KEY = "desktop_version"
GITHUB_REPO_KEY = "github_repo"


def _read_branding(session: Session) -> Dict[str, str]:
    """Assemble the public branding payload from stored settings.

    An unset product name falls back to ``VESTUS_PRODUCT_NAME``.  Logo
    references are re-verified on every read: an upload that was deleted or
    replaced by a non-image must stop being served, not 404 in the client.
    """

    env_product = get_settings().resolved_product_name
    name = settings_repo.get_value(session, PRODUCT_NAME_KEY, env_product)
    logo = settings_repo.get_value(session, PRODUCT_LOGO_KEY, "")
    admin_title = settings_repo.get_value(session, ADMIN_TITLE_KEY, DEFAULT_ADMIN_TITLE)
    admin_logo = settings_repo.get_value(session, ADMIN_LOGO_KEY, "")
    admin_theme_color = settings_repo.get_value(
        session, ADMIN_THEME_COLOR_KEY, DEFAULT_ADMIN_THEME_COLOR
    )
    desktop_version = settings_repo.get_value(
        session, DESKTOP_VERSION_KEY, DEFAULT_DESKTOP_VERSION
    )
    github_repo = settings_repo.get_value(
        session, GITHUB_REPO_KEY, DEFAULT_GITHUB_REPO
    )
    uploaded_files = uploads_repo.map_by_paths(session, (logo, admin_logo))
    return {
        "productName": name if name else env_product,
        "logoUrl": safe_image_reference(logo, uploaded_files.get(logo)),
        "adminTitle": admin_title if admin_title else DEFAULT_ADMIN_TITLE,
        "adminLogoUrl": safe_image_reference(admin_logo, uploaded_files.get(admin_logo)),
        "adminThemeColor": admin_theme_color if admin_theme_color else DEFAULT_ADMIN_THEME_COLOR,
        "desktopVersion": desktop_version,
        "githubRepo": github_repo if github_repo else DEFAULT_GITHUB_REPO,
    }


def get_branding(database: Database) -> Dict[str, str]:
    with database.session() as session:
        return _read_branding(session)


def set_setting(database: Database, key: str, value: str) -> None:
    with database.session() as session:
        settings_repo.upsert(session, key, value)


def set_branding(
    database: Database,
    product_name: Optional[str] = None,
    logo_url: Optional[str] = None,
    admin_title: Optional[str] = None,
    admin_logo_url: Optional[str] = None,
    admin_theme_color: Optional[str] = None,
    desktop_version: Optional[str] = None,
    github_repo: Optional[str] = None,
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, str]:
    """Apply every supplied branding field atomically and return the result.

    Both logo references are validated before anything is written, so an
    invalid one rejects the whole request instead of half-applying it.
    """

    with database.session() as session:
        normalized_logo = logo_url
        normalized_admin_logo = admin_logo_url
        if logo_url is not None:
            normalized_logo, _uploaded_file = validated_image_reference(session, logo_url)
        if admin_logo_url is not None:
            normalized_admin_logo, _uploaded_file = validated_image_reference(
                session, admin_logo_url
            )

        if product_name is not None:
            settings_repo.upsert(session, PRODUCT_NAME_KEY, product_name.strip())
        if logo_url is not None:
            settings_repo.upsert(session, PRODUCT_LOGO_KEY, normalized_logo or "")
        if admin_title is not None:
            settings_repo.upsert(session, ADMIN_TITLE_KEY, admin_title.strip())
        if admin_logo_url is not None:
            settings_repo.upsert(session, ADMIN_LOGO_KEY, normalized_admin_logo or "")
        if admin_theme_color is not None:
            settings_repo.upsert(session, ADMIN_THEME_COLOR_KEY, admin_theme_color.strip())
        if desktop_version is not None:
            settings_repo.upsert(session, DESKTOP_VERSION_KEY, desktop_version.strip())
        if github_repo is not None:
            settings_repo.upsert(session, GITHUB_REPO_KEY, github_repo.strip())

        # ``autoflush`` is off, so the inserts must reach the database before
        # the payload is read back through a SELECT.
        session.flush()
        branding = _read_branding(session)
        detail = (
            f"更新系统配置：桌面端产品名称为 {branding['productName']}，"
            f"管理端名称为 {branding['adminTitle']}"
        )
        # Only mentioned when set: the version is optional, and "版本为 " with
        # nothing after it reads like the update cleared something.
        if branding.get("desktopVersion"):
            detail += f"，桌面端版本为 {branding['desktopVersion']}"
        record(
            session,
            audit,
            "SYSTEM_SETTINGS_UPDATE",
            detail,
            target_type="system",
            target_name="branding",
        )
        return branding


__all__ = ["get_branding", "set_branding", "set_setting"]
