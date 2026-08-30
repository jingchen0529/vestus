"""Bring the configured database up to date, then seed the first administrator.

Examples::

    VESTUS_DATABASE_URL='mysql+pymysql://root:pass@localhost:3306/vestus' \
      VESTUS_BOOTSTRAP_ADMIN_PASSWORD='change-this-now' python3 scripts/init_db.py

Three situations are handled, so the same command is safe on a fresh server and
on a deployment that predates Alembic:

* **empty database** -- ``upgrade head`` creates every table, which keeps the
  schema and the recorded revision in agreement;
* **created by the historic ``create_all()`` bootstrap** -- the baseline
  revision is stamped once and later migrations are then applied, so no existing
  table is rewritten;
* **already managed by Alembic** -- a plain ``upgrade head``.

This command never creates the legacy ``users``, ``sessions`` or ``audit_logs``
tables.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    # Support ``python3 scripts/init_db.py`` from anywhere, not just ``-m``.
    sys.path.insert(0, str(REPO_ROOT))

from alembic import command  # noqa: E402  -- must follow the sys.path bootstrap above
from alembic.config import Config  # noqa: E402
from sqlalchemy import inspect  # noqa: E402

from app.db.session import Database  # noqa: E402

ALEMBIC_INI = REPO_ROOT / "alembic.ini"
BASELINE_REVISION = "0001"
#: Probe for a pre-Alembic database.  ``admin`` has existed since the first
#: release, so its presence without a version table means "adopt me".
ADOPTION_PROBE_TABLE = "admin"
VERSION_TABLE = "alembic_version"


def alembic_config() -> Config:
    return Config(str(ALEMBIC_INI))


def prepare_schema(database: Database) -> str:
    """Move ``database`` to ``head`` and report which of the three paths was taken.

    Everything runs on one connection inside one transaction, which is also what
    lets ``stamp`` and ``upgrade`` be treated as a single step.
    """
    config = alembic_config()
    with database.engine.begin() as connection:
        tables = set(inspect(connection).get_table_names())
        config.attributes["connection"] = connection
        if VERSION_TABLE in tables:
            outcome = "upgraded"
        elif ADOPTION_PROBE_TABLE in tables:
            command.stamp(config, BASELINE_REVISION)
            outcome = "adopted"
        else:
            outcome = "created"
        command.upgrade(config, "head")
    return outcome


def bring_up_to_date(database: Database) -> Optional[str]:
    """Apply migrations, then seed singleton rows and the bootstrap admin.

    Returns the initialization error, if any, rather than raising: the caller
    prints the (redacted) connection URL first so a failure is diagnosable.
    """
    prepare_schema(database)
    database.initialize()
    return database.initialization_error


def main() -> None:
    database = Database(initialize=False)
    # Never print the raw URL: it carries the database password.
    safe_url = database.engine.url.render_as_string(hide_password=True)
    error = bring_up_to_date(database)
    print(f"initialized {safe_url}")
    if error:
        raise SystemExit(error)


if __name__ == "__main__":
    main()
