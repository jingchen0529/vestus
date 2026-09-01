"""The desktop client's browser-activity upload body.

The wire names mirror ``desktop/src-tauri/src/activity.rs``; changing either side
requires changing the other.  Everything here is deliberately strict: this is the
one endpoint a desktop token can use to write rows, so a malformed or oversized
report is rejected before it reaches a session.
"""

from __future__ import annotations

import json
import re
from typing import Dict, List, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

#: Longest URL we store, matching ``browser_page_visit.url``.
MAX_URL_LENGTH = 500

#: Query data travels separately from the address so the admin UI can show it
#: without turning the URL column into an unreadable (and unbounded) string.
MAX_URL_PARAMS_LENGTH = 4096

#: Snapshot limits are enforced again on the server.  The page process is not a
#: trusted input even though the desktop collector applies the same caps first.
MAX_SNAPSHOT_FIELDS = 50
MAX_SNAPSHOT_KEY_BYTES = 128
MAX_SNAPSHOT_VALUES_PER_FIELD = 20
MAX_SNAPSHOT_VALUE_BYTES = 512
MAX_SNAPSHOT_BYTES = 32 * 1024

REDACTED_VALUE = "[REDACTED]"
_SENSITIVE_NAME_PARTS = (
    "password",
    "passwd",
    "pwd",
    "token",
    "secret",
    "authorization",
    "cookie",
    "session",
    "otp",
    "captcha",
    "cvv",
    "cvc",
)

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


def _normalized_field_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def is_sensitive_field_name(value: str) -> bool:
    """Whether a query/form key is too risky to persist."""

    normalized = _normalized_field_name(value)
    return any(part in normalized for part in _SENSITIVE_NAME_PARTS)


def sanitize_url_params(value: Optional[str]) -> Optional[str]:
    """Canonicalize query data and redact values carried by sensitive keys."""

    if value is None:
        return None
    raw = value.strip().removeprefix("?")
    if not raw:
        return None
    if len(raw.encode("utf-8")) > MAX_URL_PARAMS_LENGTH:
        raise ValueError("URL parameters are too long")
    try:
        pairs = parse_qsl(raw, keep_blank_values=True, max_num_fields=200)
    except ValueError as error:
        raise ValueError("URL parameters are invalid") from error
    sanitized = [
        (name, REDACTED_VALUE if is_sensitive_field_name(name) else item_value)
        for name, item_value in pairs
    ]
    encoded = urlencode(sanitized, doseq=True)
    if len(encoded.encode("utf-8")) > MAX_URL_PARAMS_LENGTH:
        raise ValueError("URL parameters are too long")
    return encoded or None


def _truncate_utf8(value: str, limit: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value
    return encoded[:limit].decode("utf-8", errors="ignore")


def _snapshot_size(value: Dict[str, List[str]]) -> int:
    return len(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )


def sanitize_snapshot(value: Optional[Dict[str, List[str]]]) -> Optional[Dict[str, List[str]]]:
    """Keep a bounded latest-value snapshot while dropping sensitive fields."""

    if not value:
        return None
    result: Dict[str, List[str]] = {}
    for raw_key, raw_values in value.items():
        stripped_key = raw_key.strip()
        if not stripped_key or is_sensitive_field_name(stripped_key):
            continue
        key = _truncate_utf8(stripped_key, MAX_SNAPSHOT_KEY_BYTES)
        if key in result:
            # Two distinct long names may share the same retained prefix.  The
            # first wins; merging their values would corrupt the snapshot.
            continue
        if len(result) >= MAX_SNAPSHOT_FIELDS:
            break
        values: List[str] = []
        for raw_value in raw_values[:MAX_SNAPSHOT_VALUES_PER_FIELD]:
            candidate = _truncate_utf8(raw_value, MAX_SNAPSHOT_VALUE_BYTES)
            tentative = {**result, key: [*values, candidate]}
            if _snapshot_size(tentative) > MAX_SNAPSHOT_BYTES:
                break
            values.append(candidate)
        if values:
            result[key] = values
        if _snapshot_size(result) >= MAX_SNAPSHOT_BYTES:
            break
    return result or None


class BrowserPageReport(BaseModel):
    """One address's counters, as a delta since the previous report."""

    url: str = Field(min_length=1, max_length=2048)
    url_params: Optional[str] = Field(
        default=None, alias="urlParams", max_length=MAX_URL_PARAMS_LENGTH
    )
    visits: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    clicks: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    inputs: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    submits: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    scrolls: int = Field(default=0, ge=0, le=MAX_COUNT_PER_PAGE)
    dwell_ms: int = Field(default=0, alias="dwellMs", ge=0, le=MAX_DWELL_MS_PER_PAGE)
    first_seen_at_ms: int = Field(default=0, alias="firstSeenAtMs", ge=0)
    last_seen_at_ms: int = Field(default=0, alias="lastSeenAtMs", ge=0)
    input_snapshot: Optional[Dict[str, List[str]]] = Field(
        default=None, alias="inputSnapshot"
    )
    input_snapshot_at_ms: int = Field(default=0, alias="inputSnapshotAtMs", ge=0)
    submit_snapshot: Optional[Dict[str, List[str]]] = Field(
        default=None, alias="submitSnapshot"
    )
    submit_snapshot_at_ms: int = Field(default=0, alias="submitSnapshotAtMs", ge=0)
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        return normalize_reported_url(value)

    @field_validator("url_params")
    @classmethod
    def validate_url_params(cls, value: Optional[str]) -> Optional[str]:
        return sanitize_url_params(value)

    @field_validator("input_snapshot", "submit_snapshot")
    @classmethod
    def validate_snapshot(
        cls, value: Optional[Dict[str, List[str]]]
    ) -> Optional[Dict[str, List[str]]]:
        return sanitize_snapshot(value)

    @model_validator(mode="after")
    def validate_snapshot_timestamps(self) -> "BrowserPageReport":
        if self.input_snapshot is not None and self.input_snapshot_at_ms <= 0:
            raise ValueError("inputSnapshotAtMs is required with inputSnapshot")
        if self.submit_snapshot is not None and self.submit_snapshot_at_ms <= 0:
            raise ValueError("submitSnapshotAtMs is required with submitSnapshot")
        return self


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
    "MAX_SNAPSHOT_BYTES",
    "MAX_URL_LENGTH",
    "MAX_URL_PARAMS_LENGTH",
    "BrowserActivityReport",
    "BrowserPageReport",
    "is_sensitive_field_name",
    "normalize_reported_url",
    "sanitize_snapshot",
    "sanitize_url_params",
]
