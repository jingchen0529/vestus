"""Incremental managed identity-check migrations preserve existing accounts."""

from datetime import datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import MetaData, Table, create_engine, inspect, select


def test_identity_check_migration_preserves_accounts_and_matches_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'managed-identity-migration.sqlite'}"
    # Alembic imports application settings; never read the checkout's .env.
    monkeypatch.setattr("dotenv.load_dotenv", lambda *args, **kwargs: False)
    monkeypatch.setenv("VESTUS_DATABASE_URL", database_url)

    from app.db.base import Base

    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[2] / "migrations"))
    engine = create_engine(database_url)
    table_name = "managed_platform_account"
    check_columns = {
        "last_identity_check_state",
        "last_identity_check_at",
        "last_identity_check_detail",
    }
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "0015")
            legacy_accounts = Table(table_name, MetaData(), autoload_with=connection)
            legacy_columns = set(legacy_accounts.c.keys())
            legacy_tables = inspect(connection).get_table_names()
            legacy_indexes = inspect(connection).get_indexes(table_name)
            legacy_constraints = inspect(connection).get_unique_constraints(table_name)
            assert check_columns.isdisjoint(legacy_columns)

            connection.execute(
                legacy_accounts.insert().values(
                    id=1,
                    platform_id=1,
                    name="Synthetic migration account",
                    auth_mode="cookie",
                    cookie_bundle=[{
                        "name": "session",
                        "value": "synthetic-migration-cookie",
                        "domain": "migration.example.test",
                        "path": "/",
                    }],
                    encrypted_cookie_bundle=b"synthetic-legacy-cookie",
                    allowed_hosts=["migration.example.test"],
                    credential_version=7,
                    status="disabled",
                    session_status="invalid",
                    remote_account_id="synthetic-account-17",
                    remote_display_name="Synthetic identity",
                    identity_checked_at=datetime(2026, 11, 1, 2, 3, 4, 123456),
                    last_verified_at=datetime(2026, 11, 1, 2, 3, 5, 654321),
                    created_at=datetime(2026, 10, 1, 0, 0, 0, 123456),
                    updated_at=datetime(2026, 11, 1, 2, 3, 6, 234567),
                )
            )
            legacy_row = dict(connection.execute(select(legacy_accounts)).mappings().one())

            command.upgrade(config, "head")
            upgraded_accounts = Table(table_name, MetaData(), autoload_with=connection)
            assert set(upgraded_accounts.c.keys()) == legacy_columns | check_columns
            for name in check_columns:
                assert upgraded_accounts.c[name].nullable is True
                assert upgraded_accounts.c[name].server_default is None
            assert dict(connection.execute(select(upgraded_accounts)).mappings().one()) == {
                **legacy_row,
                **dict.fromkeys(check_columns),
            }
            context = MigrationContext.configure(
                connection,
                opts={
                    "compare_type": True,
                    "include_object": lambda _obj, name, kind, _reflected, _compare_to: (
                        kind != "table" or name == table_name
                    ),
                },
            )
            assert compare_metadata(context, Base.metadata) == []

            command.downgrade(config, "0015")
            downgraded_accounts = Table(table_name, MetaData(), autoload_with=connection)
            assert MigrationContext.configure(connection).get_current_revision() == "0015"
            assert set(downgraded_accounts.c.keys()) == legacy_columns
            assert inspect(connection).get_table_names() == legacy_tables
            assert inspect(connection).get_indexes(table_name) == legacy_indexes
            assert inspect(connection).get_unique_constraints(table_name) == legacy_constraints
            assert dict(connection.execute(select(downgraded_accounts)).mappings().one()) == legacy_row
    finally:
        engine.dispose()
