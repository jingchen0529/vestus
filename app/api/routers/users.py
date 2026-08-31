"""Desktop-user management and the account statistics panel."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api.deps import admin_auth, audit_context, get_db
from app.api.envelope import EnvelopeRoute
from app.api.responses import collection
from app.db.session import Database
from app.schemas.auth import PasswordReset
from app.schemas.users import UserCreate, UserUpdate
from app.services import users as users_service
from app.services.users import MISSING_USER_DETAIL

DESKTOP_CONFIG_GONE_DETAIL = "桌面代理和平台已改为全局共享配置"

router = APIRouter(route_class=EnvelopeRoute)


@router.get("/api/admin/users", tags=["users"])
def list_users(
    search: Optional[str] = Query(default=None, max_length=100),
    status_filter: Optional[str] = Query(default=None, alias="status"),
    _auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return collection(users_service.list_users(db, search, status_filter))


@router.post("/api/admin/users", status_code=201, tags=["users"])
def create_user(
    payload: UserCreate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    values = payload.model_dump(by_alias=False)
    values["created_by"] = auth["id"]
    return users_service.create_user(db, values, audit=audit_context(request, auth))


@router.get("/api/admin/users/{user_id}", tags=["users"])
def get_user(
    user_id: int,
    _auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    result = users_service.get_user(db, user_id)
    if result is None:
        raise HTTPException(status_code=404, detail=MISSING_USER_DETAIL)
    return result


@router.patch("/api/admin/users/{user_id}", tags=["users"])
def update_user(
    user_id: int,
    payload: UserUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return users_service.update_user(
        db,
        user_id,
        payload.model_dump(exclude_unset=True, by_alias=False),
        audit=audit_context(request, auth),
    )


@router.post("/api/admin/users/{user_id}/enable", tags=["users"])
def enable_user(
    user_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return users_service.enable_user(db, user_id, audit=audit_context(request, auth))


@router.post("/api/admin/users/{user_id}/disable", tags=["users"])
def disable_user(
    user_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return users_service.disable_user(db, user_id, audit=audit_context(request, auth))


@router.post("/api/admin/users/{user_id}/reset-password", tags=["users"])
@router.post("/api/admin/users/{user_id}/password", include_in_schema=False)
def reset_user_password(
    user_id: int,
    payload: PasswordReset,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> None:
    # No payload: ``code == 0`` already says it worked, and the old
    # ``{"success": true}`` carried no information beyond that.
    users_service.reset_password(
        db, user_id, payload.password, audit=audit_context(request, auth)
    )


@router.delete("/api/admin/users/{user_id}", tags=["users"])
def delete_user(
    user_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> None:
    # The service raises NotFoundError when there is nothing to delete, so the
    # old ``{"success": deleted}`` could only ever report ``true``.
    users_service.delete_user(db, user_id, audit=audit_context(request, auth))


@router.get("/api/admin/users/{user_id}/desktop-config", tags=["desktop-config"], deprecated=True)
async def get_user_desktop_config(
    user_id: int, _auth: Dict[str, Any] = Depends(admin_auth)
) -> Dict[str, Any]:
    raise HTTPException(status_code=410, detail=DESKTOP_CONFIG_GONE_DETAIL)


@router.patch("/api/admin/users/{user_id}/desktop-config", tags=["desktop-config"], deprecated=True)
async def update_user_desktop_config(
    user_id: int, _auth: Dict[str, Any] = Depends(admin_auth)
) -> Dict[str, Any]:
    raise HTTPException(status_code=410, detail=DESKTOP_CONFIG_GONE_DETAIL)


@router.get("/api/admin/stats", tags=["users"])
def admin_stats(
    _auth: Dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db)
) -> Dict[str, int]:
    return users_service.stats(db)


__all__ = ["router"]
