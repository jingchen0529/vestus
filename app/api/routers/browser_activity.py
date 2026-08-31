"""Browser activity: the desktop client's upload and the admin's read side.

One router, two audiences, deliberately: the upload contract and the views over
it have to move together, and splitting them across files only hides that.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query, Request

from app.api.deps import admin_auth, audit_context, get_db, user_auth
from app.api.envelope import EnvelopeRoute
from app.db.session import Database
from app.schemas.browser_activity import BrowserActivityReport
from app.services import browser_activity as activity_service
from app.services.audit import record_standalone

router = APIRouter(route_class=EnvelopeRoute)


@router.post("/api/user/browser-activity", tags=["browser-activity"])
def report_browser_activity(
    request: Request,
    report: BrowserActivityReport,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    """Accept one batch of deltas from a running desktop client.

    Called on a timer by a background task in the client, so it must stay cheap
    and must never be the reason a browsing session breaks.  Everything that can
    reject the request has already run in the request model.
    """

    username = getattr(auth.get("model"), "username", "") or ""
    result = activity_service.record_activity(
        db,
        report,
        user_id=auth["id"],
        username=username,
        ip=audit_context(request, auth).ip,
    )
    # No audit row per batch: a single browsing session uploads dozens of them and
    # the activity tables are themselves the record.  Only the first batch of a
    # session -- the one that created the row -- is worth an audit entry.
    if result["newPages"] and result["acceptedPages"] == result["newPages"]:
        record_standalone(
            db,
            audit_context(request, auth),
            "BROWSER_ACTIVITY_REPORT",
            f"上报浏览器活动 {result['acceptedPages']} 个地址",
            target_type="browser",
            target_id=result["sessionId"],
        )
    return result


@router.get("/api/admin/browser-sessions", tags=["browser-activity"])
def admin_browser_sessions(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200, alias="pageSize"),
    user_id: Optional[int] = Query(None, alias="userId"),
    platform_id: Optional[int] = Query(None, alias="platformId"),
    direct_mode: Optional[bool] = Query(None, alias="directMode"),
    start_at: Optional[str] = Query(None, alias="startAt"),
    end_at: Optional[str] = Query(None, alias="endAt"),
    _auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return activity_service.list_sessions(
        db,
        page=page,
        page_size=page_size,
        user_id=user_id,
        platform_id=platform_id,
        direct_mode=direct_mode,
        start_at=start_at,
        end_at=end_at,
    )


@router.get("/api/admin/browser-sessions/{session_id}", tags=["browser-activity"])
def admin_browser_session_detail(
    session_id: int,
    page_limit: int = Query(500, ge=1, le=1000, alias="pageLimit"),
    _auth: Dict[str, Any] = Depends(admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return activity_service.get_session_detail(db, session_id, page_limit=page_limit)


__all__ = ["router"]
