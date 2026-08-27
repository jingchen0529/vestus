from __future__ import annotations

import pytest

import init_db
from db import Database


@pytest.mark.parametrize("configured_url", [None, "", "   "])
def test_database_requires_an_explicit_connection_url(
    monkeypatch: pytest.MonkeyPatch,
    configured_url: str | None,
) -> None:
    if configured_url is None:
        monkeypatch.delenv("VESTUS_DATABASE_URL", raising=False)
    else:
        monkeypatch.setenv("VESTUS_DATABASE_URL", configured_url)

    with pytest.raises(RuntimeError, match="VESTUS_DATABASE_URL"):
        Database(initialize=False)


def test_init_db_redacts_the_database_password(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    database = Database(
        "mysql+pymysql://vestus:server-only-secret@127.0.0.1:3306/vestus?charset=utf8mb4",
        initialize=False,
    )
    monkeypatch.setattr(init_db, "Database", lambda: database)
    monkeypatch.setattr(init_db.Base.metadata, "create_all", lambda _engine: None)

    init_db.main()

    output = capsys.readouterr().out
    assert "server-only-secret" not in output
    assert "mysql+pymysql://vestus:***@127.0.0.1:3306/vestus" in output
