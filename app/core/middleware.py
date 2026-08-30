"""ASGI middleware: response hardening headers and the upload body limit.

Registration order in ``create_app()`` is load bearing.  Starlette treats the
most recently added middleware as the outermost layer, so the historic order
(CORS, then the upload limiter, then the header pass) yields
``SecurityHeaders -> UploadBodyLimit -> CORS -> router`` and must be preserved.
"""

from __future__ import annotations

from starlette.formparsers import MultiPartException
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.uploads import upload_max_bytes

UPLOAD_MULTIPART_OVERHEAD_BYTES = 64 * 1024
UPLOAD_ROUTE_PATH = "/api/admin/uploads"

ADMIN_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; connect-src 'self'; "
    "img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)


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
            response = JSONResponse(status_code=413, content={"detail": exc.message})
            await response(scope, receive, send)


__all__ = [
    "ADMIN_CONTENT_SECURITY_POLICY",
    "UPLOAD_MULTIPART_OVERHEAD_BYTES",
    "SecurityHeadersMiddleware",
    "UploadBodyLimitMiddleware",
]
