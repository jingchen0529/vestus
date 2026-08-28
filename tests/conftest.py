from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[TestClient, object]]:
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

    # app.py creates a module-level Database, so reload it after applying the
    # test environment. This keeps production code untouched and prevents
    # tests from connecting to the default MySQL instance.
    import importlib
    import app as app_module

    app_module = importlib.reload(app_module)
    with TestClient(app_module.app, client=("198.51.100.27", 50000)) as client:
        yield client, app_module
