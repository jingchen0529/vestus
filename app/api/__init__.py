"""HTTP layer.

Routers translate between HTTP and the service layer and do nothing else: they
parse and validate the request, call exactly one service function, and shape the
response.  No router opens a database session or writes an audit row directly.

Every route carries its full literal path rather than a router ``prefix``, and
keeps its original function name, tags and ``status_code``, because the generated
OpenAPI document is part of the public contract -- ``operationId`` is derived
from the function name and path.
"""

from __future__ import annotations

__all__: list[str] = []
