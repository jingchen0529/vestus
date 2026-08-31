"""The response contract's data half: the code vocabulary and the envelope dict.

This lives in ``app.core`` because three layers that may not import each other
all need the same vocabulary: :mod:`app.services.errors` tags each exception with
its code, :mod:`app.core.middleware` writes one 413 response before any router is
reached, and :mod:`app.api.envelope` does the FastAPI wiring.  Putting the codes
anywhere higher would force one of those into a backwards dependency.

Like :mod:`app.db.base`, this module imports nothing beyond the standard library.
"""

from __future__ import annotations

from enum import IntEnum
from typing import Any, Dict

SUCCESS_MESSAGE = "ok"

#: Statuses whose specification forbids a body.  Wrapping one would mean adding
#: a body to a response that must not have one.
BODILESS_STATUSES = frozenset({204, 205, 304})


class ApiCode(IntEnum):
    """The machine-readable code carried by every JSON response.

    The leading digits are the HTTP status the response is sent with and the last
    two are a discriminator within that status, so ``code // 100`` recovers the
    status without a lookup table -- a client can branch coarsely on "this was a
    401" and finely on *which* 401 from the same field.  ``00`` is the code for a
    status that needs no discriminator.

    The HTTP status line keeps carrying the real status as well.  Nothing here
    replaces it; reverse-proxy logs, monitoring and the desktop client's own
    ``response.status()`` checks all continue to work.
    """

    OK = 0

    BAD_REQUEST = 40000
    LAST_SUPER_ADMIN = 40001
    UNAUTHENTICATED = 40100
    ACCOUNT_UNAVAILABLE = 40300
    NOT_FOUND = 40400
    CONFLICT = 40900
    GONE = 41000
    PAYLOAD_TOO_LARGE = 41300
    UNPROCESSABLE = 42200

    INTERNAL = 50000
    DATABASE_UNAVAILABLE = 50300
    STORAGE_UNAVAILABLE = 50700

    @classmethod
    def for_status(cls, status_code: int) -> "ApiCode":
        """The code for a bare ``HTTPException`` that named no code itself.

        Routers still raise ``HTTPException(status_code=403, ...)`` directly, and
        the deps layer raises 401/403 during authentication.  Those get the ``00``
        member for their status; anything unmapped degrades to a generic code
        rather than inventing one, so the invariant ``code // 100 == http_status``
        can never quietly break.
        """

        try:
            return cls(status_code * 100)
        except ValueError:
            return cls.INTERNAL if status_code >= 500 else cls.BAD_REQUEST


def envelope_body(
    *,
    code: ApiCode | int = ApiCode.OK,
    msg: str = SUCCESS_MESSAGE,
    data: Any = None,
    request_id: str = "",
) -> Dict[str, Any]:
    """The envelope as a plain dict, in a fixed key order."""

    return {"code": int(code), "msg": msg, "data": data, "requestId": request_id}


__all__ = [
    "BODILESS_STATUSES",
    "SUCCESS_MESSAGE",
    "ApiCode",
    "envelope_body",
]
