"""Service-layer tests for ``app.services.proxies``.

Pins the default-mark invariant ("only an active proxy may be the default",
at most one holder) and the credential-at-rest rule (Fernet ciphertext, never
the plaintext, never serialized).
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from app.core.security import decrypt_proxy_password
from app.db.models import Proxy, UserLog
from app.db.session import Database
from app.services import proxies as proxies_service
from app.services.audit import AuditContext
from app.services.errors import BadRequestError, ConflictError, NotFoundError

PROXY_VALUES = {
    "name": "沪节点",
    "host": "sh.example.com",
    "port": 8080,
    "username": "sh-user",
    "password": "s3cret",
}


def _proxy_row(service_db: Database, proxy_id: int) -> Proxy:
    with service_db.session() as session:
        return session.get(Proxy, proxy_id)


def _create(service_db: Database, **overrides: Any) -> Dict[str, Any]:
    return proxies_service.create_proxy(service_db, {**PROXY_VALUES, **overrides})


def test_default_mark_moves_to_the_new_holder(service_db: Database) -> None:
    first = _create(service_db, is_default=True)
    second = _create(service_db, name="京节点", is_default=True)

    # 同一时刻至多一个默认节点:新持有者上任,旧持有者被清掉。
    assert _proxy_row(service_db, first["id"]).is_default is False
    assert _proxy_row(service_db, second["id"]).is_default is True


def test_contradictory_default_request_is_rejected(service_db: Database) -> None:
    # 既要默认标记又要停用状态:矛盾的请求直接拒绝,让错误可见。
    with pytest.raises(BadRequestError):
        _create(service_db, is_default=True, status="disabled")

    with service_db.session() as session:
        assert session.query(Proxy).count() == 0


def test_duplicate_name_is_conflict(service_db: Database) -> None:
    _create(service_db)

    with pytest.raises(ConflictError):
        _create(service_db)


def test_disabling_the_default_drops_the_mark_say_so_in_audit(service_db: Database) -> None:
    audit = AuditContext(actor_type="admin", actor_id=1, actor_username="boss")
    proxy = _create(service_db, is_default=True)

    result = proxies_service.update_proxy(
        service_db, proxy["id"], {"status": "disabled"}, audit=audit
    )

    row = _proxy_row(service_db, proxy["id"])
    assert row.status == "disabled"
    assert row.is_default is False
    # 审计行必须说明默认标记被摘除,不能让运维自己发现默认节点没了。
    assert result["isDefault"] is False
    with service_db.session() as session:
        log_row = session.query(UserLog).one()
    assert log_row.action == "PROXY_UPDATE"
    assert log_row.details["defaultCleared"] is True
    assert "已取消其默认标记" in log_row.summary


def test_update_rejects_default_mark_with_disabled_status(service_db: Database) -> None:
    proxy = _create(service_db)

    with pytest.raises(BadRequestError):
        proxies_service.update_proxy(
            service_db, proxy["id"], {"is_default": True, "status": "disabled"}
        )

    assert _proxy_row(service_db, proxy["id"]).is_default is False


def test_password_is_fernet_ciphertext_at_rest(service_db: Database) -> None:
    proxy = _create(service_db)

    row = _proxy_row(service_db, proxy["id"])
    assert "s3cret" not in str(row.encrypted_password)
    # 可逆加密而非哈希:桌面端要拿明文配置本地代理适配器。
    assert decrypt_proxy_password(row.encrypted_password) == "s3cret"


def test_delete_removes_the_row(service_db: Database) -> None:
    proxy = _create(service_db)

    assert proxies_service.delete_proxy(service_db, proxy["id"]) is True
    assert proxies_service.get_proxy(service_db, proxy["id"]) is None
    with pytest.raises(NotFoundError):
        proxies_service.delete_proxy(service_db, proxy["id"])
