from datetime import datetime, timedelta

import pytest

from app.services.errors import BadRequestError
from app.services.network_metrics import query_window


def test_network_query_window_rejects_invalid_dates() -> None:
    with pytest.raises(BadRequestError, match="时间范围格式无效"):
        query_window("not-a-date", "2026-01-01")


def test_network_query_window_rejects_more_than_31_days() -> None:
    start = datetime(2026, 1, 1)
    end = start + timedelta(days=31, seconds=1)
    with pytest.raises(BadRequestError, match="不能超过 31 天"):
        query_window(start, end)


def test_network_query_window_accepts_a_bounded_window() -> None:
    start = datetime(2026, 1, 1)
    end = start + timedelta(days=31)
    assert query_window(start, end) == (start, end)
