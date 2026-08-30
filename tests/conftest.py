"""Shared test harness.

Every test builds its own application through :func:`app.main.create_app`
against an isolated SQLite file, so the suite never touches the configured MySQL
server.

The fixture yields ``(client, module)``.  ``module`` keeps the flat surface the
tests were written against -- ``module.db.<verb>``, ``module.<Model>``,
``module.utc_now`` -- even though the verbs now live in ``app.services`` and the
models in ``app.db.models``.  Preserving that seam is deliberate: the assertions
stay a check on behaviour instead of turning into a check on the file layout.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, Iterator, List, Optional

import pytest
from fastapi.testclient import TestClient


class DatabaseFacade:
    """The pre-refactor ``db.<verb>`` API, delegating to the service layer.

    Infrastructure attributes the tests reach for (``engine``, ``session``,
    ``initialize``, ``ping``) fall through to the real
    :class:`app.db.session.Database` through :meth:`__getattr__`, so SQLAlchemy
    event listeners still attach to the live engine.
    """

    def __init__(self, database: Any, services: Any) -> None:
        self._database = database
        self._services = services

    def __getattr__(self, name: str) -> Any:
        return getattr(self._database, name)

    # --- uploads ---------------------------------------------------------
    def create_uploaded_file(self, **values: Any) -> Dict[str, Any]:
        return self._services.uploads.create_uploaded_file(self._database, **values)

    def get_uploaded_file_by_path(self, path: str) -> Optional[Dict[str, Any]]:
        return self._services.uploads.get_uploaded_file_by_path(self._database, path)

    # --- settings and branding -------------------------------------------
    def get_branding(self) -> Dict[str, str]:
        return self._services.settings.get_branding(self._database)

    def set_branding(self, **values: Any) -> Dict[str, str]:
        return self._services.settings.set_branding(self._database, **values)

    def set_setting(self, key: str, value: str) -> None:
        self._services.settings.set_setting(self._database, key, value)

    # --- platforms -------------------------------------------------------
    def list_platforms(self) -> List[Dict[str, Any]]:
        return self._services.platforms.list_platforms(self._database)

    def get_platform(self, platform_id: int | str) -> Optional[Dict[str, Any]]:
        return self._services.platforms.get_platform(self._database, platform_id)

    def insert_platform(self, values: Dict[str, Any]) -> Dict[str, Any]:
        return self._services.platforms.create_platform(self._database, values)

    def update_platform(self, platform_id: int | str, values: Dict[str, Any]) -> Dict[str, Any]:
        return self._services.platforms.update_platform(self._database, platform_id, values)

    # --- proxies ---------------------------------------------------------
    def insert_proxy(self, values: Dict[str, Any]) -> Dict[str, Any]:
        return self._services.proxies.create_proxy(self._database, values)

    def update_proxy(self, proxy_id: int | str, values: Dict[str, Any]) -> Dict[str, Any]:
        return self._services.proxies.update_proxy(self._database, proxy_id, values)

    # --- desktop ---------------------------------------------------------
    def get_user_desktop_config_with_lease(self, user_id: int | str) -> Optional[Dict[str, Any]]:
        return self._services.desktop.get_user_desktop_config_with_lease(self._database, user_id)


@pytest.fixture()
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[TestClient, Any]]:
    """Load the application against an explicit, isolated SQLite database."""
    database_url = f"sqlite:///{tmp_path / 'vestus-test.sqlite'}"
    monkeypatch.setenv("VESTUS_DATABASE_URL", database_url)
    monkeypatch.setenv("VESTUS_BOOTSTRAP_ADMIN_USERNAME", "test-admin")
    monkeypatch.setenv("VESTUS_BOOTSTRAP_ADMIN_PASSWORD", "test-admin-password")
    monkeypatch.setenv("VESTUS_SECRET_KEY", "test-secret-key-that-is-long-enough")
    monkeypatch.setenv("VESTUS_ACCESS_TOKEN_TTL_SECONDS", "900")
    monkeypatch.setenv("VESTUS_LOGIN_MAX_ATTEMPTS", "20")
    monkeypatch.setenv("VESTUS_UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setenv("VESTUS_UPLOAD_MAX_BYTES", str(10 * 1024 * 1024))

    # Imported here, not at module scope: settings are read when the engine is
    # built, so the environment above has to be in place first.
    from sqlalchemy.exc import SQLAlchemyError

    from app.db import models
    from app.db.base import utc_now
    from app.db.session import Database
    from app.main import create_app
    from app.services import desktop as desktop_service
    from app.services import platforms as platforms_service
    from app.services import proxies as proxies_service
    from app.services import settings as settings_service
    from app.services import uploads as uploads_service

    services = SimpleNamespace(
        desktop=desktop_service,
        platforms=platforms_service,
        proxies=proxies_service,
        settings=settings_service,
        uploads=uploads_service,
    )
    database = Database()
    application = create_app(database)
    module = SimpleNamespace(
        app=application,
        db=DatabaseFacade(database, services),
        services=services,
        utc_now=utc_now,
        SQLAlchemyError=SQLAlchemyError,
        Admin=models.Admin,
        Platform=models.Platform,
        Proxy=models.Proxy,
        SystemSetting=models.SystemSetting,
        UploadedFile=models.UploadedFile,
        User=models.User,
        UserLog=models.UserLog,
        UserPlatformAssignment=models.UserPlatformAssignment,
        UserProxyAssignment=models.UserProxyAssignment,
    )
    try:
        with TestClient(application, client=("198.51.100.27", 50000)) as client:
            yield client, module
    finally:
        database.dispose()
