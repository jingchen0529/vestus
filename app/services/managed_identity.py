"""Server-side, read-only identity probes for managed platform cookies.

A probe answers two questions with one lightweight HTTP call against the
platform's own user-info endpoint: the stored cookie bundle still holds a
valid login session, and *whose* session it is.  The outcome is display
metadata plus a tri-state verdict:

* ``verified``   – the session is alive and the identity fields are filled.
* ``invalid``    – the upstream definitively reports a dead session.
* ``unavailable`` – the probe itself failed (network, timeout, bad payload);
  callers must treat this as "unknown", never as a verdict on the cookie.

Platforms without a probe entry return ``None``: no probing happens and no
code path may block on it.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional
from urllib.parse import urljoin, urlsplit

# Only the registrable domain matters: the session cookie is set on
# ``.oceanengine.com`` and works on every subdomain, so one entry covers
# ``agent.oceanengine.com`` and friends.
PROBE_PLATFORM_DOMAIN = "oceanengine.com"
USER_INFO_PATH = "/agent/user/user-info/"

# Session cookie names in preference order.  Raw paste input may carry
# duplicates (SSO redirects echo older values); the *last* occurrence wins,
# matching what the browser would actually hold.
SESSION_COOKIE_NAMES = ("sessionid", "sessionid_ss")

PROBE_TIMEOUT_SECONDS = 10
PROBE_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
)


@dataclass(frozen=True)
class IdentityProbeOutcome:
    state: str  # "verified" | "invalid" | "unavailable"
    remote_account_id: Optional[str] = None
    remote_display_name: Optional[str] = None
    detail: str = ""


def _platform_domain(platform_url: str) -> str:
    hostname = (urlsplit(str(platform_url)).hostname or "").lower().strip(".")
    if not hostname:
        return ""
    return hostname


def _supports_platform(platform_url: str) -> bool:
    hostname = _platform_domain(platform_url)
    return hostname == PROBE_PLATFORM_DOMAIN or hostname.endswith(f".{PROBE_PLATFORM_DOMAIN}")


def _domain_matches(cookie_domain: str) -> bool:
    domain = str(cookie_domain or "").lower().strip().lstrip(".")
    return not domain or domain == PROBE_PLATFORM_DOMAIN or domain.endswith(
        f".{PROBE_PLATFORM_DOMAIN}"
    )


def _session_cookie_value(cookie_bundle: List[Dict[str, Any]]) -> Optional[str]:
    for name in SESSION_COOKIE_NAMES:
        value: Optional[str] = None
        for item in cookie_bundle:
            if not isinstance(item, Mapping):
                continue
            if str(item.get("name", "")).strip() != name:
                continue
            if not _domain_matches(str(item.get("domain", ""))):
                continue
            candidate = str(item.get("value", "")).strip()
            if candidate:
                value = candidate
        if value:
            return value
    return None


def _display_name(payload: Mapping[str, Any]) -> Optional[str]:
    user_name = str(payload.get("userName") or payload.get("employeeName") or "").strip()
    company_name = str(payload.get("companyName") or "").strip()
    if user_name and company_name:
        return f"{user_name} · {company_name}"
    return user_name or None


def probe_remote_identity(
    platform_url: str, cookie_bundle: List[Dict[str, Any]]
) -> Optional[IdentityProbeOutcome]:
    """Probe the platform user-info endpoint with the bundle's session cookie.

    Returns ``None`` when the platform has no probe or the bundle carries no
    usable session cookie — both mean "nothing to say", not "invalid".
    """
    if not _supports_platform(platform_url):
        return None
    session_value = _session_cookie_value(cookie_bundle)
    if not session_value:
        return None

    request_url = urljoin(
        str(platform_url) if "://" in str(platform_url) else f"https://{platform_url}",
        USER_INFO_PATH,
    )
    origin = f"https://{_platform_domain(platform_url)}" if _platform_domain(platform_url) else ""
    headers = {
        "accept": "application/json, text/plain, */*",
        "referer": f"{origin}/admin",
        "user-agent": PROBE_USER_AGENT,
        "cookie": f"sessionid={session_value}",
    }
    request = urllib.request.Request(request_url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT_SECONDS) as response:
            body = response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return IdentityProbeOutcome(state="unavailable", detail=f"identity probe failed: {exc}")

    try:
        payload = json.loads(body)
        if not isinstance(payload, Mapping):
            raise ValueError("payload is not a JSON object")
    except ValueError as exc:
        return IdentityProbeOutcome(state="unavailable", detail=f"identity probe payload invalid: {exc}")

    try:
        code = int(payload.get("code", -1))
    except (TypeError, ValueError):
        code = -1
    if code != 0:
        message = str(payload.get("msg") or "上游返回未登录").strip()
        return IdentityProbeOutcome(state="invalid", detail=message)

    data = payload.get("data")
    if not isinstance(data, Mapping):
        return IdentityProbeOutcome(state="unavailable", detail="identity probe data missing")
    remote_account_id = str(data.get("userId") or "").strip() or None
    display_name = _display_name(data)
    if not remote_account_id and not display_name:
        return IdentityProbeOutcome(state="unavailable", detail="identity probe returned no identity")
    return IdentityProbeOutcome(
        state="verified",
        remote_account_id=remote_account_id,
        remote_display_name=display_name,
        detail="登录态有效",
    )


__all__ = ["IdentityProbeOutcome", "probe_remote_identity"]
