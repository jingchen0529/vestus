from __future__ import annotations

from typing import Any

from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from file_storage import upload_max_bytes


UPLOAD_MULTIPART_OVERHEAD_BYTES = 64 * 1024
UPLOAD_ROUTE_PATH = "/api/admin/uploads"


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
    "UPLOAD_MULTIPART_OVERHEAD_BYTES",
    "UploadBodyLimitMiddleware",
]
