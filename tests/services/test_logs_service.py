"""Service-layer tests for ``app.services.logs``.

Pins the audit-log tenancy rule: a plain administrator sees their own actions,
their bound users' actions, and nothing else.  Log rows are arranged directly
(the log store is a read-only domain; what the rows mean is the writers'
business, covered in their own test files).
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from app.core.security import hash_password
from app.db.models import Admin
from app.db.session import Database
from app.repositories import logs as logs_repo
from app.services import logs as logs_service
from app.services import users as users_service
from app.services.errors import NotFoundError


def _make_admin(service_db: Database, username: str) -> int:
    with service_db.session() as session:
        admin = Admin(
            username=username,
            name=username,
            password_hash=hash_password("pw-123456"),
            role="admin",
        )
        session.add(admin)
        session.flush()
        return int(admin.id)


def _make_bound_user(service_db: Database, admin_id: int, username: str) -> Dict[str, Any]:
    return users_service.create_user(
        service_db, {"username": username, "name": username, "password": "password-1",
                     "bound_admin_id": admin_id}
    )


def _log(service_db: Database, **values: Any) -> int:
    payload = {"action": "PROXY_CREATE", "summary": "记一条", "status": "SUCCESS", **values}
    with service_db.session() as session:
        item = logs_repo.create(session, **payload)
        session.flush()  # repo 只 add:自增 id 要 flush 后才存在
        return int(item.id)


def test_super_admin_sees_everything(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "admin-a")
    admin_b = _make_admin(service_db, "admin-b")
    user_a = _make_bound_user(service_db, admin_a, "op1")
    user_b = _make_bound_user(service_db, admin_b, "op2")
    _log(service_db, actor_type="admin", actor_id=admin_a, actor_username="admin-a")
    _log(service_db, actor_type="user", actor_id=user_a["id"], actor_username="op1")
    other_tenant = _log(
        service_db, actor_type="user", actor_id=user_b["id"], actor_username="op2"
    )
    _log(service_db, actor_type="admin", actor_id=admin_b, actor_username="admin-b")

    result = logs_service.list_logs(service_db)

    assert result["total"] == 4
    # 超管能看到任何一行,包括别的租户的。
    assert logs_service.get_log(service_db, other_tenant)["id"] == other_tenant


def test_plain_admin_is_scoped_to_own_actions_and_bound_users(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "admin-a")
    admin_b = _make_admin(service_db, "admin-b")
    user_a = _make_bound_user(service_db, admin_a, "op1")
    user_b = _make_bound_user(service_db, admin_b, "op2")
    own = _log(service_db, actor_type="admin", actor_id=admin_a, actor_username="admin-a")
    from_bound_user = _log(
        service_db, actor_type="user", actor_id=user_a["id"], actor_username="op1"
    )
    _log(service_db, actor_type="user", actor_id=user_b["id"], actor_username="op2")
    _log(service_db, actor_type="admin", actor_id=admin_b, actor_username="admin-b")

    result = logs_service.list_logs(service_db, visible_admin_id=admin_a)

    assert result["total"] == 2
    assert {item["id"] for item in result["items"]} == {own, from_bound_user}


def test_plain_admin_cannot_read_other_tenants_log(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "admin-a")
    admin_b = _make_admin(service_db, "admin-b")
    user_b = _make_bound_user(service_db, admin_b, "op2")
    foreign = _log(
        service_db, actor_type="user", actor_id=user_b["id"], actor_username="op2"
    )

    with pytest.raises(NotFoundError):
        logs_service.get_log(service_db, foreign, visible_admin_id=admin_a)


def test_action_filter_combines_with_visibility(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "admin-a")
    admin_b = _make_admin(service_db, "admin-b")
    user_a = _make_bound_user(service_db, admin_a, "op1")
    user_b = _make_bound_user(service_db, admin_b, "op2")
    _log(service_db, actor_type="admin", actor_id=admin_a, actor_username="admin-a",
         action="USER_CREATE")
    _log(service_db, actor_type="user", actor_id=user_a["id"], actor_username="op1",
         action="PROXY_CREATE")
    _log(service_db, actor_type="user", actor_id=user_b["id"], actor_username="op2",
         action="USER_CREATE")
    _log(service_db, actor_type="admin", actor_id=admin_b, actor_username="admin-b",
         action="PROXY_CREATE")

    scoped = logs_service.list_logs(
        service_db, action="USER_CREATE", visible_admin_id=admin_a
    )
    assert scoped["total"] == 1

    unscoped = logs_service.list_logs(service_db, action="PROXY_CREATE")
    assert unscoped["total"] == 2


def test_pagination_envelope(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "admin-a")
    for index in range(3):
        _log(service_db, actor_type="admin", actor_id=admin_a,
             actor_username="admin-a", action=f"ACTION-{index}")

    page_one = logs_service.list_logs(service_db, page=1, page_size=2)
    assert page_one["total"] == 3
    assert page_one["pages"] == 2
    assert len(page_one["items"]) == 2

    page_two = logs_service.list_logs(service_db, page=2, page_size=2)
    assert len(page_two["items"]) == 1
