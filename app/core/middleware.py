"""ASGI middleware: request identity, response hardening headers, upload limit.

Registration order in ``create_app()`` is load bearing.  Starlette treats the
most recently added middleware as the outermost layer, so the historic order
(CORS, then the upload limiter, then the header pass) yields
``SecurityHeaders -> UploadBodyLimit -> CORS -> router`` and must be preserved.
``RequestIdMiddleware`` is added last, and therefore sits outside all of them:
the id has to exist before anything can log or return it, including the 413 that
``UploadBodyLimitMiddleware`` writes itself.
"""

from __future__ import annotations

import os

from starlette.formparsers import MultiPartException
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.api_contract import ApiCode, envelope_body
from app.core.uploads import upload_max_bytes

UPLOAD_MULTIPART_OVERHEAD_BYTES = 64 * 1024
UPLOAD_ROUTE_PATH = "/api/admin/uploads"

REQUEST_ID_HEADER = "X-Request-Id"
REQUEST_ID_MAX_LENGTH = 36

ADMIN_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; connect-src 'self'; "
    "img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)


def sanitized_request_id(value: str) -> str:
    """Keep only characters that are safe to embed in a log line.

    An upstream-supplied id is written to the audit table and echoed back in a
    header, so a value carrying newlines or control characters could forge log
    entries.  Filtering to printable ASCII costs nothing and closes that off.
    """

    return "".join(character for character in value if "!" <= character <= "~")[
        :REQUEST_ID_MAX_LENGTH
    ]


def new_request_id() -> str:
    return os.urandom(16).hex()


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Give every request one id, shared by its audit rows and its response.

    Without this, :func:`app.api.deps.request_id` minted a fresh random value on
    each call, so the id in an audit row could not be matched against the one the
    client was told.  Resolving it once per request and storing it on
    ``request.state`` makes ``requestId`` in the response envelope and
    ``request_id`` in ``user_log`` the same string.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        supplied = sanitized_request_id(request.headers.get(REQUEST_ID_HEADER, ""))
        request.state.request_id = supplied or new_request_id()
        response = await call_next(request)
        response.headers.setdefault(REQUEST_ID_HEADER, request.state.request_id)
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add conservative defaults; never override a header a route already set."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if request.url.path in {"/admin", "/admin/"}:
            response.headers.setdefault("Content-Security-Policy", ADMIN_CONTENT_SECURITY_POLICY)
            response.headers.setdefault("Cache-Control", "no-store")
        return response


class UploadRequestTooLarge(MultiPartException):
    """Stop multipart parsing while letting Starlette close partial uploads."""


def _route_path(scope: Scope) -> str:
    path = scope["path"]
    root_path = scope.get("root_path", "")
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ""
    return path[len(root_path):] if path[len(root_path)] == "/" else path


class UploadBodyLimitMiddleware:
    """Bound upload request bytes from ASGI receive messages.

    The wrapper deliberately does not pre-read the body. FastAPI can therefore
    finish authentication before the route asks for multipart data, while the
    byte count still covers chunked requests without a Content-Length header.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("method") != "POST" or _route_path(scope) != UPLOAD_ROUTE_PATH:
            await self.app(scope, receive, send)
            return

        request_limit = upload_max_bytes() + UPLOAD_MULTIPART_OVERHEAD_BYTES
        received = 0
        too_large = False

        async def limited_receive() -> Message:
            nonlocal received, too_large
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > request_limit:
                    too_large = True
                    raise UploadRequestTooLarge("上传请求体超过大小限制")
            return message

        async def limited_send(message: Message) -> None:
            # Request.form converts MultiPartException to a 400 response after
            # closing partial files. Preserve that cleanup and correct the
            # transport-level status here.
            if too_large and message["type"] == "http.response.start":
                message = {**message, "status": 413}
            await send(message)

        try:
            await self.app(scope, limited_receive, limited_send)
        except UploadRequestTooLarge as exc:
            # Written here, outside the exception handlers, so this one response
            # has to assemble the envelope itself.
            response = JSONResponse(
                status_code=413,
                content=envelope_body(
                    code=ApiCode.PAYLOAD_TOO_LARGE,
                    msg=exc.message,
                    request_id=scope.get("state", {}).get("request_id", ""),
                ),
            )
            await response(scope, receive, send)


__all__ = [
    "ADMIN_CONTENT_SECURITY_POLICY",
    "REQUEST_ID_HEADER",
    "UPLOAD_MULTIPART_OVERHEAD_BYTES",
    "RequestIdMiddleware",
    "SecurityHeadersMiddleware",
    "UploadBodyLimitMiddleware",
    "new_request_id",
    "sanitized_request_id",
]
