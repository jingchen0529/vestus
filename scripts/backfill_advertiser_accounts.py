"""Backfill page advertiser indexes; preview by default, never initialize a database."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence

from sqlalchemy import select

from app.db.models import BrowserPageAdvertiser, BrowserPageVisit
from app.db.session import Database
from app.repositories.advertiser_accounts import ensure_index
from app.services.advertiser_identity import extract_advertiser


def backfill(
    database: Database, *, apply: bool = False, batch_size: int = 500,
    after_id: int = 0, max_batches: int | None = None,
) -> dict[str, int | bool | str]:
    stats: dict[str, int | bool] = {
        "dryRun": not apply, "scanned": 0, "matched": 0, "indexed": 0, "wouldIndex": 0,
        "skipped": 0, "existing": 0, "unsupported": 0, "missing": 0, "invalid": 0,
        "ambiguous": 0, "lastPageId": after_id, "batches": 0, "completed": False,
    }
    try:
        while max_batches is None or stats["batches"] < max_batches:
            batch = stats.copy()
            with database.session() as session:
                statement = (
                    select(BrowserPageVisit.id, BrowserPageVisit.url, BrowserPageVisit.url_params)
                    .where(BrowserPageVisit.id > stats["lastPageId"])
                    .order_by(BrowserPageVisit.id).limit(batch_size)
                )
                # Serialize with online page writers on MySQL; preview stays read-only.
                pages = session.execute(statement.with_for_update() if apply else statement).all()
                if not pages:
                    stats["completed"] = True
                    break
                existing = set(session.scalars(
                    select(BrowserPageAdvertiser.page_id)
                    .where(BrowserPageAdvertiser.page_id.in_([row.id for row in pages]))
                ))
                for page in pages:
                    batch["scanned"] += 1
                    result = extract_advertiser(page.url, page.url_params)
                    if result.reason == "matched":
                        batch["matched"] += 1
                    else:
                        batch[result.reason] += 1
                    if page.id in existing:
                        batch["existing"] += 1
                        batch["skipped"] += 1
                    elif result.advertiser_id is None:
                        batch["skipped"] += 1
                    elif apply:
                        ensure_index(session, page.id, result.advertiser_id)
                        batch["indexed"] += 1
                    else:
                        batch["wouldIndex"] += 1
            # Publish counters and checkpoint only after a successful batch commit.
            batch["lastPageId"] = pages[-1].id
            batch["batches"] += 1
            stats = batch
        if not stats["completed"]:
            with database.session() as session:
                stats["completed"] = session.scalar(
                    select(BrowserPageVisit.id).where(BrowserPageVisit.id > stats["lastPageId"]).limit(1)
                ) is None
    except Exception:
        # Driver exception strings can contain connection URLs, SQL and credentials.
        # Prior batches are durable; the failed batch is rolled back by Database.session.
        return {**stats, "completed": False, "error": "backfill_failed"}
    return dict(stats)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database-url", help="Database URL; defaults to configured VESTUS_DATABASE_URL")
    parser.add_argument("--apply", action="store_true", help="Write missing indexes (default: preview only)")
    parser.add_argument("--batch-size", type=int, default=500, help="Pages per transaction (1..1000; default: 500)")
    parser.add_argument("--after-id", type=int, default=0, help="Resume strictly after this page ID")
    parser.add_argument("--max-batches", type=int, help="Stop after this many batches (default: no limit)")
    args = parser.parse_args(argv)
    if not 1 <= args.batch_size <= 1000:
        parser.error("--batch-size must be between 1 and 1000")
    if args.after_id < 0:
        parser.error("--after-id must be nonnegative")
    if args.max_batches is not None and args.max_batches < 1:
        parser.error("--max-batches must be positive")
    try:
        database = Database(args.database_url, initialize=False)
    except Exception:
        print(json.dumps({
            "dryRun": not args.apply, "completed": False, "lastPageId": args.after_id,
            "error": "database_unavailable",
        }))
        return 1
    try:
        stats = backfill(
            database, apply=args.apply, batch_size=args.batch_size,
            after_id=args.after_id, max_batches=args.max_batches,
        )
        print(json.dumps(stats))
        return 1 if "error" in stats else 0
    finally:
        database.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
