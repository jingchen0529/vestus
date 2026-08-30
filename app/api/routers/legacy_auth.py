"""Legacy authentication aliases used by the first desktop/admin prototypes.

They are excluded from the OpenAPI document but must keep working: shipped
clients still call them.  ``legacy_login`` accepts either account type, deciding
by looking the username up in the administrator table first.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, Request, Response

from app.api.deps import current_account, get_db
from app.api.login import perform_login, perform_logout
from app.db.session import Database
from app.schemas.auth import LoginRequest
from app.schemas.serializers import admin_dict, user_dict
from app.services import auth as auth_service

router = APIRouter()


@router.post("/api/auth/login", include_in_schema=False)
def legacy_login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    # The old endpoint accepted either account type.  Preserve that behavior
    # while returning the old `user` field as well.
    account_type = (
        "admin" if auth_service.find_admin_by_username(db, payload.username) else "user"
    )
    result = perform_login(db, account_type, payload, request, response)
    if "admin" in result:
        result["user"] = result["admin"]
    return result


@router.get("/api/auth/me", include_in_schema=False)
async def legacy_me(auth: Dict[str, Any] = Depends(current_account)) -> Dict[str, Any]:
    return admin_dict(auth["model"]) if auth["type"] == "admin" else user_dict(auth["model"])


@router.post("/api/auth/logout", include_in_schema=False)
def legacy_logout(
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(current_account),
    db: Database = Depends(get_db),
) -> Dict[str, bool]:
    return perform_logout(db, request, auth, response)


__all__ = ["router"]
