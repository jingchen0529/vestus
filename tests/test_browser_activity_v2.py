"""Durable activity uploads: retries, owner isolation, atomicity and compatibility."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from typing import Any

import pytest
from sqlalchemy import func, select

from tests.envelope import payload
from tests.test_browser_activity_api import _bearer, _page, _report, _setup


def _setup_v2(api: Any) -> tuple[Any, Any, str, dict[str, Any]]:
    client, module = api
    admin, token, platform_id = _setup(client)
    user_id = payload(client.get("/api/admin/users", headers=_bearer(admin)))["items"][0]["id"]
    report = _report(_page("https://example.test/a", visits=3, clicks=2), platformId=platform_id,
                     batchId="a" * 64, ownerUserId=user_id, protocolVersion=2)
    return client, module, token, report


def test_v2_retries_do_not_repeat_counters_or_audit(api: Any) -> None:
    from app.db.models import BrowserActivityReceipt, BrowserPageVisit, BrowserSession, UserLog
    client, module, token, report = _setup_v2(api)
    first = client.post("/api/user/browser-activity/v2", json=report, headers=_bearer(token))
    assert first.status_code == 200, first.text
    with module.db.session() as db:
        audit_count = db.scalar(select(func.count()).select_from(UserLog))
    retry = client.post("/api/user/browser-activity/v2", json=report, headers=_bearer(token))
    assert retry.status_code == 200, retry.text
    ack = payload(retry)
    assert ack["acknowledged"] is True and ack["protocolVersion"] == 2
    assert ack["batchId"] == report["batchId"] and ack["newPages"] == 0
    assert ack["sessionId"] == payload(first)["sessionId"]
    with module.db.session() as db:
        assert db.scalar(select(BrowserSession)).visits == 3
        assert db.scalar(select(BrowserPageVisit)).clicks == 2
        assert db.scalar(select(func.count()).select_from(BrowserActivityReceipt)) == 1
        assert db.scalar(select(func.count()).select_from(UserLog)) == audit_count
    report["pages"][0]["visits"] = 4
    conflict = client.post("/api/user/browser-activity/v2", json=report, headers=_bearer(token))
    assert conflict.status_code == 409


def test_v2_rejects_foreign_owner_and_requires_protocol_identity(api: Any) -> None:
    from app.db.models import BrowserActivityReceipt, BrowserSession
    client, module, token, report = _setup_v2(api)
    for field in ("batchId", "ownerUserId", "protocolVersion"):
        malformed = {k: v for k, v in report.items() if k != field}
        assert client.post("/api/user/browser-activity/v2", json=malformed, headers=_bearer(token)).status_code == 422
    for values in ({"batchId": "x" * 64}, {"protocolVersion": 1}, {"ownerUserId": 0}):
        assert client.post("/api/user/browser-activity/v2", json={**report, **values}, headers=_bearer(token)).status_code == 422
    report["ownerUserId"] += 1
    assert client.post("/api/user/browser-activity/v2", json=report, headers=_bearer(token)).status_code == 403
    with module.db.session() as db:
        assert db.scalar(select(func.count()).select_from(BrowserActivityReceipt)) == 0
        assert db.scalar(select(func.count()).select_from(BrowserSession)) == 0


def test_legacy_upload_still_accepts_original_body(api: Any) -> None:
    client, _module, token, report = _setup_v2(api)
    legacy = {k: v for k, v in report.items() if k not in {"batchId", "ownerUserId", "protocolVersion"}}
    response = client.post("/api/user/browser-activity", json=legacy, headers=_bearer(token))
    assert response.status_code == 200, response.text
    assert set(payload(response)) == {"sessionId", "acceptedPages", "newPages"}


def test_receipt_failure_rolls_back_session_and_pages(api: Any, monkeypatch: Any) -> None:
    from app.db.models import BrowserActivityReceipt, BrowserPageVisit, BrowserSession
    from app.repositories import browser_activity as repo
    from app.schemas.browser_activity import BrowserActivityReportV2
    from app.services.browser_activity import record_activity
    _client, module, _token, body = _setup_v2(api)
    report = BrowserActivityReportV2.model_validate(body)
    original = repo.add_receipt
    def fail(*args: Any, **kwargs: Any) -> None:
        original(*args, **kwargs)
        args[0].flush()
        raise RuntimeError("simulated commit failure")
    with monkeypatch.context() as patch:
        patch.setattr(repo, "add_receipt", fail)
        with pytest.raises(RuntimeError, match="simulated commit failure"):
            record_activity(module.db, report, user_id=body["ownerUserId"], username="browsing-user")
    with module.db.session() as db:
        for model in (BrowserActivityReceipt, BrowserPageVisit, BrowserSession):
            assert db.scalar(select(func.count()).select_from(model)) == 0
    assert record_activity(module.db, report, user_id=body["ownerUserId"], username="browsing-user")["acknowledged"]


@pytest.mark.parametrize("duplicate", [True, False])
def test_concurrent_first_batches_and_retries(api: Any, duplicate: bool) -> None:
    from app.db.models import BrowserActivityReceipt, BrowserPageVisit, BrowserSession
    from app.schemas.browser_activity import BrowserActivityReportV2
    from app.services.browser_activity import record_activity
    _client, module, _token, body = _setup_v2(api)
    barrier = Barrier(4)
    def upload(index: int) -> dict[str, Any]:
        report = BrowserActivityReportV2.model_validate({**body, "batchId": "a" * 64 if duplicate else f"{index:064x}"})
        barrier.wait(timeout=10)
        return record_activity(module.db, report, user_id=body["ownerUserId"], username="browsing-user")
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(upload, range(4)))
    assert all(result["acknowledged"] for result in responses)
    count = 1 if duplicate else 4
    with module.db.session() as db:
        assert db.scalar(select(BrowserSession)).visits == 3 * count
        assert db.scalar(select(BrowserPageVisit)).visits == 3 * count
        assert db.scalar(select(func.count()).select_from(BrowserActivityReceipt)) == count
        assert db.scalar(select(func.count()).select_from(BrowserSession)) == 1


def test_v2_body_size_limit(api: Any) -> None:
    client, _module, token, _report_body = _setup_v2(api)
    response = client.post("/api/user/browser-activity/v2", headers={**_bearer(token), "Content-Type": "application/json"},
                           content=b'{"padding":"' + b"x" * (4 * 1024 * 1024) + b'"}')
    assert response.status_code == 413


def test_receipt_migration_preserves_existing_data_and_matches_metadata(tmp_path: Any) -> None:
    from alembic import command
    from alembic.autogenerate import compare_metadata
    from alembic.config import Config
    from alembic.migration import MigrationContext
    from alembic.script import ScriptDirectory
    from sqlalchemy import create_engine, inspect, text

    from app.db.base import Base
    config = Config("alembic.ini")
    assert ScriptDirectory.from_config(config).get_current_head() == "0007"
    engine = create_engine(f"sqlite:///{tmp_path / 'migration.sqlite'}")
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "0006")
            connection.execute(text("INSERT INTO system_setting (key, value, updated_at) VALUES ('keep', 'old', CURRENT_TIMESTAMP)"))
            command.upgrade(config, "head")
            assert connection.scalar(text("SELECT value FROM system_setting WHERE key='keep'")) == "old"
            assert "browser_activity_receipt" in inspect(connection).get_table_names()
            differences = compare_metadata(MigrationContext.configure(connection), Base.metadata)
            assert not [difference for difference in differences if "browser_activity_receipt" in str(difference)]
            command.downgrade(config, "0006")
            assert "browser_activity_receipt" not in inspect(connection).get_table_names()
            assert connection.scalar(text("SELECT value FROM system_setting WHERE key='keep'")) == "old"
    finally:
        engine.dispose()


@pytest.mark.parametrize("v2", [False, True])
def test_same_batch_normalized_addresses_merge_once(api: Any, v2: bool) -> None:
    from app.db.models import BrowserPageVisit, BrowserSession
    client, module, token, report = _setup_v2(api)
    report["pages"] = [
        {**_page("https://example.test/a#first", visits=2), "urlParams": "password=first"},
        {**_page("https://example.test/a#second", visits=3), "urlParams": "password=second"},
    ]
    if not v2:
        report = {key: value for key, value in report.items()
                  if key not in {"batchId", "ownerUserId", "protocolVersion"}}
    path = "/api/user/browser-activity/v2" if v2 else "/api/user/browser-activity"
    response = client.post(path, json=report, headers=_bearer(token))
    assert response.status_code == 200, response.text
    assert payload(response)["newPages"] == 1
    if v2:
        retry = client.post(path, json=report, headers=_bearer(token))
        assert retry.status_code == 200 and payload(retry)["newPages"] == 0
    with module.db.session() as db:
        page = db.scalars(select(BrowserPageVisit)).one()
        session = db.scalars(select(BrowserSession)).one()
        assert page.visits == session.visits == 5
        assert page.url == "https://example.test/a"
        assert page.url_params == "password=%5BREDACTED%5D"
        assert session.page_count == 1
