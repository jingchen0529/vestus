from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query

from app.api.deps import admin_auth, get_db, user_auth, user_scope_admin_id
from app.api.envelope import EnvelopeRoute
from app.db.session import Database
from app.schemas.network_metric import NetworkDiagnosticsReport
from app.services import network_metrics as service

router = APIRouter(route_class=EnvelopeRoute)


@router.post("/api/user/network-diagnostics", tags=["network-diagnostics"])
def report_network_diagnostics(report: NetworkDiagnosticsReport, auth: Dict[str, Any] = Depends(user_auth), db: Database = Depends(get_db)) -> Dict[str, Any]:
    return service.record_report(db, report, user_id=auth["id"], device_id=getattr(auth.get("model"), "last_device_id", None))


@router.get("/api/admin/network-diagnostics", tags=["network-diagnostics"])
def admin_network_diagnostics(page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200, alias="pageSize"), user_id: Optional[int] = Query(None, alias="userId"), device_id: Optional[str] = Query(None, alias="deviceId"), route: Optional[str] = Query(None), network_mode: Optional[str] = Query(None, alias="networkMode"), status: Optional[str] = Query(None), start_at: Optional[str] = Query(None, alias="startAt"), end_at: Optional[str] = Query(None, alias="endAt"), auth: Dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db)) -> Dict[str, Any]:
    return service.list_metrics(db, page=page, page_size=page_size, user_id=user_id, device_id=device_id, route=route, network_mode=network_mode, status=status, start_at=start_at, end_at=end_at, visible_admin_id=user_scope_admin_id(auth))

