"""Desktop configuration handed to the running client."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.api.deps import audit_context, get_db, user_auth
from app.api.responses import externalize_platform_icons
from app.db.session import Database
from app.services import desktop as desktop_service
from app.services.audit import record_standalone

MISSING_USER_DETAIL = "用户不存在"

router = APIRouter()


@router.get("/api/user/desktop-config", tags=["desktop-config"])
def user_desktop_config(
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    # This response contains the reversible upstream credential for the Rust
    # process. It must never be cached by a browser, reverse proxy or CDN.
    response.headers["Cache-Control"] = "no-store"
    result = desktop_service.get_user_desktop_config_with_lease(db, auth["id"])
    if result is None:
        raise HTTPException(status_code=404, detail=MISSING_USER_DETAIL)
    externalize_platform_icons(request, result)
    # A read has no transaction to join, and a failed audit write must not deny
    # the client its configuration -- so this row is written on its own.
    record_standalone(db, audit_context(request, auth), "DESKTOP_CONFIG_READ", "读取桌面配置")
    return result


@router.get("/api/user/desktop-config/lease", tags=["desktop-config"])
def user_desktop_config_lease(
    response: Response,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> Dict[str, str]:
    response.headers["Cache-Control"] = "no-store"
    lease = desktop_service.get_user_desktop_lease(db, auth["id"])
    if lease is None:
        raise HTTPException(status_code=404, detail=MISSING_USER_DETAIL)
    return {"lease": lease}


__all__ = ["router"]
