"""Desktop FAQ row access: one ordered read and one transactional replace."""

from __future__ import annotations

from typing import Any, Dict, List, Sequence, Tuple

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import DesktopFaqGroup, DesktopFaqItem


def load_all(session: Session) -> Tuple[List[DesktopFaqGroup], List[DesktopFaqItem]]:
    """Every group and item, each in display order."""

    groups = list(
        session.scalars(select(DesktopFaqGroup).order_by(DesktopFaqGroup.sort_order, DesktopFaqGroup.id))
    )
    items = list(
        session.scalars(select(DesktopFaqItem).order_by(DesktopFaqItem.sort_order, DesktopFaqItem.id))
    )
    return groups, items


def replace_all(
    session: Session,
    groups: Sequence[Dict[str, Any]],
) -> None:
    """Rewrite the whole document inside the caller's transaction.

    ``groups`` is the validated payload: ``[{title, status, items:
    [{question, answer, status}]}]`` in display order.  No SQL FKs exist in this
    schema, so the items are removed before their groups and everything lands
    or rolls back together with the caller's other statements.
    """

    session.query(DesktopFaqItem).delete(synchronize_session=False)
    session.query(DesktopFaqGroup).delete(synchronize_session=False)
    for group_order, group in enumerate(groups):
        row = DesktopFaqGroup(title=group["title"], sort_order=group_order, status=group["status"])
        session.add(row)
        session.flush()
        for item_order, item in enumerate(group["items"]):
            session.add(
                DesktopFaqItem(
                    group_id=row.id,
                    question=item["question"],
                    answer=item["answer"],
                    sort_order=item_order,
                    status=item["status"],
                )
            )
    # Sessions run with autoflush=False: without this final flush the last
    # group's items stay pending, and the same-transaction read-back in the
    # service layer (and its audit summary) silently misses them.
    session.flush()


def clear(session: Session) -> None:
    """Remove every row; the client falls back to its bundled baseline."""

    session.query(DesktopFaqItem).delete(synchronize_session=False)
    session.query(DesktopFaqGroup).delete(synchronize_session=False)


__all__ = ["clear", "load_all", "replace_all"]
