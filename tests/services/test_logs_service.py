"""Service-layer tests for ``app.services.logs``.

Pins the audit-log tenancy rule: a plain administrator sees their own actions,
their bound users' actions, and nothing else.  Log rows are arranged directly
(the log store is a read-only domain; what the rows mean is the writers'
business, covered in their own test files).
"""

from __future__ import annotations

from typing import Any, Dict

import pytest
from sqlalchemy import MetaData, String

from app.core.security import hash_password
from app.db.models import Admin, UserLog
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


@pytest.mark.parametrize(
    "actor_type,action,action_label,category,category_label",
    [
        ("admin", "LOGIN", "登录", "admin_login", "管理端登录"),
        ("admin", "LOGOUT", "退出登录", "admin_login", "管理端登录"),
        ("admin", "USER_CREATE", "创建桌面用户", "admin_operation", "管理端操作"),
        ("admin", "DESKTOP_FAQ_UPDATED", "更新帮助内容", "admin_operation", "管理端操作"),
        ("user", "LOGIN", "登录", "desktop_login", "桌面端登录"),
        ("user", "LOGOUT", "退出登录", "desktop_login", "桌面端登录"),
        ("user", "CHANGE_PASSWORD", "修改密码", "desktop_operation", "桌面端操作"),
        ("user", "MANAGED_SESSION_BOOTSTRAP_ISSUED", "签发托管登录票据", "desktop_operation", "桌面端操作"),
        ("system", "LOGIN", "登录", "unknown", "来源不明"),
        ("system", "BACKGROUND_TASK", "其他操作", "system", "系统操作"),
        ("legacy", "OLD_ACTION", "其他操作", "unknown", "来源不明"),
    ],
)
def test_logs_expose_chinese_labels_and_categories_without_rewriting_events(
    service_db: Database,
    actor_type: str,
    action: str,
    action_label: str,
    category: str,
    category_label: str,
) -> None:
    log_id = _log(service_db, actor_type=actor_type, action=action, summary="原始操作说明")

    detail = logs_service.get_log(service_db, log_id)
    assert detail["action"] == action
    assert detail["actorType"] == actor_type
    assert detail["summary"] == "原始操作说明"
    assert detail["actionLabel"] == action_label
    assert detail["category"] == category
    assert detail["categoryLabel"] == category_label
    assert logs_service.list_logs(service_db)["items"][0] == detail
    assert logs_service.list_recent(service_db)[0] == detail


def test_category_filters_match_display_before_pagination(service_db: Database) -> None:
    records = [
        ("admin", "LOGIN", "SUCCESS", None, "admin_login"),
        ("admin", "LOGOUT", "SUCCESS", None, "admin_login"),
        ("admin", "DESKTOP_FAQ_UPDATED", "SUCCESS", None, "admin_operation"),
        ("user", "LOGIN", "FAILED", None, "desktop_login"),
        ("user", "LOGOUT", "SUCCESS", None, "desktop_login"),
        ("user", "CHANGE_PASSWORD", "SUCCESS", None, "desktop_operation"),
        ("user", "MANAGED_SESSION_EXPIRED", "SUCCESS", None, "desktop_operation"),
        ("system", "LOGIN", "FAILED", {"authSource": "admin"}, "admin_login"),
        ("system", "LOGIN", "FAILED", {"authSource": "desktop"}, "desktop_login"),
        ("system", "LOGIN", "FAILED", None, "unknown"),
        ("system", "LOGIN", "FAILED", {"authSource": "other"}, "unknown"),
        ("system", "FUTURE_EVENT", "SUCCESS", {"authSource": "admin"}, "system"),
        ("legacy", "LOGIN", "FAILED", {"authSource": "desktop"}, "unknown"),
        ("admin", "LOGIN", "SUCCESS", {"authSource": "desktop"}, "admin_login"),
    ]
    expected: Dict[str, list[int]] = {}
    for actor_type, action, status, details, category in records:
        log_id = _log(service_db, actor_type=actor_type, action=action, status=status, details=details)
        expected.setdefault(category, []).insert(0, log_id)

    for category, expected_ids in expected.items():
        actual_ids = []
        for page in range(1, len(expected_ids) + 1):
            result = logs_service.list_logs(service_db, category=category, page=page, page_size=1)
            assert result["total"] == len(expected_ids)
            assert result["pages"] == len(expected_ids)
            assert len(result["items"]) == 1
            actual_ids.append(result["items"][0]["id"])
            assert result["items"][0]["category"] == category
        assert actual_ids == expected_ids

    failures = logs_service.list_logs(service_db, category="admin_login", status="FAILED")
    assert failures["total"] == 1
    assert failures["items"][0]["details"] == {"authSource": "admin"}
    assert failures["items"][0]["actorType"] == "system"


def test_category_filters_only_narrow_plain_admin_visibility(service_db: Database) -> None:
    admin_a = _make_admin(service_db, "audit-admin-a")
    admin_b = _make_admin(service_db, "audit-admin-b")
    user_a = _make_bound_user(service_db, admin_a, "audit-user-a")
    user_b = _make_bound_user(service_db, admin_b, "audit-user-b")
    own = _log(service_db, actor_type="admin", actor_id=admin_a, action="USER_CREATE")
    bound = _log(service_db, actor_type="user", actor_id=user_a["id"], action="LOGIN")
    on_bound_user = _log(
        service_db, actor_type="admin", actor_id=admin_b, action="USER_RESET_PASSWORD",
        target_type="user", target_id=user_a["id"],
    )
    _log(service_db, actor_type="admin", actor_id=admin_b, action="USER_CREATE")
    _log(service_db, actor_type="user", actor_id=user_b["id"], action="LOGIN")
    _log(service_db, actor_type="system", action="LOGIN", details={"authSource": "admin"})
    _log(service_db, actor_type="system", action="LOGIN", details={"authSource": "desktop"})

    admin_ops = logs_service.list_logs(service_db, category="admin_operation", visible_admin_id=admin_a)
    assert {item["id"] for item in admin_ops["items"]} == {own, on_bound_user}
    user_logins = logs_service.list_logs(service_db, category="desktop_login", visible_admin_id=admin_a)
    assert [item["id"] for item in user_logins["items"]] == [bound]
    anonymous = logs_service.list_logs(service_db, category="admin_login", visible_admin_id=admin_a)
    assert anonymous["total"] == 0
    outside_scope = logs_service.list_logs(
        service_db, category="desktop_login", actor_id=user_b["id"], visible_admin_id=admin_a,
    )
    assert outside_scope["total"] == 0


def test_category_filter_is_exact_even_with_case_insensitive_columns(service_db: Database) -> None:
    # Isolated SQLite fixture: mimic case-insensitive MySQL column comparisons,
    # without touching the deployment database or changing the shared ORM model.
    table = UserLog.__table__.to_metadata(MetaData())
    table.c.actor_type.type = String(16, collation="NOCASE")
    table.c.action.type = String(64, collation="NOCASE")
    with service_db.engine.begin() as connection:
        table.drop(connection)
        table.create(connection)
    records = [
        ("admin", "LOGIN", "admin_login"),
        ("admin", "login", "admin_operation"),
        ("ADMIN", "LOGIN", "unknown"),
        ("admin ", "LOGIN", "unknown"),
        ("user", "logout", "desktop_operation"),
        ("USER", "LOGOUT", "unknown"),
        ("system", "login", "system"),
    ]
    expected: Dict[str, list[int]] = {}
    for actor_type, action, category in records:
        log_id = _log(service_db, actor_type=actor_type, action=action)
        expected.setdefault(category, []).insert(0, log_id)
    for category, ids in expected.items():
        result = logs_service.list_logs(service_db, category=category)
        assert [item["id"] for item in result["items"]] == ids
        assert all(item["category"] == category for item in result["items"])
