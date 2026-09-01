"""Service metadata, health and the admin console entry point."""

from __future__ import annotations

import ipaddress
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse

from app.api.deps import client_ip, get_db
from app.api.envelope import EnvelopeRoute
from app.api.responses import absolute_upload_reference
from app.core.config import REPO_ROOT
from app.db.session import Database
from app.services import settings as settings_service

WEB_DIST_DIR = REPO_ROOT / "web" / "dist"
ADMIN_ASSETS_DIR = WEB_DIST_DIR / "assets"
ADMIN_DIST_PAGE = WEB_DIST_DIR / "index.html"
ADMIN_FALLBACK_PAGE = REPO_ROOT / "web" / "admin.html"
ADMIN_PAGE_UNAVAILABLE_DETAIL = "管理台页面不可用"

router = APIRouter(route_class=EnvelopeRoute)

#: ``/healthz`` is deliberately *not* enveloped.  Its consumers are the reverse
#: proxy, the container probe and external monitoring -- none of which know about
#: the envelope, and all of which would have to be reconfigured to read
#: ``data.status`` instead of ``status``.
probe_router = APIRouter()


@router.get("/", tags=["system"])
async def root() -> Dict[str, str]:
    return {"service": "vestus", "status": "ok", "docs": "/docs"}


@router.get("/api/network/ip", tags=["system"])
async def network_ip(request: Request, response: Response) -> Dict[str, str]:
    """Return the source IP observed by the Vestus API for this request path."""
    observed = client_ip(request)
    try:
        address = str(ipaddress.ip_address(observed))
    except ValueError as exc:
        raise HTTPException(
            status_code=503,
            detail="无法识别请求来源 IP",
            headers={"Cache-Control": "no-store"},
        ) from exc
    response.headers["Cache-Control"] = "no-store"
    return {"ip": address}


@probe_router.get("/healthz", tags=["system"])
def healthz(response: Response, db: Database = Depends(get_db)) -> Dict[str, Any]:
    # 反向代理会把这个端点暴露在公网且不带鉴权，所以只回存活状态。
    # 数据库地址、库名一律不外泄；本机排障请看 journalctl。
    #
    # ``ping`` 自己吞掉 SQLAlchemyError 回 False，但引擎层面的故障（未初始化、
    # 驱动缺失）会抛别的异常。那些异常若冒到全局 handler，这个端点就会回信封，
    # 而部署文档里的 `curl | jq '.status'` 读的是裸字段。所以在这里就地兜住：
    # 形状始终是裸 JSON，状态码仍然显式失败，不假装健康。
    try:
        ok = db.ping()
    except Exception:  # noqa: BLE001 - 探针不关心是哪种故障，只关心不健康
        response.status_code = 503
        ok = False
    return {"status": "ok" if ok else "degraded", "database": "ok" if ok else "unavailable"}


@router.get("/api/product", tags=["system"])
def product(
    request: Request, response: Response, db: Database = Depends(get_db)
) -> Dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    branding = settings_service.get_branding(db)
    return {
        "productName": branding["productName"],
        "logoUrl": absolute_upload_reference(request, branding.get("logoUrl", "")),
        "adminTitle": branding.get("adminTitle", "Vestus Admin"),
        "adminLogoUrl": absolute_upload_reference(request, branding.get("adminLogoUrl", "")),
        "adminThemeColor": branding.get("adminThemeColor", "blue"),
    }


@router.get("/admin", include_in_schema=False)
async def admin_page() -> Response:
    page_to_serve = ADMIN_DIST_PAGE if ADMIN_DIST_PAGE.exists() else ADMIN_FALLBACK_PAGE
    if not page_to_serve.exists():
        raise HTTPException(status_code=404, detail=ADMIN_PAGE_UNAVAILABLE_DETAIL)
    # A FileResponse is not a JSONResponse, so EnvelopeRoute hands it straight
    # through -- the console still gets real HTML.
    return FileResponse(page_to_serve, media_type="text/html; charset=utf-8")


__all__ = ["ADMIN_ASSETS_DIR", "probe_router", "router"]
