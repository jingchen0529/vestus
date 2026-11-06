"""Advertiser migration preserves history and only cascades deleted page indexes."""

from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import Connection, MetaData, Table, create_engine, inspect, select

NOW = datetime(2026, 11, 6, 1, 2, 3, 123456)
NEW_COLUMNS = {
    "browser_session": {
        "bootstrap_session_id", "remote_account_id", "remote_display_name",
        "credential_version", "identity_snapshot_at", "identity_verified_at",
    },
    "managed_browser_session": {
        "remote_account_id", "remote_display_name", "managed_account_name",
        "identity_snapshot_at", "identity_verified_at",
    },
}


def _schema(connection: Connection, name: str) -> dict[str, Any]:
    inspector = inspect(connection)
    return {
        "columns": [{**column, "type": str(column["type"])} for column in inspector.get_columns(name)],
        "indexes": inspector.get_indexes(name),
        "unique": inspector.get_unique_constraints(name),
        "primary": inspector.get_pk_constraint(name),
        "foreign": inspector.get_foreign_keys(name),
    }


def test_advertiser_upgrade_and_downgrade_preserve_history(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.setattr("dotenv.load_dotenv", lambda *args, **kwargs: False)
    database_url = f"sqlite:///{tmp_path / 'advertiser-migration.sqlite'}"
    monkeypatch.setenv("VESTUS_DATABASE_URL", database_url)
    from app.db.base import Base

    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[2] / "migrations"))
    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql("PRAGMA foreign_keys=ON")
            assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
            config.attributes["connection"] = connection
            command.upgrade(config, "0017")
            tables = {
                name: Table(name, MetaData(), autoload_with=connection)
                for name in (*NEW_COLUMNS, "browser_page_visit", "managed_platform_account")
            }
            connection.execute(tables["managed_platform_account"].insert().values(
                id=17, platform_id=1, name="Current account name", auth_mode="cookie",
                allowed_hosts=["oceanengine.com"], credential_version=23, status="active",
                session_status="valid", auto_relogin=False, recovery_status="idle", recovery_attempts=0,
                remote_account_id="current-not-historical", remote_display_name="Current identity",
                identity_checked_at=NOW, last_verified_at=NOW, created_at=NOW, updated_at=NOW,
            ))
            connection.execute(tables["managed_browser_session"].insert().values(
                id=19, grant_hash="synthetic-grant-hash", user_id=1, platform_id=1, managed_account_id=17,
                credential_version=7, expires_at=NOW, consumed_at=NOW, created_at=NOW,
            ))
            connection.execute(tables["browser_session"].insert().values(
                id=1, user_id=1, username="synthetic-user", session_key="legacy-session", browser_id=9,
                platform_id=1, platform_name="Legacy platform", managed_account_id=17,
                managed_account_name="Legacy account name", direct_mode=False, page_count=1, visits=11,
                clicks=13, inputs=17, submits=19, scrolls=23, dwell_ms=29, dropped_pages=3,
                started_at=NOW, last_report_at=NOW, created_at=NOW,
            ))
            connection.execute(tables["browser_page_visit"].insert().values(
                id=1, session_id=1, url="https://localads.chengzijianzhan.cn/report", url_params="advid=123",
                url_hash="legacy-page-hash", visits=11, clicks=13, inputs=17, submits=19, scrolls=23,
                dwell_ms=29, input_snapshot={"q": ["synthetic"]}, input_snapshot_at=NOW,
                first_seen_at=NOW, last_seen_at=NOW,
            ))
            original_tables = inspect(connection).get_table_names()
            original_schemas = {name: _schema(connection, name) for name in tables}
            original_rows = {
                name: dict(connection.execute(select(table)).mappings().one()) for name, table in tables.items()
            }

            command.upgrade(config, "0018")

            assert MigrationContext.configure(connection).get_current_revision() == "0018"
            for name, old_table in tables.items():
                table = Table(name, MetaData(), autoload_with=connection)
                added = NEW_COLUMNS.get(name, set())
                assert set(table.c.keys()) == set(old_table.c.keys()) | added
                for column in added:
                    assert table.c[column].nullable is True
                    assert table.c[column].server_default is None
                assert dict(connection.execute(select(table)).mappings().one()) == {
                    **original_rows[name], **dict.fromkeys(added),
                }
            index = Table("browser_page_advertiser", MetaData(), autoload_with=connection)
            assert connection.execute(select(index)).all() == []
            assert inspect(connection).get_pk_constraint(index.name)["constrained_columns"] == ["page_id"]
            assert inspect(connection).get_indexes(index.name) == [{
                "name": "ix_browser_page_advertiser_advertiser_id", "column_names": ["advertiser_id"],
                "unique": 0, "dialect_options": {},
            }]
            assert "ix_browser_session_bootstrap_session_id" in {
                entry["name"] for entry in inspect(connection).get_indexes("browser_session")
            }
            foreign_key = inspect(connection).get_foreign_keys(index.name)[0]
            assert foreign_key["constrained_columns"] == ["page_id"]
            assert foreign_key["referred_table"] == "browser_page_visit"
            assert foreign_key["referred_columns"] == ["id"]
            assert foreign_key["options"] == {"ondelete": "CASCADE"}
            context = MigrationContext.configure(connection, opts={
                "compare_type": True,
                "include_object": lambda _obj, name, kind, _reflected, _compare_to: (
                    kind != "table" or name in {*NEW_COLUMNS, "browser_page_advertiser", "browser_page_visit"}
                ),
            })
            assert compare_metadata(context, Base.metadata) == []

            pages = tables["browser_page_visit"]
            connection.execute(pages.insert().values(**{**original_rows["browser_page_visit"], "id": 2, "url_hash": "delete-me"}))
            connection.execute(index.insert(), [{"page_id": 1, "advertiser_id": "123"}, {"page_id": 2, "advertiser_id": "456"}])
            connection.execute(pages.delete().where(pages.c.id == 2))
            assert connection.execute(select(index)).all() == [(1, "123")]
            assert connection.exec_driver_sql("PRAGMA foreign_key_check").all() == []

            command.downgrade(config, "0017")

            assert MigrationContext.configure(connection).get_current_revision() == "0017"
            assert inspect(connection).get_table_names() == original_tables
            for name in tables:
                assert _schema(connection, name) == original_schemas[name]
                table = Table(name, MetaData(), autoload_with=connection)
                assert dict(connection.execute(select(table)).mappings().one()) == original_rows[name]
    finally:
        engine.dispose()
