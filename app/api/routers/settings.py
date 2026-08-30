"""Branding settings for the desktop client and the admin console."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.deps import admin_auth, audit_context, get_db
from app.db.session import Database
from app.schemas.settings import SettingsUpdate
from app.services import settings as settings_service

MAX_TITLE_LENGTH = 100

router = APIRouter()


def _validated_title(value: str | None, detail: str) -> str | None:
    """Trim a display name, refusing oversized or non-printable text."""

    if value is None:
        return None
    text = (value or "").strip()
    if text and (len(text) > MAX_TITLE_LENGTH or any(not c.isprintable() for c in text)):
        raise HTTPException(status_code=400, detail=detail)
    return text


@router.get("/api/admin/settings", tags=["system"])
def get_admin_settings(
    auth: Dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db)
) -> Dict[str, Any]:
    return settings_service.get_branding(db)


@router.put("/api/admin/settings", tags=["system"])
@router.post("/api/admin/settings", tags=["system"])
def update_admin_settings(
    payload: SettingsUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    name = _validated_title(payload.product_name, "桌面端产品名称格式无效")
    admin_title = _validated_title(payload.admin_title, "管理端系统名称格式无效")
    return settings_service.set_branding(
        db,
        product_name=name,
        logo_url=payload.logo_url,
        admin_title=admin_title,
        admin_logo_url=payload.admin_logo_url,
        admin_theme_color=payload.admin_theme_color,
        audit=audit_context(request, auth),
    )


__all__ = ["router"]
