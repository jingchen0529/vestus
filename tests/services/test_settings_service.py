"""Service-layer tests for ``app.services.settings``.

Driven directly through the service interface -- ``database`` in, dict out,
``ServiceError`` on invalid input.  No HTTP client, no envelope, no router:
these tests pin business behaviour (field-level upsert, atomicity, audit
attribution) at the same seam the routers use.
"""

from __future__ import annotations

from typing import Dict

import pytest

from app.db.models import SystemSetting, UserLog
from app.db.session import Database
from app.services import settings as settings_service
from app.services import uploads as uploads_service
from app.services.audit import AuditContext
from app.services.errors import BadRequestError


def _stored_settings(database: Database) -> Dict[str, str]:
    with database.session() as session:
        return {row.key: row.value for row in session.query(SystemSetting).all()}


def test_set_branding_writes_only_supplied_fields(service_db: Database) -> None:
    branding = settings_service.set_branding(
        service_db, product_name="  vestus pro  ", admin_title="运营中台"
    )

    assert branding["productName"] == "vestus pro"
    assert branding["adminTitle"] == "运营中台"
    stored = _stored_settings(service_db)
    assert stored[settings_service.PRODUCT_NAME_KEY] == "vestus pro"
    # 字段级 upsert:没提供的键不落库,desktop_version 回读为默认空串。
    assert settings_service.DESKTOP_VERSION_KEY not in stored
    assert branding["desktopVersion"] == ""


def test_set_branding_without_actor_writes_no_audit_row(service_db: Database) -> None:
    settings_service.set_branding(service_db, product_name="x")

    with service_db.session() as session:
        assert session.query(UserLog).count() == 0


def test_set_branding_with_actor_writes_audit_row(service_db: Database) -> None:
    audit = AuditContext(actor_type="admin", actor_id=1, actor_username="boss", ip="203.0.113.9")

    settings_service.set_branding(service_db, admin_title="新标题", audit=audit)

    with service_db.session() as session:
        row = session.query(UserLog).one()
    assert row.action == "SYSTEM_SETTINGS_UPDATE"
    assert row.actor_username == "boss"
    assert row.target_type == "system"
    assert row.target_name == "branding"
    assert row.status == "SUCCESS"


def test_set_branding_is_atomic_when_a_logo_is_invalid(service_db: Database) -> None:
    uploads_service.create_uploaded_file(
        service_db,
        original_name="ok.png",
        path="/uploads/ok.png",
        content_type="image/png",
        size=10,
        uploaded_by=1,
    )

    with pytest.raises(BadRequestError):
        settings_service.set_branding(
            service_db,
            product_name="新名字",
            logo_url="/uploads/ok.png",
            admin_logo_url="/uploads/missing.png",
        )

    # 回归:两个 logo 先全部校验、后统一写入。曾经第二个值被拒时前几个
    # 字段已经半落地,导致管理端处于无法解释的「半个新皮肤」状态。
    stored = _stored_settings(service_db)
    assert settings_service.PRODUCT_NAME_KEY not in stored
    assert settings_service.PRODUCT_LOGO_KEY not in stored
