"""Query layer.

Every function here takes an externally-owned :class:`~sqlalchemy.orm.Session`
and never commits, so a service can compose several repository calls into one
transaction.  Repositories return ORM instances or plain scalars; turning them
into JSON is :mod:`app.schemas.serializers`' job.
"""

from __future__ import annotations

__all__: list[str] = []
