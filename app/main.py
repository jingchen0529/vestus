"""ASGI entry point: ``uvicorn app.main:app``.

``create_app()`` is the only place that knows how the layers fit together.  It
validates configuration, opens the database, registers middleware and routers,
and maps every error family onto the response envelope.  The application object
is also exposed at module level because the deployment contract is literally
``uvicorn app.main:app``; tests build their own instance through the factory so
each one gets an isolated :class:`~app.db.session.Database`.
"""

from __future__ import annotations

from http import HTTPStatus
from typing import Any, Dict, List

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from app.api.envelope import envelope_response, install_openapi_envelope
from app.api.routers import ROUTERS, system
from app.core.api_contract import ApiCode
from app.core.config import validate_startup_settings
from app.core.middleware import (
    RequestIdMiddleware,
    SecurityHeadersMiddleware,
    UploadBodyLimitMiddleware,
)
from app.db.session import Database
from app.services.errors import ServiceError

API_TITLE = "Vestus Web Admin API"
API_VERSION = "2.0.0"
API_DESCRIPTION = "管理员管理桌面端用户和审计日志的 MySQL 后台"
DATABASE_UNAVAILABLE_DETAIL = "数据库暂时不可用"
INTERNAL_ERROR_DETAIL = "服务内部错误"
VALIDATION_FAILED_DETAIL = "请求参数校验失败"

#: A validation summary is for a human reading a toast, not for parsing; the
#: machine-readable form travels in ``data.errors``.
VALIDATION_MESSAGE_MAX_ERRORS = 3
VALIDATION_MESSAGE_MAX_LENGTH = 200

#: Starlette raises the router-layer 404 and 405 with the standard English phrase
#: as their detail.  Those two now reach a user's toast, and every other message
#: this API produces is Chinese.
ROUTER_ERROR_MESSAGES = {
    404: "请求的接口不存在",
    405: "该接口不支持此请求方法",
}


def http_error_message(exc: HTTPException) -> str:
    """``exc.detail``, unless it is only the phrase Starlette filled in itself.

    ``HTTPException`` defaults ``detail`` to ``HTTPStatus(status).phrase`` when
    the raiser passes none, so a detail equal to that phrase is how a default is
    told apart from the deliberate Chinese message a router wrote -- the routers
    that raise 404 by hand all pass their own, and keep it.
    """

    detail = str(exc.detail).strip() if exc.detail is not None else ""
    if exc.status_code not in ROUTER_ERROR_MESSAGES:
        return detail
    try:
        standard_phrase = HTTPStatus(exc.status_code).phrase
    except ValueError:  # pragma: no cover - a non-standard status has no phrase
        standard_phrase = ""
    if not detail or detail == standard_phrase:
        return ROUTER_ERROR_MESSAGES[exc.status_code]
    return detail


def create_app(database: Database | None = None) -> FastAPI:
    """Build the application.

    ``database`` exists for tests; production passes nothing and gets an engine
    built from the validated settings.  Secrets are checked *before* the engine
    is opened so a misconfigured deployment fails fast (F-01) instead of serving
    traffic with a weak signing key.
    """
    settings = validate_startup_settings()

    app = FastAPI(title=API_TITLE, version=API_VERSION, description=API_DESCRIPTION)
    app.state.db = database if database is not None else Database()

    # Registration order is load bearing: Starlette makes the most recently
    # added middleware the outermost layer, so this yields
    # RequestId -> SecurityHeaders -> route body limits -> CORS -> router.  The
    # inner three keep the pre-refactor order; RequestId goes outside all of
    # them because the id must exist before anything can log or return it.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(UploadBodyLimitMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RequestIdMiddleware)

    for router in ROUTERS:
        app.include_router(router)

    # Only mount the built admin bundle when it exists; a source checkout
    # without ``web/dist`` still has to boot.
    if system.ADMIN_ASSETS_DIR.is_dir():
        from starlette.staticfiles import StaticFiles

        app.mount(
            "/assets",
            StaticFiles(directory=str(system.ADMIN_ASSETS_DIR)),
            name="admin_assets",
        )

    register_exception_handlers(app)
    install_openapi_envelope(app)
    return app


def validation_message(errors: List[Dict[str, Any]]) -> str:
    """Condense Pydantic's error list into one readable sentence."""

    parts: List[str] = []
    for error in errors[:VALIDATION_MESSAGE_MAX_ERRORS]:
        location = [str(part) for part in error.get("loc", ()) if part not in {"body", "query"}]
        message = str(error.get("msg", "")).strip()
        parts.append(f"{'.'.join(location)}: {message}" if location else message)
    summary = "；".join(part for part in parts if part)
    return summary[:VALIDATION_MESSAGE_MAX_LENGTH] or VALIDATION_FAILED_DETAIL


def register_exception_handlers(app: FastAPI) -> None:
    """Route every error family into the envelope.

    Before this existed only ``ServiceError`` and ``SQLAlchemyError`` were
    handled; ``HTTPException`` and ``RequestValidationError`` fell through to
    FastAPI's own handlers, which is why the API used to answer with three
    different error shapes.
    """

    @app.exception_handler(ServiceError)
    async def service_error_handler(request: Request, exc: ServiceError) -> JSONResponse:
        # Starlette resolves handlers by walking ``type(exc).__mro__``, so every
        # subclass (including ``BadRequestError``, which is also a ``ValueError``)
        # lands here with its own ``status_code`` and ``code``.
        return envelope_response(
            request, status_code=exc.status_code, code=exc.code, msg=exc.detail
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
        # Registered against *Starlette's* HTTPException, not FastAPI's subclass.
        # Handler lookup walks ``type(exc).__mro__``, so registering the subclass
        # would catch only the ones routers raise themselves and miss the ones
        # the router layer raises -- the 404 for an unmatched path and the 405 for
        # a known path with the wrong method both come from Starlette and would
        # have kept answering with its bare ``{"detail": ...}``.
        #
        # ``exc.headers`` is not decoration: it carries ``WWW-Authenticate`` from
        # the auth dependencies and ``Cache-Control: no-store`` from /api/network/ip.
        return envelope_response(
            request,
            status_code=exc.status_code,
            code=ApiCode.for_status(exc.status_code),
            msg=http_error_message(exc),
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        errors = jsonable_encoder(exc.errors())
        return envelope_response(
            request,
            status_code=422,
            code=ApiCode.UNPROCESSABLE,
            msg=validation_message(errors),
            data={"errors": errors},
        )

    @app.exception_handler(SQLAlchemyError)
    async def sqlalchemy_error_handler(request: Request, _exc: SQLAlchemyError) -> JSONResponse:
        return envelope_response(
            request,
            status_code=503,
            code=ApiCode.DATABASE_UNAVAILABLE,
            msg=DATABASE_UNAVAILABLE_DETAIL,
        )

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, _exc: Exception) -> JSONResponse:
        # Deliberately says nothing about the cause: an unexpected exception's
        # message is as likely to hold a connection string as a useful hint.
        # ``X-Request-Id`` is how the client ties this back to the server log.
        return envelope_response(
            request, status_code=500, code=ApiCode.INTERNAL, msg=INTERNAL_ERROR_DETAIL
        )


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=False)


__all__ = [
    "app",
    "create_app",
    "http_error_message",
    "register_exception_handlers",
    "validation_message",
]
