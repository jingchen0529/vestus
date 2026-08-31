"""The desktop client's browser-activity upload body.

The wire names mirror ``desktop/src-tauri/src/activity.rs``; changing either side
requires changing the other.  Everything here is deliberately strict: this is the
one endpoint a desktop token can use to write rows, so a malformed or oversized
report is rejected before it reaches a session.
"""

from __future__ import annotations

from typing import List
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Longest URL we store, matching ``browser_page_visit.url``.
MAX_URL_LENGTH = 500

#: Most addresses one report may carry.  This is the desktop's own aggregate cap
#: (``MAX_TRACKED_PAGES`` in ``activity.rs``): a full flush sends the whole table
#: in one request, so the two numbers must stay equal or uploads start failing.
MAX_PAGES_PER_REPORT = 500

#: Per-batch ceiling on a single counter.  The client coalesces and batches every
#: second, so a genuine batch is in the tens; this only exists to stop a forged
#: report from writing an absurd total.
MAX_COUNT_PER_PAGE = 1_000_000

#: Per-batch ceiling on dwell time: one day of foreground time in one batch is
#: already impossible, since the client flushes far more often than that.
MAX_DWELL_MS_PER_PAGE = 24 * 60 * 60 * 1000


def normalize_reported_url(value: str) -> str:
    """Strip the address down to what we are allowed to keep.

    The desktop already removes the query, the fragment and any credentials
    before reporting.  Doing it again here is not redundancy for its own sake:
    this endpoint is reachable by anything holding a desktop token, so the
    privacy boundary has to hold without trusting the client that crossed it.
    """

    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("URL must use http or https")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must not contain credentials")
    # ``urlsplit`` keeps the authority verbatim, so rebuilding from the parts
    # drops the query and fragment without re-encoding the path.
    normalized = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    if len(normalized) > MAX_URL_LENGTH:
        raise ValueError("URL is too long")
    return normalized


class BrowserPageReport(BaseModel):
    """One address's counters, as a delta since the previous report."""

    url: str = Field(min_length=1, max_length=2048)
    visits: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    clicks: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    inputs: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    submits: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    scrolls: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    dwell_ms: int = Field(default=0, alias="dwellMs", ge=0, le=MAX_DWELL_MS_PER_PAGE)
    first_seen_at_ms: int = Field(default=0, alias="firstSeenAtMs", ge=0)
    last_seen_at_ms: int = Field(default=0, alias="lastSeenAtMs", ge=0)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return normalize_reported_url(value)


class BrowserActivityReport(BaseModel):
    """One batch from one browser run."""

    #: Ties the batches of one run together; see ``SessionKey::wire_key``.
    session_key: str = Field(
        alias="sessionKey", min_length=8, max_length=64, pattern=r"^[0-9A-Za-z_-]+$"
    )
    browser_id: int = Field(alias="browserId", ge=0, le=2**63 - 1)
    platform_id: int = Field(alias="platformId", ge=0, le=2**63 - 1)
    direct_mode: bool = Field(default=False, alias="directMode")
    reported_at_ms: int = Field(default=0, alias="reportedAtMs", ge=0)
    dropped_pages: int = Field(default=0, alias="droppedPages", ge=0, le=2**31 - 1)
    pages: List[BrowserPageReport] = Field(min_length=1, max_length=MAX_PAGES_PER_REPORT)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


__all__ = [
    "MAX_COUNT_PER_PAGE",
    "MAX_DWELL_MS_PER_PAGE",
    "MAX_PAGES_PER_REPORT",
    "MAX_URL_LENGTH",
    "BrowserActivityReport",
    "BrowserPageReport",
    "normalize_reported_url",
]
