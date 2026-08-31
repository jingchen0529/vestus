"""Browser activity reported by the desktop client.

Two tables, because the two questions asked of this data have different shapes:
``browser_session`` answers "who opened what, when, and how much did they do"
without touching the page rows, and ``browser_page_visit`` answers "which
addresses, in what order" for one session.  The running totals on the session
row are therefore a deliberate denormalization -- they keep the admin list page
off the per-page table entirely.

The client uploads **deltas**: every batch carries only what happened since the
previous one, so the server adds instead of overwriting and a re-sent or lost
batch cannot rewrite history.  ``session_key`` is what ties the batches of one
browser run together; it is unique per user, not globally, which is all the
client can cheaply guarantee.

What is *not* here is as much of the design as what is: no page titles, no form
contents, no clicked element, no keystrokes and no query string.  The desktop
side strips the query before reporting and the service layer strips it again --
see :mod:`app.services.browser_activity`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, LargeBinary, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import TABLE_ARGS, Base, DateTime6, IdType, utc_now


class BrowserSession(Base):
    """One browser run on one desktop client."""

    __tablename__ = "browser_session"
    __table_args__ = (
        UniqueConstraint("user_id", "session_key", name="uq_browser_session_key"),
        {**TABLE_ARGS},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    #: Copied at report time so a renamed or deleted account still reads.
    username: Mapped[str] = mapped_column(String(64), nullable=False)
    #: Stable across the batches of one run; unique within one user only.
    session_key: Mapped[str] = mapped_column(String(64), nullable=False)
    #: The client's own per-process session number, kept for support requests.
    browser_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    platform_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    #: Also copied at report time; the platform may be renamed or removed later.
    platform_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    direct_mode: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    #: Running totals over the whole session, summed from the reported deltas.
    #: BIGINT throughout: these accumulate for as long as the browser stays open.
    page_count: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    visits: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    clicks: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    inputs: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    submits: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    scrolls: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    dwell_ms: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    #: Addresses the client could not keep because its own table filled up.
    #: The only signal that a session's page list is incomplete.
    dropped_pages: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    #: The reporting client's address, as seen by the server.
    ip_address: Mapped[Optional[bytes]] = mapped_column(LargeBinary(16), nullable=True)
    #: Server clock, both of them: the client's own timestamps are only used to
    #: order rows within a batch, never to decide when something was recorded.
    started_at: Mapped[datetime] = mapped_column(
        DateTime6, nullable=False, default=utc_now, index=True
    )
    last_report_at: Mapped[datetime] = mapped_column(
        DateTime6, nullable=False, default=utc_now, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)


class BrowserPageVisit(Base):
    """One address within one session, with its accumulated counters."""

    __tablename__ = "browser_page_visit"
    __table_args__ = (
        UniqueConstraint("session_id", "url_hash", name="uq_browser_page_visit_url"),
        {**TABLE_ARGS},
    )

    id: Mapped[int] = mapped_column(IdType, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(IdType, nullable=False, index=True)
    url: Mapped[str] = mapped_column(String(500), nullable=False)
    #: SHA-256 of ``url``, hex.  The uniqueness we want is on the address, but a
    #: 500-character utf8mb4 column is 2000 bytes and blows past InnoDB's index
    #: key limit, so the constraint rides on the digest instead.
    url_hash: Mapped[str] = mapped_column(String(64), nullable=False)

    visits: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    clicks: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    inputs: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    submits: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    scrolls: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    #: Foreground time only; the injected collector stops the clock when the tab
    #: is hidden, so this is attention rather than wall time.
    dwell_ms: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    first_seen_at: Mapped[datetime] = mapped_column(DateTime6, nullable=False, default=utc_now)
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime6, nullable=False, default=utc_now, index=True
    )
