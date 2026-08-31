"""Reading the response envelope in assertions.

Every JSON endpoint answers with ``{code, msg, data, requestId}``.  A test cares
about what the endpoint *returned*, so it asserts on :func:`payload`, not on the
three bookkeeping keys wrapped around it.  Keeping that unwrapping here means the
envelope's shape is pinned in one place instead of restated at every assertion.

:func:`payload` also asserts that ``code`` agrees the call succeeded, which
catches the failure mode a bare ``response.json()["data"]`` would hide: an
endpoint that answers 200 with an error code.
"""

from __future__ import annotations

from typing import Any, Dict, List

from httpx import Response

from app.core.api_contract import ApiCode

ENVELOPE_KEYS = {"code", "msg", "data", "requestId"}


def envelope(response: Response) -> Dict[str, Any]:
    """The whole envelope, asserting only that this *is* one."""

    body = response.json()
    assert isinstance(body, dict), f"expected an envelope, got {body!r}"
    assert set(body) >= ENVELOPE_KEYS, f"not an envelope: {body!r}"
    return body


def payload(response: Response) -> Any:
    """The ``data`` of a response that is expected to have succeeded."""

    body = envelope(response)
    assert body["code"] == ApiCode.OK, f"expected success, got {body['code']}: {body['msg']}"
    return body["data"]


def items(response: Response) -> List[Any]:
    """The ``data.items`` of a collection response."""

    return payload(response)["items"]


def message(response: Response) -> str:
    """The human-readable failure text, for tests that assert on the reason."""

    return envelope(response)["msg"]


def code(response: Response) -> int:
    """The machine-readable code, for tests that assert on which failure it was."""

    return envelope(response)["code"]


__all__ = ["ENVELOPE_KEYS", "code", "envelope", "items", "message", "payload"]
