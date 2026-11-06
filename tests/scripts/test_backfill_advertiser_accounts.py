"""Exercise the backfill CLI in isolated subprocesses and temporary SQLite files."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, create_engine, inspect, select

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Engine]:
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.setattr("dotenv.load_dotenv", lambda *args, **kwargs: False)
    from app.db.base import Base
    from app.db.models import BrowserPageAdvertiser, BrowserPageVisit, BrowserSession

    engine = create_engine(f"sqlite:///{tmp_path / 'history.sqlite'}")
    Base.metadata.create_all(engine, tables=[
        BrowserSession.__table__, BrowserPageVisit.__table__, BrowserPageAdvertiser.__table__,
    ])
    with engine.begin() as connection:
        connection.execute(BrowserSession.__table__.insert().values(
            id=1, user_id=1, username="synthetic-user", session_key="historical-session", browser_id=1,
            platform_id=1, managed_account_id=7, managed_account_name="Original name", page_count=7,
            visits=91, clicks=23, inputs=17, submits=11, scrolls=37, dwell_ms=101, dropped_pages=5,
        ))
        for page_id, url, params in (
            (2, "https://localads.chengzijianzhan.cn/a", "advid=123"),
            (5, "https://business.oceanengine.com/b", "advid=456&advid=456"),
            (9, "https://oceanengine.com/c", "advid=789"),
            (12, "https://example.test/a", "advid=123"),
            (20, "https://oceanengine.com/a", "other=123"),
            (21, "https://oceanengine.com/a", "advid=0"),
            (40, "https://oceanengine.com/a", "advid=123&advid=456"),
        ):
            connection.execute(BrowserPageVisit.__table__.insert().values(
                id=page_id, session_id=1, url=url, url_params=params, url_hash=f"unchanged-hash-{page_id}",
                visits=page_id, clicks=3, inputs=5, submits=7, scrolls=11, dwell_ms=13,
                input_snapshot={"q": ["synthetic"]}, submit_snapshot={"x": ["synthetic"]},
            ))
    try:
        yield engine
    finally:
        engine.dispose()


def _run(history: Engine, *args: str, use_default: bool = False) -> subprocess.CompletedProcess[str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("VESTUS_", "PYTHON"))}
    env.update({
        "PYTHON_DOTENV_DISABLED": "1",
        "VESTUS_DATABASE_URL": str(history.url),
        "VESTUS_MANAGED_RECOVERY_ENABLED": "0",
        "VESTUS_BOOTSTRAP_ADMIN_PASSWORD": "synthetic-do-not-print-password",
    })
    # Disable dotenv before application imports even with older python-dotenv.
    launcher = (
        "import sys, runpy, dotenv; "
        "dotenv.load_dotenv = lambda *a, **k: False; "
        "sys.path.insert(0, sys.argv.pop(1)); "
        "runpy.run_module('scripts.backfill_advertiser_accounts', run_name='__main__')"
    )
    explicit_url = [] if use_default else ["--database-url", str(history.url)]
    return subprocess.run(
        [sys.executable, "-I", "-c", launcher, str(ROOT), *explicit_url, *args],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=30, check=False,
    )


def _stats(result: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    assert result.returncode == 0, result.stderr
    assert "sqlite:" not in result.stdout + result.stderr
    assert "synthetic-do-not-print-password" not in result.stdout + result.stderr
    return json.loads(result.stdout)


def _source_rows(history: Engine) -> dict[str, Any]:
    from app.db.models import BrowserPageVisit, BrowserSession

    with history.connect() as connection:
        return {
            "tables": inspect(connection).get_table_names(),
            "pages": connection.execute(select(BrowserPageVisit.__table__).order_by(BrowserPageVisit.id)).all(),
            "sessions": connection.execute(select(BrowserSession.__table__)).all(),
        }


def _indexes(history: Engine) -> list[Any]:
    from app.db.models import BrowserPageAdvertiser

    with history.connect() as connection:
        return list(connection.execute(select(BrowserPageAdvertiser.__table__).order_by(BrowserPageAdvertiser.page_id)))


def test_default_preview_reports_matches_without_writes_or_bootstrap(history: Engine) -> None:
    before = _source_rows(history)

    stats = _stats(_run(history, use_default=True))

    assert stats == {
        "dryRun": True, "scanned": 7, "matched": 3, "indexed": 0, "wouldIndex": 3,
        "skipped": 4, "existing": 0, "unsupported": 1, "missing": 1, "invalid": 1,
        "ambiguous": 1, "lastPageId": 40, "batches": 1, "completed": True,
    }
    assert _indexes(history) == []
    assert _source_rows(history) == before


def test_apply_is_idempotent_and_preserves_online_indexes_and_source_counters(history: Engine) -> None:
    from sqlalchemy.orm import Session

    from app.repositories.advertiser_accounts import ensure_index

    with Session(history) as session, session.begin():
        ensure_index(session, 2, "123")
    before = _source_rows(history)

    stats = _stats(_run(history, "--apply"))

    assert stats == {
        "dryRun": False, "scanned": 7, "matched": 3, "indexed": 2, "wouldIndex": 0,
        "skipped": 5, "existing": 1, "unsupported": 1, "missing": 1, "invalid": 1,
        "ambiguous": 1, "lastPageId": 40, "batches": 1, "completed": True,
    }
    assert _indexes(history) == [(2, "123"), (5, "456"), (9, "789")]
    again = _stats(_run(history, "--apply"))
    assert again["indexed"] == 0
    assert again["existing"] == 3
    assert again["skipped"] == 7
    assert _indexes(history) == [(2, "123"), (5, "456"), (9, "789")]
    assert _source_rows(history) == before


def test_keyset_batches_resume_after_last_committed_page(history: Engine) -> None:
    before = _source_rows(history)

    first = _stats(_run(history, "--apply", "--batch-size", "2", "--max-batches", "1"))

    assert first["scanned"] == 2
    assert first["indexed"] == 2
    assert first["lastPageId"] == 5
    assert first["batches"] == 1
    assert first["completed"] is False
    assert _indexes(history) == [(2, "123"), (5, "456")]
    resumed = _stats(_run(history, "--apply", "--batch-size", "2", "--after-id", "5"))
    assert resumed["scanned"] == 5
    assert resumed["matched"] == 1
    assert resumed["indexed"] == 1
    assert resumed["lastPageId"] == 40
    assert resumed["batches"] == 3
    assert resumed["completed"] is True
    end = _stats(_run(history, "--after-id", "40", "--batch-size", "1"))
    assert end["scanned"] == 0
    assert end["lastPageId"] == 40
    assert end["batches"] == 0
    assert end["completed"] is True
    assert _indexes(history) == [(2, "123"), (5, "456"), (9, "789")]
    assert _source_rows(history) == before


@pytest.mark.parametrize("option,value", [
    ("--batch-size", "0"), ("--batch-size", "-1"), ("--batch-size", "1001"),
    ("--max-batches", "0"), ("--max-batches", "-1"), ("--after-id", "-1"),
])
def test_invalid_batch_controls_are_rejected_without_writes(history: Engine, option: str, value: str) -> None:
    before = _source_rows(history)

    result = _run(history, "--apply", option, value)

    assert result.returncode == 2
    assert option in result.stderr
    assert "sqlite:" not in result.stdout + result.stderr
    assert _indexes(history) == []
    assert _source_rows(history) == before


@pytest.mark.parametrize("batch_size,expected", [(1, [(2, "123"), (5, "456")]), (3, [])])
def test_failure_rolls_back_only_failed_batch_without_printing_secrets(
    history: Engine, batch_size: int, expected: list[tuple[int, str]],
) -> None:
    with history.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TRIGGER reject_index BEFORE INSERT ON browser_page_advertiser "
            "WHEN NEW.page_id = 9 BEGIN "
            "SELECT RAISE(ABORT, 'sqlite:///synthetic-secret-url synthetic-do-not-print-password'); END"
        )
    before = _source_rows(history)

    result = _run(history, "--apply", "--batch-size", str(batch_size))

    assert result.returncode == 1
    stats = json.loads(result.stdout)
    assert stats["completed"] is False
    assert stats["error"] == "backfill_failed"
    assert stats["lastPageId"] == (5 if expected else 0)
    assert stats["scanned"] == stats["indexed"] == len(expected)
    assert "synthetic-secret-url" not in result.stdout + result.stderr
    assert "synthetic-do-not-print-password" not in result.stdout + result.stderr
    assert "Traceback" not in result.stdout + result.stderr
    assert _indexes(history) == expected
    assert _source_rows(history) == before
