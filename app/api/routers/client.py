"""Legacy desktop-client probes, kept for shipped builds."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends

from app.api.deps import user_auth
from app.api.envelope import EnvelopeRoute
from app.db.base import iso_datetime, utc_now
from app.schemas.serializers import user_dict

router = APIRouter(route_class=EnvelopeRoute)


@router.get("/api/client/me", include_in_schema=False)
async def client_me(auth: Dict[str, Any] = Depends(user_auth)) -> Dict[str, Any]:
    return user_dict(auth["model"])


@router.get("/api/client/resource", include_in_schema=False)
async def protected_resource(auth: Dict[str, Any] = Depends(user_auth)) -> Dict[str, Any]:
    return {
        "authenticated": True,
        "user": user_dict(auth["model"]),
        "serverTime": iso_datetime(utc_now()),
    }


__all__ = ["router"]
