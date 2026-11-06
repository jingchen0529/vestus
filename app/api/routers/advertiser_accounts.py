"""Scoped advertiser-account access lists and their source evidence."""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from app.api.deps import admin_auth, get_db, user_scope_admin_id
from app.api.envelope import EnvelopeRoute
from app.db.session import Database
from app.services.advertiser_accounts import query_accounts
from app.services.advertiser_identity import ADVERTISER_ID_PATTERN

router = APIRouter(route_class=EnvelopeRoute)


def filters(
    user_id: Optional[int] = Query(None, alias="userId", ge=1, le=2**63 - 1),
    session_id: Optional[int] = Query(None, alias="sessionId", ge=1, le=2**63 - 1),
    managed_account_id: Optional[int] = Query(None, alias="managedAccountId", ge=1, le=2**63 - 1),
    direct_mode: Optional[bool] = Query(None, alias="directMode"),
    start_at: Optional[str] = Query(None, alias="startAt", pattern=r"^\d{4}-\d{2}-\d{2}$"),
    end_at: Optional[str] = Query(None, alias="endAt", pattern=r"^\d{4}-\d{2}-\d{2}$"),
) -> dict[str, Any]:
    try:
        start = date.fromisoformat(start_at) if start_at else None
        end = date.fromisoformat(end_at) if end_at else None
        if any(value is not None and value.year < 1000 for value in (start, end)):
            raise ValueError("date outside supported database range")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="请输入有效日期") from exc
    if start is not None and end is not None and start > end:
        raise HTTPException(status_code=422, detail="起始日期不能晚于结束日期")
    beijing = timezone(timedelta(hours=8))
    return {
        "user_id": user_id, "session_id": session_id,
        "managed_account_id": managed_account_id, "direct_mode": direct_mode,
        "start_at": datetime.combine(start, time.min, beijing) if start else None,
        "end_at": datetime.combine(end, time.max, beijing) if end else None,
    }


@router.get("/api/admin/advertiser-accounts", tags=["browser-activity"])
def list_accounts(
    query: dict[str, Any] = Depends(filters),
    platform_id: Optional[int] = Query(None, alias="platformId", ge=0, le=2**63 - 1),
    advertiser_id: Optional[str] = Query(None, alias="advertiserId", max_length=64, pattern=r"^[0-9]*$"),
    page: int = Query(1, ge=1, le=10_000_000), page_size: int = Query(50, alias="pageSize", ge=1, le=200),
    auth: dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db),
) -> dict[str, Any]:
    return query_accounts(db, page=page, page_size=page_size, platform_id=platform_id, advertiser_id=advertiser_id,
                          visible_admin_id=user_scope_admin_id(auth), **query)


@router.get("/api/admin/advertiser-accounts/options", tags=["browser-activity"])
def account_options(
    query: dict[str, Any] = Depends(filters),
    platform_id: Optional[int] = Query(None, alias="platformId", ge=0, le=2**63 - 1),
    advertiser_id: Optional[str] = Query(None, alias="advertiserId", max_length=64, pattern=r"^[0-9]*$"),
    search: Optional[str] = Query(None, max_length=255),
    page: int = Query(1, ge=1, le=10_000_000),
    page_size: int = Query(100, alias="pageSize", ge=1, le=200),
    auth: dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db),
) -> dict[str, Any]:
    return query_accounts(db, view="options", platform_id=platform_id, advertiser_id=advertiser_id,
                          page=page, page_size=page_size, option_search=search,
                          visible_admin_id=user_scope_admin_id(auth), **query)


@router.get("/api/admin/advertiser-accounts/{platform_id}/{advertiser_id}/associations", tags=["browser-activity"])
def account_associations(
    platform_id: int = Path(ge=0, le=2**63 - 1), advertiser_id: str = Path(pattern=f"^{ADVERTISER_ID_PATTERN}$"),
    query: dict[str, Any] = Depends(filters),
    page: int = Query(1, ge=1, le=10_000_000), page_size: int = Query(50, alias="pageSize", ge=1, le=200),
    auth: dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db),
) -> dict[str, Any]:
    return query_accounts(db, view="associations", page=page, page_size=page_size, platform_id=platform_id,
                          advertiser_id=advertiser_id, exact_advertiser=True,
                          visible_admin_id=user_scope_admin_id(auth), **query)


@router.get("/api/admin/advertiser-accounts/{platform_id}/{advertiser_id}/sources", tags=["browser-activity"])
def account_sources(
    platform_id: int = Path(ge=0, le=2**63 - 1), advertiser_id: str = Path(pattern=f"^{ADVERTISER_ID_PATTERN}$"),
    query: dict[str, Any] = Depends(filters),
    page: int = Query(1, ge=1, le=10_000_000), page_size: int = Query(50, alias="pageSize", ge=1, le=200),
    auth: dict[str, Any] = Depends(admin_auth), db: Database = Depends(get_db),
) -> dict[str, Any]:
    return query_accounts(db, view="sources", page=page, page_size=page_size, platform_id=platform_id,
                          advertiser_id=advertiser_id, exact_advertiser=True,
                          visible_admin_id=user_scope_admin_id(auth), **query)
