from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path

import pytest

from app.db.base import Base
from app.db.models import BrowserPageVisit, BrowserSession
from app.db.session import Database
from scripts import dump_advid


@pytest.fixture
def test_db(tmp_path: Path) -> Database:
    db_file = tmp_path / "test.db"
    db_url = f"sqlite:///{db_file}"
    database = Database(url=db_url, initialize=False)
    Base.metadata.create_all(database.engine)
    return database


def _seed_data(database: Database) -> None:
    with database.session() as session:
        # Session 1: 2026-09-13
        sess1 = BrowserSession(
            user_id=1,
            username="alice",
            session_key="sess_key_1",
            browser_id=101,
            platform_id=1,
            platform_name="Chrome",
            direct_mode=False,
            started_at=datetime(2026, 9, 13, 10, 0, 0),
            last_report_at=datetime(2026, 9, 13, 11, 0, 0),
        )
        session.add(sess1)
        session.flush()

        v1 = BrowserPageVisit(
            session_id=sess1.id,
            url="https://example.com/page1",
            url_params="advid=1001&source=ad",
            url_hash="hash_1",
            visits=2,
            first_seen_at=datetime(2026, 9, 13, 10, 5, 0),
            last_seen_at=datetime(2026, 9, 13, 10, 10, 0),
        )
        session.add(v1)

        # Session 2: 2026-09-14
        sess2 = BrowserSession(
            user_id=2,
            username="bob",
            session_key="sess_key_2",
            browser_id=102,
            platform_id=1,
            platform_name="Chrome",
            direct_mode=False,
            started_at=datetime(2026, 9, 14, 9, 0, 0),
            last_report_at=datetime(2026, 9, 14, 18, 0, 0),
        )
        session.add(sess2)
        session.flush()

        # Same advid=2001 in two visits
        v2 = BrowserPageVisit(
            session_id=sess2.id,
            url="https://example.com/page2",
            url_params="advid=2001&track=1",
            url_hash="hash_2",
            visits=3,
            first_seen_at=datetime(2026, 9, 14, 9, 15, 0),
            last_seen_at=datetime(2026, 9, 14, 9, 30, 0),
        )
        v3 = BrowserPageVisit(
            session_id=sess2.id,
            url="https://example.com/page3",
            url_params="advid=2001&track=2",
            url_hash="hash_3",
            visits=1,
            first_seen_at=datetime(2026, 9, 14, 14, 0, 0),
            last_seen_at=datetime(2026, 9, 14, 14, 10, 0),
        )
        # Another advid=2002 on the same day
        v4 = BrowserPageVisit(
            session_id=sess2.id,
            url="https://example.com/page4",
            url_params="advid=2002&track=3",
            url_hash="hash_4",
            visits=5,
            first_seen_at=datetime(2026, 9, 14, 15, 0, 0),
            last_seen_at=datetime(2026, 9, 14, 15, 5, 0),
        )
        session.add_all([v2, v3, v4])

        # Session 3: 2026-09-15
        sess3 = BrowserSession(
            user_id=3,
            username="charlie",
            session_key="sess_key_3",
            browser_id=103,
            platform_id=1,
            platform_name="Chrome",
            direct_mode=False,
            started_at=datetime(2026, 9, 15, 8, 0, 0),
            last_report_at=datetime(2026, 9, 15, 9, 0, 0),
        )
        session.add(sess3)
        session.flush()

        v5 = BrowserPageVisit(
            session_id=sess3.id,
            url="https://example.com/page5",
            url_params="advid=3001",
            url_hash="hash_5",
            visits=1,
            first_seen_at=datetime(2026, 9, 15, 8, 30, 0),
            last_seen_at=datetime(2026, 9, 15, 8, 35, 0),
        )
        session.add(v5)
        session.commit()


def test_dump_advid_all(test_db: Database, tmp_path: Path) -> None:
    _seed_data(test_db)
    out_csv = tmp_path / "all.csv"
    ret = dump_advid.main([
        "--db-url", test_db.url,
        "-o", str(out_csv),
    ])
    assert ret == 0
    with out_csv.open("r", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    # Header + 5 visits
    assert len(rows) == 6
    assert rows[0] == dump_advid.COLUMNS
    values = [r[0] for r in rows[1:]]
    assert values == ["1001", "2001", "2001", "2002", "3001"]


def test_dump_advid_by_date(test_db: Database, tmp_path: Path) -> None:
    _seed_data(test_db)
    out_csv = tmp_path / "date.csv"
    ret = dump_advid.main([
        "--db-url", test_db.url,
        "--date", "2026-09-14",
        "-o", str(out_csv),
    ])
    assert ret == 0
    with out_csv.open("r", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    # Only 2026-09-14 (3 visits: two 2001, one 2002)
    assert len(rows) == 4
    values = [r[0] for r in rows[1:]]
    assert values == ["2001", "2001", "2002"]


def test_dump_advid_unique(test_db: Database, tmp_path: Path) -> None:
    _seed_data(test_db)
    out_csv = tmp_path / "unique.csv"
    ret = dump_advid.main([
        "--db-url", test_db.url,
        "--date", "2026-09-14",
        "--unique",
        "-o", str(out_csv),
    ])
    assert ret == 0
    with out_csv.open("r", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    # Header + 2 unique advids (2001, 2002)
    assert len(rows) == 3
    assert rows[0] == dump_advid.COLUMNS_UNIQUE
    row_2001 = rows[1]
    row_2002 = rows[2]
    # param_value, occurrences, total_visits, first_seen_at, last_seen_at, usernames
    assert row_2001[0] == "2001"
    assert row_2001[1] == "2"  # 2 occurrences
    assert row_2001[2] == "4"  # 3 + 1 visits
    assert "bob" in row_2001[5]

    assert row_2002[0] == "2002"
    assert row_2002[1] == "1"
    assert row_2002[2] == "5"


def test_dump_advid_unique_values_only(test_db: Database, tmp_path: Path) -> None:
    _seed_data(test_db)
    out_csv = tmp_path / "unique_values.csv"
    ret = dump_advid.main([
        "--db-url", test_db.url,
        "--date", "2026-09-14",
        "--unique",
        "--values-only",
        "-o", str(out_csv),
    ])
    assert ret == 0
    with out_csv.open("r", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    assert rows == [
        ["advid"],
        ["2001"],
        ["2002"],
    ]


def test_dump_advid_date_range(test_db: Database, tmp_path: Path) -> None:
    _seed_data(test_db)
    out_csv = tmp_path / "range.csv"
    ret = dump_advid.main([
        "--db-url", test_db.url,
        "--start", "2026-09-14",
        "--end", "2026-09-15",
        "--unique",
        "--values-only",
        "-o", str(out_csv),
    ])
    assert ret == 0
    with out_csv.open("r", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    assert rows == [
        ["advid"],
        ["2001"],
        ["2002"],
        ["3001"],
    ]


def test_dump_advid_mutual_exclusion(test_db: Database, tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        dump_advid.main([
            "--db-url", test_db.url,
            "--date", "2026-09-14",
            "--start", "2026-09-14",
        ])
