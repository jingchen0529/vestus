"""Administrator authentication."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import SESSION_COOKIE, admin_auth, audit_context, get_db, super_admin_auth
from app.api.envelope import EnvelopeRoute
from app.api.login import perform_login, perform_logout
from app.db.session import Database
from app.schemas.auth import ChangePasswordRequest, LoginRequest
from app.services import admins as admins_service
from app.services.serializers import admin_dict

router = APIRouter(route_class=EnvelopeRoute)


@router.post("/api/admin/auth/login", tags=["admin-auth"])
def admin_login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return perform_login(db, "admin", payload, request, response, auth_source="admin")


@router.get("/api/admin/auth/me", tags=["admin-auth"])
async def admin_me(auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    return admin_dict(auth["model"])


@router.post("/api/admin/auth/logout", tags=["admin-auth"])
def admin_logout(
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> None:
    perform_logout(db, request, auth, response)


@router.post("/api/admin/auth/change-password", tags=["admin-auth"])
def change_admin_password(
    payload: ChangePasswordRequest,
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> None:
    admins_service.change_password(
        db, auth["id"], payload.current_password, payload.new_password,
        token_version=int(auth["claims"]["tv"]), audit=audit_context(request, auth),
    )
    response.delete_cookie(SESSION_COOKIE, path="/")


__all__ = ["router"]
