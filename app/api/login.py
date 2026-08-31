"""The login/logout mechanics shared by the admin, user and legacy endpoints.

The session cookie is issued for administrators only: the desktop client stores
its bearer token itself, and handing it a cookie would expose it to the CSRF
surface the console has to defend against.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import Request, Response

from app.api.deps import SESSION_COOKIE, audit_context
from app.core.config import get_settings
from app.db.session import Database
from app.schemas.auth import LoginRequest
from app.services import auth as auth_service


def perform_login(
    db: Database,
    account_type: str,
    payload: LoginRequest,
    request: Request,
    response: Response,
) -> Dict[str, Any]:
    grant = auth_service.login(
        db,
        account_type,
        payload.username,
        payload.password,
        audit=audit_context(request),
    )
    if account_type == "admin":
        response.set_cookie(
            SESSION_COOKIE,
            grant.token,
            max_age=grant.ttl_seconds,
            httponly=True,
            secure=get_settings().cookie_secure,
            samesite="lax",
            path="/",
        )
    return grant.payload


def perform_logout(
    db: Database, request: Request, auth: Dict[str, Any], response: Response | None = None
) -> None:
    auth_service.logout(db, auth["type"], auth["id"], audit=audit_context(request, auth))
    if response is not None:
        response.delete_cookie(SESSION_COOKIE, path="/")


__all__ = ["perform_login", "perform_logout"]
