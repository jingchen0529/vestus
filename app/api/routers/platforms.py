"""Platform (shortcut) management."""

from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.deps import admin_auth, audit_context, get_db
from app.db.session import Database
from app.schemas.platforms import PlatformCreate, PlatformUpdate
from app.services import platforms as platforms_service

NO_FIELDS_DETAIL = "至少提供一个待更新字段"

router = APIRouter()


@router.get("/api/admin/platforms", tags=["desktop-config"])
def list_platforms(
    _auth: Dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db)
) -> List[Dict[str, Any]]:
    return platforms_service.list_platforms(db)


@router.post("/api/admin/platforms", status_code=201, tags=["desktop-config"])
def create_platform(
    payload: PlatformCreate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return platforms_service.create_platform(
        db, payload.model_dump(by_alias=False), audit=audit_context(request, auth)
    )


@router.patch("/api/admin/platforms/{platform_id}", tags=["desktop-config"])
def update_platform(
    platform_id: int,
    payload: PlatformUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    changes = payload.model_dump(exclude_unset=True, by_alias=False)
    if not changes:
        raise HTTPException(status_code=400, detail=NO_FIELDS_DETAIL)
    return platforms_service.update_platform(
        db, platform_id, changes, audit=audit_context(request, auth)
    )


@router.delete("/api/admin/platforms/{platform_id}", tags=["desktop-config"])
def delete_platform(
    platform_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, bool]:
    platforms_service.delete_platform(db, platform_id, audit=audit_context(request, auth))
    return {"success": True}


__all__ = ["router"]
