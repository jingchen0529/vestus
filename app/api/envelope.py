"""The FastAPI wiring that puts every JSON response into the shared envelope.

The vocabulary itself -- :class:`~app.core.api_contract.ApiCode` and
:func:`~app.core.api_contract.envelope_body` -- lives in ``app.core`` so the
middleware and the service layer can reach it too.  This module is only the
framework half.

There are two independent paths into the envelope and they must not overlap:

* :class:`EnvelopeRoute` wraps whatever a route function returned.  It only
  touches :class:`~starlette.responses.JSONResponse`, so the ``FileResponse``
  from ``/uploads/{path}`` and the one from ``/admin`` fall through untouched --
  one ``isinstance`` check instead of splitting those routers apart.
* The exception handlers in :mod:`app.main` build the envelope directly through
  :func:`envelope_response`.  An exception escapes the route handler before it
  can return, so it never reaches ``EnvelopeRoute`` and cannot be double-wrapped.

Both paths preserve the headers the inner response set.  That is load bearing,
not tidiness: ``Cache-Control: no-store`` guards the desktop-config response
(it carries a reversible upstream credential), ``WWW-Authenticate`` comes from
:func:`app.api.deps.auth_error`, and ``Set-Cookie`` carries the admin session.
"""

from __future__ import annotations

import json
from typing import Any, Callable, Coroutine, Dict, List, Mapping, Optional, Set, Tuple

from fastapi import FastAPI, Request, Response
from fastapi.routing import APIRoute
from starlette.responses import JSONResponse

from app.core.api_contract import (
    BODILESS_STATUSES,
    SUCCESS_MESSAGE,
    ApiCode,
    envelope_body,
)

#: Rebuilding the body invalidates these; the new response computes its own.
_RECOMPUTED_HEADERS = frozenset({b"content-length", b"content-type"})

_JSON_MEDIA_TYPE = "application/json"


def _carries_json_body(response: Response) -> bool:
    """Whether this response has a JSON body for us to re-wrap.

    Decided by media type, *not* by ``isinstance(response, JSONResponse)``.
    FastAPI serialises a route's return value straight to JSON bytes on a plain
    :class:`~starlette.responses.Response` whenever the route has a return
    annotation and no explicit ``response_class`` -- its ``dump_json`` fast path
    -- so an ``isinstance`` check silently misses almost every endpoint here and
    lets the bare payload through unwrapped.  The media type is the property we
    actually care about, and it does not move between FastAPI versions.

    The ``FileResponse`` from ``/uploads/{path}`` and ``/admin`` still falls
    through untouched: neither one is JSON.
    """

    media_type = response.headers.get("content-type", "")
    return media_type.split(";")[0].strip().lower() == _JSON_MEDIA_TYPE


def request_trace_id(request: Optional[Request]) -> str:
    """The id :class:`app.core.middleware.RequestIdMiddleware` put on the request.

    Read defensively: a ``Request`` assembled without the middleware (a unit test
    calling a handler directly) has no such attribute, and a missing trace id is
    not worth failing a response over.
    """

    if request is None:
        return ""
    return getattr(request.state, "request_id", "") or ""


def envelope_response(
    request: Optional[Request],
    *,
    status_code: int,
    code: ApiCode | int,
    msg: str,
    data: Any = None,
    headers: Optional[Mapping[str, str]] = None,
) -> JSONResponse:
    """Build a fully-formed envelope response.  Used by the error handlers."""

    return JSONResponse(
        envelope_body(code=code, msg=msg, data=data, request_id=request_trace_id(request)),
        status_code=status_code,
        headers=headers,
    )


def _preserved_headers(response: Response) -> List[Tuple[bytes, bytes]]:
    return [
        (name, value)
        for name, value in response.raw_headers
        if name.lower() not in _RECOMPUTED_HEADERS
    ]


def enveloped(request: Request, response: Response) -> Response:
    """Wrap a route's JSON response, or hand back anything else unchanged."""

    if not _carries_json_body(response) or response.status_code in BODILESS_STATUSES:
        return response

    # A streamed JSON body has no ``body`` to re-read, and buffering one to wrap
    # it would defeat the point of streaming it.
    body = getattr(response, "body", None)
    if body is None:
        return response

    data = json.loads(body) if body else None
    wrapped = JSONResponse(
        envelope_body(data=data, request_id=request_trace_id(request)),
        status_code=response.status_code,
    )
    # The freshly-built Content-Length and Content-Type must win; everything the
    # route set (Cache-Control, Set-Cookie, security headers) has to survive.
    wrapped.raw_headers = wrapped.raw_headers + _preserved_headers(response)
    return wrapped


class EnvelopeRoute(APIRoute):
    """An ``APIRoute`` whose JSON responses come out enveloped.

    Route functions keep returning bare domain dicts, so the service layer and
    the serializers stay unaware that an envelope exists at all.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        inner = super().get_route_handler()

        async def envelope_route_handler(request: Request) -> Response:
            return enveloped(request, await inner(request))

        return envelope_route_handler


def enveloped_schema(inner: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The OpenAPI schema for an envelope carrying ``inner`` as its ``data``."""

    return {
        "type": "object",
        "required": ["code", "msg", "data", "requestId"],
        "properties": {
            "code": {
                "type": "integer",
                "description": "0 表示成功；其余取值的前若干位为 HTTP 状态码",
                "example": int(ApiCode.OK),
            },
            "msg": {"type": "string", "example": SUCCESS_MESSAGE},
            "data": inner if inner is not None else {"nullable": True},
            "requestId": {"type": "string", "description": "同 X-Request-Id 响应头"},
        },
    }


def _enveloped_operations(app: FastAPI) -> Set[Tuple[str, str]]:
    """``(path, lowercased method)`` for every route that produces an envelope."""

    operations: Set[Tuple[str, str]] = set()
    for route in app.routes:
        if isinstance(route, EnvelopeRoute):
            operations.update((route.path, method.lower()) for method in route.methods)
    return operations


def apply_envelope_to_openapi(app: FastAPI, document: Dict[str, Any]) -> Dict[str, Any]:
    """Rewrite the generated document so ``/docs`` shows the real shape.

    Done as a pass over the finished document rather than by replacing each
    route's ``response_model``: that model is also what FastAPI validates and
    serializes the *return value* against, and route functions return the bare
    payload.  Pointing it at the envelope would make every response fail
    validation.
    """

    enveloped_operations = _enveloped_operations(app)
    for path, operations in document.get("paths", {}).items():
        for method, operation in operations.items():
            if (path, method.lower()) not in enveloped_operations:
                continue
            for response in operation.get("responses", {}).values():
                content = response.get("content", {})
                if "application/json" not in content:
                    continue
                json_content = content["application/json"]
                json_content["schema"] = enveloped_schema(json_content.get("schema"))
    return document


def install_openapi_envelope(app: FastAPI) -> None:
    """Make ``app.openapi()`` describe enveloped responses, caching as FastAPI does."""

    base_openapi = app.openapi

    def openapi() -> Dict[str, Any]:
        if not app.openapi_schema:
            app.openapi_schema = apply_envelope_to_openapi(app, base_openapi())
        return app.openapi_schema

    app.openapi = openapi  # type: ignore[method-assign]


__all__ = [
    "EnvelopeRoute",
    "apply_envelope_to_openapi",
    "enveloped",
    "enveloped_schema",
    "envelope_response",
    "install_openapi_envelope",
    "request_trace_id",
]
