"""Audit-log browsing."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query

from app.api.deps import admin_auth, get_db
from app.api.envelope import EnvelopeRoute
from app.api.responses import collection
from app.db.session import Database
from app.services import logs as logs_service

router = APIRouter(route_class=EnvelopeRoute)


@router.get("/api/admin/user-logs", tags=["logs"])
def user_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    actor_type: Optional[str] = Query(None, alias="actorType"),
    actor_id: Optional[int] = Query(None, alias="actorId"),
    action: Optional[str] = None,
    log_status: Optional[str] = Query(None, alias="status"),
    target_id: Optional[int] = Query(None, alias="targetId"),
    start_at: Optional[str] = Query(None, alias="startAt"),
    end_at: Optional[str] = Query(None, alias="endAt"),
    _auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return logs_service.list_logs(
        db,
        page=page,
        page_size=page_size,
        actor_type=actor_type,
        actor_id=actor_id,
        action=action,
        status=log_status,
        target_id=target_id,
        start_at=start_at,
        end_at=end_at,
    )


@router.get("/api/admin/user-logs/{log_id}", tags=["logs"])
def user_log_detail(
    log_id: int,
    _auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return logs_service.get_log(db, log_id)


@router.get("/api/admin/audit-logs", include_in_schema=False)
@router.get("/api/admin/logs", include_in_schema=False)
def legacy_logs(
    limit: int = Query(100, ge=1, le=500),
    user_id: Optional[int] = Query(None),
    _auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return collection(logs_service.list_recent(db, limit=limit, actor_id=user_id))


__all__ = ["router"]
