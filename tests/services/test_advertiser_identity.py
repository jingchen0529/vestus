from __future__ import annotations

import pytest

from app.services.advertiser_identity import extract_advertiser


@pytest.mark.parametrize(
    ("url", "query", "advertiser_id", "reason"),
    [
        ("https://localads.chengzijianzhan.cn/lamp/pc/cdp_promotion/promote-manage/project",
         "isOC=1&from=%2Fcdp_promotion%2Fpromote-manage%2Fad&advid=1806535079613578&filter_st=%25222026-11-03%2522",
         "1806535079613578", "matched"),
        ("https://agent.oceanengine.com/admin", "advid=90071992547409931234", "90071992547409931234", "matched"),
        ("https://oceanengine.com/", "advid=%31%32%33&advid=123", "123", "matched"),
        ("https://oceanengine.com.evil.test/", "advid=123", None, "unsupported"),
        ("https://eviloceanengine.com/", "advid=123", None, "unsupported"),
        ("https://other.chengzijianzhan.cn/", "advid=123", None, "unsupported"),
        ("https://oceanengine.com/", "from=https%3A%2F%2Foceanengine.com%2F%3Fadvid%3D123", None, "missing"),
        ("https://oceanengine.com/", "ADVID=123", None, "missing"),
        ("https://oceanengine.com/", "advid=123&advid=456", None, "ambiguous"),
        ("https://oceanengine.com/", "advid=123&advid=", None, "invalid"),
        ("https://oceanengine.com/", "advid=0", None, "invalid"),
        ("https://oceanengine.com/", "advid=01", None, "invalid"),
        ("https://oceanengine.com/", "advid=%2531", None, "invalid"),
        ("https://oceanengine.com/", "advid=１２３", None, "invalid"),
        ("https://oceanengine.com/", "advid=" + "9" * 65, None, "invalid"),
    ],
)
def test_advertiser_extraction_uses_only_unambiguous_supported_top_level_query(
    url: str, query: str, advertiser_id: str | None, reason: str,
) -> None:
    result = extract_advertiser(url, query)
    assert result.advertiser_id == advertiser_id
    assert result.reason == reason
