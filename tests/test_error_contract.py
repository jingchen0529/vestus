"""The response contract's error paths.

The happy paths are covered by the endpoint suites; these are the places the
envelope was found leaking a different shape, kept as regressions:

* the router-layer 404 and 405, which Starlette raises rather than any handler
  here, and which answered with its bare ``{"detail": ...}`` until the handler
  was registered against Starlette's ``HTTPException`` instead of FastAPI's;
* the Chinese message those two now carry, plus the guarantee that substituting
  it does not trample the detail a router passed deliberately;
* the unhandled 500, which must carry a correlation id in both the envelope and
  the header without saying anything about the cause;
* ``/healthz``, which is contractually *outside* the envelope and has to stay
  bare even when the database handle blows up.
"""

from __future__ import annotations

from typing import Any, Iterator, Tuple, cast

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.api.deps import get_db
from app.api.envelope import EnvelopeRoute
from app.core.api_contract import ApiCode
from app.core.middleware import REQUEST_ID_HEADER
from tests.envelope import envelope

BOOM_PATH = "/__test_boom"
DELIBERATE_404_PATH = "/__test_missing"
DELIBERATE_404_DETAIL = "这条记录不存在"
LEAKED_SECRET = "mysql://user:hunter2@db.internal/vestus"


def served_app(client: TestClient) -> FastAPI:
    """``TestClient.app`` is annotated as a bare ASGI callable; here it is the app."""

    return cast(FastAPI, client.app)


@pytest.fixture()
def boom_client(api: Tuple[TestClient, Any]) -> Iterator[TestClient]:
    """A client with two extra routes: one that raises, one with a deliberate 404.

    The ``api`` fixture is function scoped, so these routes live and die with the
    test that asked for them.
    """

    client, _ = api
    app = served_app(client)
    router = APIRouter(route_class=EnvelopeRoute)

    @router.get(BOOM_PATH)
    def _boom() -> None:
        raise RuntimeError(LEAKED_SECRET)

    @router.get(DELIBERATE_404_PATH)
    def _missing() -> None:
        raise HTTPException(status_code=404, detail=DELIBERATE_404_DETAIL)

    app.include_router(router)
    app.openapi_schema = None
    # ``raise_server_exceptions`` off makes the client behave like a real server:
    # the 500 handler answers instead of the exception reaching the test.
    with TestClient(app, raise_server_exceptions=False) as boom:
        yield boom


def test_unmatched_path_is_enveloped(api: Tuple[TestClient, Any]) -> None:
    client, _ = api
    response = client.get("/api/no-such-endpoint")
    body = envelope(response)
    assert response.status_code == 404
    assert body["code"] == ApiCode.NOT_FOUND
    # Starlette's own detail is the English phrase; the toast has to read Chinese
    # like every other message this API produces.
    assert body["msg"] == "请求的接口不存在"


def test_wrong_method_is_enveloped(api: Tuple[TestClient, Any]) -> None:
    client, _ = api
    response = client.request("DELETE", "/api/network/ip")
    body = envelope(response)
    assert response.status_code == 405
    # The client computes ``status * 100`` when it cannot read an envelope, so
    # this code has to agree with that arithmetic.
    assert body["code"] == ApiCode.METHOD_NOT_ALLOWED == response.status_code * 100
    assert body["msg"] == "该接口不支持此请求方法"


def test_a_router_keeps_its_own_404_message(boom_client: TestClient) -> None:
    """Only Starlette's filled-in default is replaced, never a deliberate one.

    The substitution keys off ``exc.detail == HTTPStatus(404).phrase``, so a
    router that passed its own Chinese detail has to come back with it intact --
    otherwise "用户不存在" would degrade to the generic "请求的接口不存在".
    """

    response = boom_client.get(DELIBERATE_404_PATH)
    body = envelope(response)
    assert response.status_code == 404
    assert body["code"] == ApiCode.NOT_FOUND
    assert body["msg"] == DELIBERATE_404_DETAIL


def test_code_recovers_the_status_for_every_error(api: Tuple[TestClient, Any]) -> None:
    """``code // 100 == status`` is the one promise a client may rely on."""

    client, _ = api
    for path, method, expected_status in [
        ("/api/no-such-endpoint", "GET", 404),
        ("/api/network/ip", "DELETE", 405),
        ("/api/admin/users", "GET", 401),
    ]:
        response = client.request(method, path)
        body = envelope(response)
        assert response.status_code == expected_status, path
        assert body["code"] // 100 == response.status_code, (path, body["code"])


def test_unhandled_error_is_enveloped_without_leaking_the_cause(
    boom_client: TestClient,
) -> None:
    response = boom_client.get(BOOM_PATH)
    body = envelope(response)
    assert response.status_code == 500
    assert body["code"] == ApiCode.INTERNAL
    assert LEAKED_SECRET not in response.text
    assert "hunter2" not in response.text


def test_unhandled_error_carries_a_correlation_id_in_both_places(
    boom_client: TestClient,
) -> None:
    """The header is how an operator finds the request in the server log.

    An exception propagates past ``RequestIdMiddleware``'s ``call_next``, so its
    header pass never runs; the handler has to set the header itself.
    """

    response = boom_client.get(BOOM_PATH, headers={REQUEST_ID_HEADER: "trace-me-1234"})
    body = envelope(response)
    assert body["requestId"] == "trace-me-1234"
    assert response.headers.get(REQUEST_ID_HEADER) == "trace-me-1234"


def test_healthz_stays_bare_when_the_database_handle_raises(
    api: Tuple[TestClient, Any],
) -> None:
    """The probe's consumers do not know the envelope, so it must not appear.

    ``ping`` swallows ``SQLAlchemyError`` itself, but an engine-level failure
    raises something else, and that used to reach the global handler and come
    back as an envelope -- unreadable to the ``curl | jq '.status'`` in
    ``docs/deploy-linux.md``.
    """

    client, _ = api
    app = served_app(client)

    class ExplodingDatabase:
        def ping(self) -> bool:
            raise OperationalError("SELECT 1", {}, Exception("engine gone"))

    app.dependency_overrides[get_db] = ExplodingDatabase
    try:
        with TestClient(app, raise_server_exceptions=False) as probe:
            response = probe.get("/healthz")
    finally:
        app.dependency_overrides.pop(get_db, None)

    body = response.json()
    assert response.status_code == 503
    assert body == {"status": "degraded", "database": "unavailable"}
