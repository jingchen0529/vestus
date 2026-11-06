from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from tests.api.test_managed_platforms import (
    _bearer,
    _consume_bootstrap,
    _cookie_account_with_binding,
    _issue_bootstrap,
    _setup,
)
from tests.envelope import payload


@pytest.fixture(autouse=True)
def _no_external_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import managed_platforms as service

    monkeypatch.delenv("VESTUS_MANAGED_CHROMIUM_PATH", raising=False)
    monkeypatch.setattr(service, "_identity_probe", lambda *args, **kwargs: None)

    def forbidden_provider(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("bootstrap snapshot must not launch a browser")

    monkeypatch.setattr(service, "get_managed_login_provider", forbidden_provider)


def test_consumption_freezes_verified_identity_without_changing_response_keys(
    api: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import managed_platforms as service
    from app.services.managed_identity import IdentityProbeOutcome

    client, module = api
    admin, user, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin, platform)
    grant = _issue_bootstrap(client, user, platform, account_id)
    assert set(grant) == {
        "bootstrapToken", "managedAccountId", "credentialVersion", "allowedHosts", "expiresAt",
    }
    with module.db.session() as session:
        pending = session.query(module.ManagedBrowserSession).one()
        assert pending.identity_snapshot_at is None
        assert pending.managed_account_name is None

    # The identity is verified after issuance, but before the actual consumption.
    verified_at = module.utc_now()
    monkeypatch.setattr(service, "utc_now", lambda: verified_at)
    monkeypatch.setattr(
        service, "_identity_probe",
        lambda *args: IdentityProbeOutcome(
            state="verified", remote_account_id="remote-at-launch", remote_display_name="启动时账号",
        ),
    )
    checked = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/identity-check",
        headers=_bearer(admin),
    )
    assert checked.status_code == 200, checked.text

    def forbidden_probe(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("consume must use the stored verified identity without a network probe")

    monkeypatch.setattr(service, "_identity_probe", forbidden_probe)
    consumed_at = verified_at + timedelta(seconds=1)
    monkeypatch.setattr(service, "utc_now", lambda: consumed_at)
    consumed = _consume_bootstrap(client, user, platform, grant)
    assert set(consumed) == {
        "sessionId", "managedAccountId", "credentialVersion", "targetUrl",
        "cookieBundle", "allowedHosts", "expiresAt",
    }
    assert consumed["cookieBundle"][0]["value"] == "secret-cookie"
    assert consumed["managedAccountId"] == account_id
    assert consumed["credentialVersion"] == grant["credentialVersion"]

    # Subsequent account metadata must not rewrite the identity actually launched.
    monkeypatch.setattr(
        service, "_identity_probe",
        lambda *args: IdentityProbeOutcome(
            state="verified", remote_account_id="remote-later", remote_display_name="后来账号",
        ),
    )
    checked = client.post(
        f"/api/admin/managed-platform-accounts/{account_id}/identity-check",
        headers=_bearer(admin),
    )
    assert checked.status_code == 200, checked.text
    with module.db.session() as session:
        row = session.get(module.ManagedBrowserSession, int(consumed["sessionId"]))
        assert row.remote_account_id == "remote-at-launch"
        assert row.remote_display_name == "启动时账号"
        assert row.managed_account_name == "启动时账号"
        assert row.identity_verified_at == verified_at
        assert row.identity_snapshot_at == consumed_at
        assert row.consumed_at == consumed_at


@pytest.mark.parametrize("legacy_name", [None, "未验证的历史别名"])
def test_unverified_credentials_snapshot_alias_without_claiming_remote_identity(
    api: Any, monkeypatch: pytest.MonkeyPatch, legacy_name: str | None,
) -> None:
    from app.services import managed_platforms as service

    client, module = api
    admin, user, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin, platform)
    with module.db.session() as session:
        account = session.get(module.ManagedPlatformAccount, account_id)
        account.remote_account_id = "legacy-unverified-id"
        account.remote_display_name = legacy_name
        account.identity_checked_at = None
    grant = _issue_bootstrap(client, user, platform, account_id)

    def forbidden_probe(*args: Any, **kwargs: Any) -> Any:
        pytest.fail("ordinary consumption must not probe upstream")

    monkeypatch.setattr(service, "_identity_probe", forbidden_probe)
    consumed = _consume_bootstrap(client, user, platform, grant)
    with module.db.session() as session:
        row = session.get(module.ManagedBrowserSession, int(consumed["sessionId"]))
        assert row.remote_account_id is None
        assert row.remote_display_name is None
        assert row.identity_verified_at is None
        assert row.managed_account_name == (legacy_name or "方舟主账号")
        assert row.identity_snapshot_at == row.consumed_at
        assert row.identity_snapshot_at is not None


def test_rotation_between_issuance_and_consumption_rejects_old_ticket(api: Any) -> None:
    client, module = api
    admin, user, platform = _setup(client)
    account_id = _cookie_account_with_binding(client, admin, platform)
    grant = _issue_bootstrap(client, user, platform, account_id)
    rotated = client.patch(
        f"/api/admin/managed-platform-accounts/{account_id}",
        headers=_bearer(admin),
        json={"cookieBundle": [{"name": "sessionid", "value": "new-cookie", "domain": ".example.test"}]},
    )
    assert rotated.status_code == 200, rotated.text
    assert payload(rotated)["credentialVersion"] > grant["credentialVersion"]
    rejected = client.post(
        f"/api/user/managed-platforms/{platform['id']}/bootstrap/consume",
        headers=_bearer(user),
        json={"bootstrapToken": grant["bootstrapToken"], "deviceId": "device-a"},
    )
    assert rejected.status_code == 409, rejected.text
    with module.db.session() as session:
        row = session.query(module.ManagedBrowserSession).one()
        assert row.consumed_at is None
        assert row.identity_snapshot_at is None
        assert row.identity_verified_at is None
        assert row.remote_account_id is None
        assert row.remote_display_name is None
        assert row.managed_account_name is None
