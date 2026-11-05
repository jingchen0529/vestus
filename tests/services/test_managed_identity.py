from __future__ import annotations

import io
import json
import urllib.error
import urllib.request

import pytest

from app.services.managed_identity import probe_remote_identity

PLATFORM_URL = "https://agent.oceanengine.com/admin"
USER_INFO_URL = "https://agent.oceanengine.com/agent/user/user-info/"
COOKIES = [{"name": "sessionid", "value": "synthetic-session", "domain": ".oceanengine.com"}]


def test_http_401_is_an_invalid_session(monkeypatch: pytest.MonkeyPatch) -> None:
    error = urllib.error.HTTPError(
        USER_INFO_URL, 401, "Unauthorized", {},
        io.BytesIO(json.dumps({"code": 401, "msg": "请先登录"}).encode()),
    )

    def respond(*args: object, **kwargs: object) -> None:
        raise error

    monkeypatch.setattr(urllib.request, "urlopen", respond)
    outcome = probe_remote_identity(PLATFORM_URL, COOKIES)
    assert outcome is not None
    assert outcome.state == "invalid"
    assert "登录态已失效" in outcome.detail


@pytest.mark.parametrize(
    ("message", "expected"),
    [("没有获取到您的登录信息，请先登录", "invalid"), ("权限不足，请联系管理员", "unavailable"),
     ("访问受限，请完成安全验证", "unavailable")],
)
def test_http_403_distinguishes_expired_login_from_access_restrictions(
    monkeypatch: pytest.MonkeyPatch, message: str, expected: str,
) -> None:
    error = urllib.error.HTTPError(
        USER_INFO_URL, 403, "Forbidden", {},
        io.BytesIO(json.dumps({"code": 1, "msg": message}).encode()),
    )

    def respond(*args: object, **kwargs: object) -> None:
        raise error

    monkeypatch.setattr(urllib.request, "urlopen", respond)
    outcome = probe_remote_identity(PLATFORM_URL, COOKIES)
    assert outcome is not None
    assert outcome.state == expected
    assert "synthetic-session" not in outcome.detail


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"code": 0, "data": {"userId": "test-user", "userName": "测试用户"}}, "verified"),
        ({"code": 1001, "msg": "未登录，synthetic-session 已失效"}, "invalid"),
        ({"code": 1002, "message": "session expired"}, "invalid"),
        ({"code": 1, "msg": "权限不足"}, "unavailable"),
        ({"code": 429, "msg": "请求过于频繁"}, "unavailable"),
        ({"code": 12345, "msg": "未知错误 synthetic-session"}, "unavailable"),
        ({"code": 0, "data": {}}, "unavailable"),
        ({"code": 0, "data": None}, "unavailable"),
        ({"data": {"userId": "test-user"}}, "unavailable"),
        ({"code": False, "data": {"userId": "test-user"}}, "unavailable"),
        ({"code": 0.5, "data": {"userId": "test-user"}}, "unavailable"),
        ({"code": "bad", "data": {"userId": "test-user"}}, "unavailable"),
    ],
)
def test_json_classification_requires_login_evidence(
    monkeypatch: pytest.MonkeyPatch, body: dict, expected: str,
) -> None:
    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: io.BytesIO(json.dumps(body).encode()))
    outcome = probe_remote_identity(PLATFORM_URL, COOKIES)
    assert outcome is not None
    assert outcome.state == expected
    assert "synthetic-session" not in outcome.detail


@pytest.mark.parametrize("status", [429, 500, 502, 503])
def test_upstream_failure_is_unknown_even_with_a_login_message(
    monkeypatch: pytest.MonkeyPatch, status: int,
) -> None:
    error = urllib.error.HTTPError(
        USER_INFO_URL, status, "synthetic-session", {},
        io.BytesIO(json.dumps({"code": 1, "msg": "请先登录"}).encode()),
    )

    def respond(*args: object, **kwargs: object) -> None:
        raise error

    monkeypatch.setattr(urllib.request, "urlopen", respond)
    outcome = probe_remote_identity(PLATFORM_URL, COOKIES)
    assert outcome is not None
    assert outcome.state == "unavailable"
    assert "synthetic-session" not in outcome.detail


@pytest.mark.parametrize("body", [b"<html>Please log in</html>", b"[]", b"null", b"not-json"])
def test_non_object_payload_is_unknown(monkeypatch: pytest.MonkeyPatch, body: bytes) -> None:
    monkeypatch.setattr(urllib.request, "urlopen", lambda *args, **kwargs: io.BytesIO(body))
    outcome = probe_remote_identity(PLATFORM_URL, COOKIES)
    assert outcome is not None
    assert outcome.state == "unavailable"


def test_timeout_does_not_expose_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    def respond(*args: object, **kwargs: object) -> None:
        raise urllib.error.URLError(TimeoutError("synthetic-session"))

    monkeypatch.setattr(urllib.request, "urlopen", respond)
    outcome = probe_remote_identity(PLATFORM_URL, COOKIES)
    assert outcome is not None
    assert outcome.state == "unavailable"
    assert "synthetic-session" not in outcome.detail
