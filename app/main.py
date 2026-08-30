"""ASGI entry point: ``uvicorn app.main:app``.

``create_app()`` is the only place that knows how the layers fit together.  It
validates configuration, opens the database, registers middleware and routers,
and maps domain errors onto HTTP responses.  The application object is also
exposed at module level because the deployment contract is literally
``uvicorn app.main:app``; tests build their own instance through the factory so
each one gets an isolated :class:`~app.db.session.Database`.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.exc import SQLAlchemyError
from starlette.responses import JSONResponse

from app.api.routers import ROUTERS, system
from app.core.config import validate_startup_settings
from app.core.middleware import SecurityHeadersMiddleware, UploadBodyLimitMiddleware
from app.db.session import Database
from app.services.errors import ServiceError

API_TITLE = "Vestus Web Admin API"
API_VERSION = "2.0.0"
API_DESCRIPTION = "管理员管理桌面端用户和审计日志的 MySQL 后台"
DATABASE_UNAVAILABLE_DETAIL = "数据库暂时不可用"


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
    # SecurityHeaders -> UploadBodyLimit -> CORS -> router, matching the
    # pre-refactor stack.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(UploadBodyLimitMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)

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
    return app


def register_exception_handlers(app: FastAPI) -> None:
    """Translate the two error families routers deliberately do not catch."""

    @app.exception_handler(ServiceError)
    async def service_error_handler(_request: Request, exc: ServiceError) -> JSONResponse:
        # Starlette resolves handlers by walking ``type(exc).__mro__``, so every
        # subclass (including ``BadRequestError``, which is also a ``ValueError``)
        # lands here with its own ``status_code``.
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(SQLAlchemyError)
    async def sqlalchemy_error_handler(_request: Request, _exc: SQLAlchemyError) -> JSONResponse:
        return JSONResponse({"detail": DATABASE_UNAVAILABLE_DETAIL}, status_code=503)


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=False)


__all__ = ["app", "create_app", "register_exception_handlers"]
