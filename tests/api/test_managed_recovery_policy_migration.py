"""Password recovery policy changes only the legacy opt-out flag."""

from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import Connection, MetaData, Table, create_engine, inspect, select
from sqlalchemy.orm import Session

NOW = datetime(2026, 11, 5, 12, 34, 56, 123456)
TABLE_NAME = "managed_platform_account"
MAX_ATTEMPTS = 3


def _rows(connection: Connection, accounts: Table) -> dict[int, dict[str, Any]]:
    return {
        row["id"]: dict(row)
        for row in connection.execute(select(accounts).order_by(accounts.c.id)).mappings()
    }


def _schema(connection: Connection) -> dict[str, Any]:
    inspector = inspect(connection)
    return {
        "tables": inspector.get_table_names(),
        "columns": [
            {**column, "type": str(column["type"])}
            for column in inspector.get_columns(TABLE_NAME)
        ],
        "indexes": inspector.get_indexes(TABLE_NAME),
        "unique_constraints": inspector.get_unique_constraints(TABLE_NAME),
        "primary_key": inspector.get_pk_constraint(TABLE_NAME),
    }


@pytest.fixture()
def legacy_recovery_database(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> Iterator[tuple[Connection, Config, Table, dict[tuple[str, bool, str], int]]]:
    database_url = f"sqlite:///{tmp_path / 'managed-recovery-policy.sqlite'}"
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.setattr("dotenv.load_dotenv", lambda *args, **kwargs: False)
    monkeypatch.setenv("VESTUS_DATABASE_URL", database_url)
    monkeypatch.setenv("VESTUS_MANAGED_RECOVERY_ENABLED", "0")
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).resolve().parents[2] / "migrations"))
    engine = create_engine(database_url)
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            # Run the complete historical chain, not create_all or a stamped schema.
            command.upgrade(config, "0016")
            assert MigrationContext.configure(connection).get_current_revision() == "0016"
            accounts = Table(TABLE_NAME, MetaData(), autoload_with=connection)
            platforms = Table("platform", MetaData(), autoload_with=connection)
            for platform_id, status in ((1, "active"), (2, "disabled")):
                connection.execute(platforms.insert().values(
                    id=platform_id,
                    name=f"Synthetic migration platform {platform_id}",
                    url="https://migration.example.test",
                    sort_order=platform_id,
                    status=status,
                    created_at=NOW - timedelta(days=60),
                    updated_at=NOW - timedelta(days=40),
                ))

            cases: dict[str, dict[str, Any]] = {
                "valid-idle": {},
                "expired-idle": {"session_status": "expired"},
                "pending": {
                    "session_status": "expired", "recovery_status": "pending",
                    "next_recovery_at": NOW - timedelta(minutes=2),
                },
                "retry-wait": {
                    "session_status": "expired", "recovery_status": "retry_wait",
                    "next_recovery_at": NOW + timedelta(minutes=10),
                },
                "running": {
                    "session_status": "expired", "recovery_status": "running",
                    "recovery_lease_token": "synthetic-existing-lease",
                    "recovery_lease_until": NOW + timedelta(minutes=2),
                },
                "failed": {
                    "session_status": "expired", "recovery_status": "failed",
                    "recovery_attempts": MAX_ATTEMPTS,
                },
                "revoked": {"session_status": "expired", "status": "revoked"},
                "disabled": {"session_status": "expired", "status": "disabled"},
                "entitlement-expired": {
                    "session_status": "expired", "expires_at": NOW - timedelta(seconds=1),
                },
                "entitlement-boundary": {"session_status": "expired", "expires_at": NOW},
                "unbounded": {"session_status": "expired", "expires_at": None},
                "inactive-platform": {"session_status": "expired", "platform_id": 2},
            }
            ids: dict[tuple[str, bool, str], int] = {}
            for auth_mode in ("server_login", "cookie", "official_sso"):
                for auto_relogin in (False, True):
                    for case, overrides in cases.items():
                        account_id = len(ids) + 1
                        ids[auth_mode, auto_relogin, case] = account_id
                        values = {
                            "id": account_id,
                            "platform_id": 1,
                            "name": f"{auth_mode}-{int(auto_relogin)}-{case}",
                            "auth_mode": auth_mode,
                            "encrypted_username": f"synthetic-encrypted-user-{account_id}".encode(),
                            "encrypted_password": f"synthetic-encrypted-password-{account_id}".encode(),
                            "encrypted_cookie_bundle": f"synthetic-encrypted-cookie-{account_id}".encode(),
                            "username": f"synthetic-user-{account_id}",
                            "password": f"synthetic-password-{account_id}",
                            "cookie_bundle": [{
                                "name": "session", "value": f"synthetic-cookie-{account_id}",
                                "domain": "migration.example.test", "path": "/",
                            }],
                            "allowed_hosts": ["migration.example.test"],
                            "credential_version": account_id + 7,
                            "expires_at": NOW + timedelta(days=30),
                            "status": "active",
                            "session_status": "valid",
                            "auto_relogin": auto_relogin,
                            "recovery_status": "idle",
                            "recovery_attempts": MAX_ATTEMPTS - 1,
                            "next_recovery_at": None,
                            "recovery_lease_token": None,
                            "recovery_lease_until": None,
                            "last_recovered_at": NOW - timedelta(days=3),
                            "last_verified_at": NOW - timedelta(days=2),
                            "last_error": f"synthetic-existing-error-{account_id}",
                            "remote_account_id": f"synthetic-remote-{account_id}",
                            "remote_display_name": f"Synthetic identity {account_id}",
                            "identity_checked_at": NOW - timedelta(hours=6),
                            "last_identity_check_state": "error",
                            "last_identity_check_at": NOW - timedelta(hours=5),
                            "last_identity_check_detail": f"synthetic-check-detail-{account_id}",
                            "created_by": 17,
                            "created_at": NOW - timedelta(days=40),
                            "updated_at": NOW - timedelta(hours=4),
                            **overrides,
                        }
                        connection.execute(accounts.insert().values(**values))
            yield connection, config, accounts, ids
    finally:
        engine.dispose()


def test_upgrade_only_enables_password_recovery_and_preserves_every_other_column(
    legacy_recovery_database: tuple[Connection, Config, Table, dict[tuple[str, bool, str], int]],
) -> None:
    connection, config, accounts, ids = legacy_recovery_database
    before = _rows(connection, accounts)
    before_schema = _schema(connection)
    changed_ids = {
        account_id for (mode, enabled, _case), account_id in ids.items()
        if mode == "server_login" and not enabled
    }
    assert len(before) == 72
    assert len(changed_ids) == 12

    command.upgrade(config, "0017")

    upgraded = Table(TABLE_NAME, MetaData(), autoload_with=connection)
    assert MigrationContext.configure(connection).get_current_revision() == "0017"
    assert _schema(connection) == before_schema
    assert _rows(connection, upgraded) == {
        account_id: {**row, "auto_relogin": True} if account_id in changed_ids else row
        for account_id, row in before.items()
    }


def test_downgrade_keeps_enabled_password_recovery_and_reupgrade_is_idempotent(
    legacy_recovery_database: tuple[Connection, Config, Table, dict[tuple[str, bool, str], int]],
) -> None:
    connection, config, _accounts, ids = legacy_recovery_database
    command.upgrade(config, "0017")
    upgraded = Table(TABLE_NAME, MetaData(), autoload_with=connection)
    before = _rows(connection, upgraded)
    before_schema = _schema(connection)
    assert all(
        before[account_id]["auto_relogin"] is True
        for (mode, _enabled, _case), account_id in ids.items() if mode == "server_login"
    )

    command.downgrade(config, "0016")

    downgraded = Table(TABLE_NAME, MetaData(), autoload_with=connection)
    assert MigrationContext.configure(connection).get_current_revision() == "0016"
    assert _schema(connection) == before_schema
    assert _rows(connection, downgraded) == before
    command.upgrade(config, "0017")
    reupgraded = Table(TABLE_NAME, MetaData(), autoload_with=connection)
    assert MigrationContext.configure(connection).get_current_revision() == "0017"
    assert _schema(connection) == before_schema
    assert _rows(connection, reupgraded) == before


def test_migrated_idle_expired_account_is_claimable_without_resetting_failed_attempts(
    legacy_recovery_database: tuple[Connection, Config, Table, dict[tuple[str, bool, str], int]],
) -> None:
    connection, config, accounts, ids = legacy_recovery_database
    # Import only the existing repository, never a worker or a real login service.
    from app.repositories.managed_recovery import claim, due_accounts

    due_cases = ("expired-idle", "pending", "unbounded")
    with Session(bind=connection, join_transaction_mode="create_savepoint") as session:
        assert set(due_accounts(session, NOW, limit=1000)) == {
            ids["server_login", True, case] for case in due_cases
        }
        session.commit()

    command.upgrade(config, "0017")
    migrated = _rows(connection, Table(TABLE_NAME, MetaData(), autoload_with=connection))
    with Session(bind=connection, join_transaction_mode="create_savepoint") as session:
        assert set(due_accounts(session, NOW, limit=1000)) == {
            ids["server_login", enabled, case]
            for enabled in (False, True) for case in due_cases
        }
        # Terminal failures remain terminal, including their error/timestamps/attempts.
        for enabled in (False, True):
            failed_id = ids["server_login", enabled, "failed"]
            assert migrated[failed_id]["recovery_attempts"] == MAX_ATTEMPTS
            assert claim(
                session, failed_id, NOW, NOW + timedelta(minutes=5),
                "synthetic-unclaimable-lease", MAX_ATTEMPTS,
            ) is None
            assert _rows(connection, accounts)[failed_id] == migrated[failed_id]

        idle_id = ids["server_login", False, "expired-idle"]
        claimed = claim(
            session, idle_id, NOW, NOW + timedelta(minutes=5),
            "synthetic-migrated-lease", MAX_ATTEMPTS,
        )
        assert claimed is not None
        assert claimed.id == idle_id
        assert claimed.auto_relogin is True
        assert claimed.recovery_status == "running"
        assert claimed.session_status == "expired"
        assert claimed.recovery_attempts == MAX_ATTEMPTS
        assert claimed.credential_version == migrated[idle_id]["credential_version"]
        assert claimed.recovery_lease_token == "synthetic-migrated-lease"
        assert claimed.recovery_lease_until == NOW + timedelta(minutes=5)
        assert idle_id not in due_accounts(session, NOW, limit=1000)
        session.commit()
