"""Initialize the configured database and optionally create the first admin.

Examples::

    VESTUS_DATABASE_URL='mysql+pymysql://root:pass@localhost:3306/vestus' \
      VESTUS_BOOTSTRAP_ADMIN_PASSWORD='change-this-now' python3 init_db.py

For tests, use an explicit SQLite URL. This command never creates legacy
``users``, ``sessions`` or ``audit_logs`` tables.
"""

from __future__ import annotations

try:
    from dotenv import load_dotenv

    from pathlib import Path

    _project_env = Path(__file__).resolve().with_name(".env")
    load_dotenv(_project_env, override=False)
except ImportError:  # Direct environment variables still work without this optional convenience.
    pass

from db import Base, Database


def main() -> None:
    database = Database()
    Base.metadata.create_all(database.engine)
    safe_url = database.engine.url.render_as_string(hide_password=True)
    print(f"initialized {safe_url}")
    if database.initialization_error:
        raise SystemExit(database.initialization_error)


if __name__ == "__main__":
    main()
