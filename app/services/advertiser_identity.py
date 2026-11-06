"""Conservative advertiser identification from recorded, sanitized page URLs."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import parse_qsl, urlsplit

ADVERTISER_ID_PATTERN = r"[1-9][0-9]{0,63}"


@dataclass(frozen=True)
class AdvertiserExtraction:
    advertiser_id: Optional[str]
    reason: str


def extract_advertiser(url: str, url_params: Optional[str]) -> AdvertiserExtraction:
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
    except ValueError:
        return AdvertiserExtraction(None, "unsupported")
    supported = host in {"localads.chengzijianzhan.cn", "oceanengine.com"} or host.endswith(".oceanengine.com")
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or not supported:
        return AdvertiserExtraction(None, "unsupported")
    try:
        pairs = parse_qsl(url_params or "", keep_blank_values=True, max_num_fields=200)
    except ValueError:
        return AdvertiserExtraction(None, "invalid")
    values = {value for name, value in pairs if name == "advid"}
    if not values:
        return AdvertiserExtraction(None, "missing")
    if any(re.fullmatch(ADVERTISER_ID_PATTERN, value) is None for value in values):
        return AdvertiserExtraction(None, "invalid")
    if len(values) != 1:
        return AdvertiserExtraction(None, "ambiguous")
    return AdvertiserExtraction(values.pop(), "matched")
