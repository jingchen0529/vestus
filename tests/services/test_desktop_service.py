"""Service-layer tests for ``app.services.desktop``.

Pins the desktop-lease contract: the lease hashes every piece of global state
that can change a desktop route, so the client can detect stale configuration
with one string comparison.  Also pins the defensive ``active`` re-check --
a resource disabled between query and serialization must not be served.
"""

from __future__ import annotations

from typing import Any, Dict

from app.db.session import Database
from app.services import desktop as desktop_service
from app.services import proxies as proxies_service
from app.services import users as users_service

PROXY_VALUES = {
    "name": "沪节点",
    "host": "sh.example.com",
    "port": 8080,
    "username": "sh-user",
    "password": "s3cret",
}


def _user(service_db: Database, username: str = "op1") -> Dict[str, Any]:
    return users_service.create_user(
        service_db, {"username": username, "name": "运营一号", "password": "password-1"}
    )


def test_unknown_user_gets_nothing(service_db: Database) -> None:
    assert desktop_service.get_user_desktop_config_with_lease(service_db, 9999) is None
    assert desktop_service.get_user_desktop_lease(service_db, 9999) is None


def test_fresh_user_gets_empty_config_and_a_lease(service_db: Database) -> None:
    user = _user(service_db)

    config = desktop_service.get_user_desktop_config_with_lease(service_db, user["id"])

    assert config is not None
    assert config["proxy"] is None
    assert config["platforms"] == []
    assert config["profileKey"] == f"user-{user['id']}"
    assert isinstance(config["lease"], str) and config["lease"]
    # 同一快照的 lease 与独立查询一致:客户端两个入口拿到同一个指纹。
    assert desktop_service.get_user_desktop_lease(service_db, user["id"]) == config["lease"]


def test_lease_changes_when_proxy_assignment_changes(service_db: Database) -> None:
    fallback = proxies_service.create_proxy(service_db, dict(PROXY_VALUES))
    assigned = proxies_service.create_proxy(
        service_db, {**PROXY_VALUES, "name": "京节点", "host": "bj.example.com"}
    )
    user = _user(service_db)
    # 代理解析是三档:显式指派 > 默认节点 > 第一个活跃节点。库里没有默认节点,
    # 未指派的用户落在兜底档,拿到的是第一个活跃节点。
    served = desktop_service.get_user_desktop_config_with_lease(service_db, user["id"])
    assert served is not None and served["proxy"]["id"] == fallback["id"]
    lease_before = served["lease"]

    users_service.update_user(service_db, user["id"], {"proxy_id": assigned["id"]})

    # 显式指派命中第一档:节点变了,lease 必须跟着变,客户端据此感知要换线路。
    config = desktop_service.get_user_desktop_config_with_lease(service_db, user["id"])
    assert config is not None and config["proxy"]["id"] == assigned["id"]
    assert config["lease"] != lease_before
    assert desktop_service.get_user_desktop_lease(service_db, user["id"]) == config["lease"]


def test_disabled_proxy_is_not_served(service_db: Database) -> None:
    proxy = proxies_service.create_proxy(service_db, dict(PROXY_VALUES))
    user = _user(service_db)
    users_service.update_user(service_db, user["id"], {"proxy_id": proxy["id"]})
    served = desktop_service.get_user_desktop_config_with_lease(service_db, user["id"])
    assert served is not None and served["proxy"] is not None

    proxies_service.update_proxy(service_db, proxy["id"], {"status": "disabled"})

    # 停用的节点三档解析全部拿不到(各档都要求 active):用户退回无代理状态,
    # 而不是被塞进一个已经不能用的线路。
    config = desktop_service.get_user_desktop_config_with_lease(service_db, user["id"])
    assert config is not None and config["proxy"] is None
