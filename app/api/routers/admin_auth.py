"""Administrator authentication."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import admin_auth, get_db
from app.api.login import perform_login, perform_logout
from app.db.session import Database
from app.schemas.auth import LoginRequest
from app.schemas.serializers import admin_dict

router = APIRouter()


@router.post("/api/admin/auth/login", tags=["admin-auth"])
def admin_login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return perform_login(db, "admin", payload, request, response)


@router.get("/api/admin/auth/me", tags=["admin-auth"])
async def admin_me(auth: Dict[str, Any] = Depends(admin_auth)) -> Dict[str, Any]:
    return admin_dict(auth["model"])


@router.post("/api/admin/auth/logout", tags=["admin-auth"])
def admin_logout(
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, bool]:
    return perform_logout(db, request, auth, response)


__all__ = ["router"]
