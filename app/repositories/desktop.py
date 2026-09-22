"""The single-statement desktop configuration snapshot.

One SELECT loads the user row, the proxy that user resolves to and every active
platform (with its icon).  The proxy resolution order is: the node assigned to
this user (``User.proxy_id``, when it is still active), else the active proxy
marked as default, else the most recently updated active proxy -- the behaviour
databases written before per-user assignment shipped already rely on.  Keeping
the read to one statement is asserted by the test suite: a lease read must not
fan out into per-platform queries.
"""

from __future__ import annotations

from typing import Any, List, Optional, Set, Tuple

from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session, aliased

from app.db.models import Platform, Proxy, UploadedFile, User

DesktopSnapshot = Tuple[User, Optional[Proxy], List[Tuple[Platform, Optional[UploadedFile]]]]


def _resolved_proxy_id() -> Any:
    """The id of the proxy this user should run, as a scalar subquery.

    ``COALESCE`` walks the three resolution tiers; each tier yields ``NULL``
    when it does not apply so the next one is tried.  An assigned node that was
    disabled or deleted therefore drops the user back onto the default node
    instead of leaving them without a proxy.
    """
    assigned = aliased(Proxy)
    marked = aliased(Proxy)
    newest = aliased(Proxy)
    return func.coalesce(
        # The user's own node, only while it is usable.
        select(assigned.id)
        .where(assigned.id == User.proxy_id, assigned.status == "active")
        .scalar_subquery(),
        # The singleton default node.
        select(marked.id)
        .where(marked.status == "active", marked.is_default.is_(True))
        .order_by(desc(marked.updated_at), desc(marked.id))
        .limit(1)
        .scalar_subquery(),
        # Legacy fallback: the most recently updated active proxy.
        select(newest.id)
        .where(newest.status == "active")
        .order_by(desc(newest.updated_at), desc(newest.id))
        .limit(1)
        .scalar_subquery(),
    )


def load_user_snapshot(session: Session, user_id: int) -> Optional[DesktopSnapshot]:
    """Load the user's resolved proxy and the active platforms in one query.

    The user remains part of the snapshot so deleted accounts cannot obtain
    configuration and each response can retain its user-scoped profile key.
    """
    rows = session.execute(
        select(User, Proxy, Platform, UploadedFile)
        .select_from(User)
        .outerjoin(
            Proxy,
            Proxy.id == _resolved_proxy_id(),
        )
        .outerjoin(
            Platform,
            Platform.status == "active",
        )
        .outerjoin(UploadedFile, UploadedFile.path == Platform.icon_url)
        .where(User.id == user_id, User.deleted_at.is_(None))
        .order_by(
            Platform.sort_order,
            Platform.id,
        )
    ).all()
    if not rows:
        return None
    user = rows[0][0]
    proxy = rows[0][1]
    platforms: List[Tuple[Platform, Optional[UploadedFile]]] = []
    seen_platform_ids: Set[int] = set()
    for row in rows:
        platform = row[2]
        if platform is None or platform.id in seen_platform_ids:
            continue
        seen_platform_ids.add(platform.id)
        platforms.append((platform, row[3]))
    return user, proxy, platforms
