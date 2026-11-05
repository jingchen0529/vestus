"""Desktop FAQ configuration: admin editing plus the client-facing read."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.api.deps import admin_auth, audit_context, get_db, super_admin_auth, user_auth
from app.api.envelope import EnvelopeRoute
from app.db.session import Database
from app.schemas.desktop_faq import MAX_DOCUMENT_BYTES, DesktopFaqDocument
from app.services import desktop_faq as desktop_faq_service
from app.services.audit import record_standalone
from app.services.desktop_faq_template import DEFAULT_DESKTOP_FAQ_TEMPLATE

PAYLOAD_TOO_LARGE_DETAIL = "帮助内容提交体积过大，请精简后再保存"

router = APIRouter(route_class=EnvelopeRoute)


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


@router.get("/api/admin/desktop-faq/template", tags=["desktop-config"])
def get_desktop_faq_template(
    response: Response,
    _auth: Dict[str, Any] = Depends(admin_auth),
) -> Dict[str, Any]:
    """The built-in baseline, for the console's「用内置内容初始化编辑器」."""

    _no_store(response)
    return {"faq": DEFAULT_DESKTOP_FAQ_TEMPLATE}


@router.get("/api/admin/desktop-faq", tags=["desktop-config"])
def get_desktop_faq(
    response: Response,
    _auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    _no_store(response)
    return desktop_faq_service.get_admin_document(db)


@router.put("/api/admin/desktop-faq", tags=["desktop-config"])
def save_desktop_faq(
    payload: DesktopFaqDocument,
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=400, detail=PAYLOAD_TOO_LARGE_DETAIL)
    _no_store(response)
    return desktop_faq_service.save_document(
        db,
        payload.model_dump()["groups"],
        audit=audit_context(request, auth),
    )


@router.delete("/api/admin/desktop-faq", tags=["desktop-config"])
def reset_desktop_faq(
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    _no_store(response)
    return desktop_faq_service.clear_document(db, audit=audit_context(request, auth))


@router.get("/api/user/desktop-faq", tags=["desktop-config"])
def user_desktop_faq(
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    _no_store(response)
    result = desktop_faq_service.get_user_document(db)
    # A read has no transaction to join; like DESKTOP_CONFIG_READ, the audit row
    # is written on its own so a failed log insert cannot fail the request.
    record_standalone(db, audit_context(request, auth), "DESKTOP_FAQ_READ", "读取客户端帮助内容")
    return result


__all__ = ["router"]
