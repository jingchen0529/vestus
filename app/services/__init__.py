"""Business layer.

A service function owns exactly one transaction: it opens a session, composes
repository calls, writes its audit row through :mod:`app.services.audit` and
commits.  Nothing above this layer is allowed to open a session, and nothing
below it is allowed to commit.

Failures are raised as :class:`app.services.errors.ServiceError` subclasses,
which carry the HTTP status the API layer should return -- services never import
FastAPI.
"""

from __future__ import annotations

__all__: list[str] = []
