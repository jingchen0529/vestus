"""Router package.

``ROUTERS`` is included by ``create_app()`` in this exact order.  It mirrors the
order the routes were declared in before the split so that path matching -- and
therefore behaviour -- cannot shift.  ``system.probe_router`` is listed
separately because ``/healthz`` is the one JSON endpoint that stays outside the
response envelope; see the note on it in :mod:`app.api.routers.system`.
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter

from app.api.routers import (
    admin_auth,
    admins,
    client,
    desktop,
    legacy_auth,
    logs,
    platforms,
    proxies,
    settings,
    system,
    uploads,
    user_auth,
    users,
)

ROUTERS: List[APIRouter] = [
    system.probe_router,
    system.router,
    uploads.router,
    settings.router,
    admin_auth.router,
    user_auth.router,
    desktop.router,
    legacy_auth.router,
    admins.router,
    proxies.router,
    platforms.router,
    users.router,
    logs.router,
    client.router,
]

__all__ = ["ROUTERS"]
