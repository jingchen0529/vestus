"""Desktop-user authentication."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import audit_context, get_db, user_auth
from app.api.envelope import EnvelopeRoute
from app.api.login import perform_login, perform_logout
from app.db.session import Database
from app.schemas.auth import ChangePasswordRequest, LoginRequest
from app.schemas.serializers import user_dict
from app.services import auth as auth_service

router = APIRouter(route_class=EnvelopeRoute)


@router.post("/api/user/auth/login", tags=["user-auth"])
def user_login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return perform_login(db, "user", payload, request, response)


@router.get("/api/user/auth/me", tags=["user-auth"])
async def user_me(auth: Dict[str, Any] = Depends(user_auth)) -> Dict[str, Any]:
    return user_dict(auth["model"])


@router.post("/api/user/auth/logout", tags=["user-auth"])
def user_logout(
    request: Request,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> None:
    perform_logout(db, request, auth)


@router.post("/api/user/auth/change-password", tags=["user-auth"])
def user_change_password(
    payload: ChangePasswordRequest,
    request: Request,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> None:
    auth_service.change_password(
        db,
        auth["id"],
        payload.current_password,
        payload.new_password,
        audit=audit_context(request, auth),
    )


__all__ = ["router"]
