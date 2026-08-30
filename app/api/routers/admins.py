"""Administrator management (super-administrator only)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api.deps import audit_context, get_db, super_admin_auth
from app.db.session import Database
from app.schemas.admins import AdminCreate, AdminUpdate
from app.schemas.auth import PasswordReset
from app.services import admins as admins_service
from app.services.admins import MISSING_ADMIN_DETAIL

router = APIRouter()


@router.get("/api/admin/admins", tags=["admins"])
def list_admins(
    search: Optional[str] = Query(default=None, max_length=100),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    _auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> List[Dict[str, Any]]:
    return admins_service.list_admins(db, search, status_filter)


@router.post("/api/admin/admins", status_code=201, tags=["admins"])
def create_admin(
    payload: AdminCreate,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return admins_service.create_admin(
        db, payload.model_dump(), audit=audit_context(request, auth)
    )


@router.get("/api/admin/admins/{admin_id}", tags=["admins"])
def get_admin(
    admin_id: int,
    _auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    result = admins_service.get_admin(db, admin_id)
    if result is None:
        raise HTTPException(status_code=404, detail=MISSING_ADMIN_DETAIL)
    return result


@router.patch("/api/admin/admins/{admin_id}", tags=["admins"])
def update_admin(
    admin_id: int,
    payload: AdminUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return admins_service.update_admin(
        db,
        admin_id,
        payload.model_dump(exclude_unset=True),
        actor_admin_id=auth["id"],
        audit=audit_context(request, auth),
    )


@router.post("/api/admin/admins/{admin_id}/enable", tags=["admins"])
def enable_admin(
    admin_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return admins_service.enable_admin(db, admin_id, audit=audit_context(request, auth))


@router.post("/api/admin/admins/{admin_id}/disable", tags=["admins"])
def disable_admin(
    admin_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return admins_service.disable_admin(
        db, admin_id, actor_admin_id=auth["id"], audit=audit_context(request, auth)
    )


@router.post("/api/admin/admins/{admin_id}/reset-password", tags=["admins"])
@router.post("/api/admin/admins/{admin_id}/password", include_in_schema=False)
def reset_admin_password(
    admin_id: int,
    payload: PasswordReset,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, bool]:
    admins_service.reset_password(
        db, admin_id, payload.password, audit=audit_context(request, auth)
    )
    return {"success": True}


@router.delete("/api/admin/admins/{admin_id}", tags=["admins"])
def delete_admin(
    admin_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, bool]:
    deleted = admins_service.delete_admin(
        db, admin_id, actor_admin_id=auth["id"], audit=audit_context(request, auth)
    )
    return {"success": deleted}


__all__ = ["router"]
