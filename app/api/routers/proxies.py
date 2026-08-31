"""Global proxy management."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request

from app.api.deps import admin_auth, audit_context, get_db
from app.api.envelope import EnvelopeRoute
from app.api.responses import collection
from app.db.session import Database
from app.schemas.proxies import ProxyCreate, ProxyUpdate
from app.services import proxies as proxies_service

NO_FIELDS_DETAIL = "至少提供一个待更新字段"

router = APIRouter(route_class=EnvelopeRoute)


@router.get("/api/admin/proxies", tags=["desktop-config"])
def list_proxies(
    _auth: Dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db)
) -> Dict[str, Any]:
    return collection(proxies_service.list_proxies(db))


@router.post("/api/admin/proxies", status_code=201, tags=["desktop-config"])
def create_proxy(
    payload: ProxyCreate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return proxies_service.create_proxy(
        db, payload.model_dump(), audit=audit_context(request, auth)
    )


@router.patch("/api/admin/proxies/{proxy_id}", tags=["desktop-config"])
def update_proxy(
    proxy_id: int,
    payload: ProxyUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    changes = payload.model_dump(exclude_unset=True)
    if not changes:
        raise HTTPException(status_code=400, detail=NO_FIELDS_DETAIL)
    return proxies_service.update_proxy(
        db, proxy_id, changes, audit=audit_context(request, auth)
    )


@router.delete("/api/admin/proxies/{proxy_id}", tags=["desktop-config"])
def delete_proxy(
    proxy_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> None:
    proxies_service.delete_proxy(db, proxy_id, audit=audit_context(request, auth))


__all__ = ["router"]
