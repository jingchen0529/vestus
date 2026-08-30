"""Vestus backend application package.

Layering is enforced from the outside in::

    api/routers -> services -> repositories -> db/models

``schemas`` holds the HTTP DTOs shared by routers and services, ``core`` holds
cross-cutting concerns (configuration, password/token primitives, upload
storage, ASGI middleware).  Nothing below ``services`` may commit a
transaction, and nothing below ``api`` may import FastAPI routing.

Run the service with ``uvicorn app.main:app``.
"""

from __future__ import annotations

__all__: list[str] = []
