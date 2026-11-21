use super::*;

use crate::browser::BrowserError;
use crate::profile;

#[tokio::test]
async fn managed_page_closed_keeps_healthy_watch_without_reporting_expiry() {
    use std::time::Duration;

    use serde_json::json;
    use tauri::{
        test::{mock_builder, mock_context, noop_assets},
        Listener,
    };

    let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let auth =
        crate::auth::tests::authenticated_state(&format!("http://{}", api.local_addr().unwrap()));
    let (user_id, _, auth_generation) = auth.current_identity().unwrap();
    let app = mock_builder().build(mock_context(noop_assets())).unwrap();
    let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
    app.listen("managed-page-guard-failed", move |event| {
        events
            .send(serde_json::from_str::<serde_json::Value>(event.payload()).unwrap())
            .unwrap();
    });
    let browsers = crate::browser::BrowserSessionManager::default();
    browsers.insert_test_session(23, None);
    let status = crate::managed_cdp::LoginGuardStatusView::default();
    let context = ManagedLogoutContext {
        browsers: browsers.clone(),
        auth,
        app: app.handle().clone(),
        browser_id: 23,
        platform_id: 7,
        user_id,
        auth_generation,
        device_id: None,
        identity: crate::managed_cdp::ManagedSessionIdentity {
            session_id: "11".into(),
            managed_account_id: 9,
            credential_version: 3,
        },
        status: status.clone(),
    };
    let (signals, signal_rx) = tokio::sync::mpsc::unbounded_channel();
    let (exit, exited) = tokio::sync::oneshot::channel();
    let watch = tokio::spawn(run_managed_watch(context, signal_rx, exited));
    for reason in [
        "guard_install_failed",
        "guard_install_timeout",
        "monitor_install_failed",
        "monitor_install_timeout",
        "page_resume_failed",
        "page_resume_timeout",
    ] {
        signals
            .send(crate::cdp::ManagedSignal::PageClosed { reason })
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), received.recv())
                .await
                .unwrap(),
            Some(json!({
                "platformId": 7,
                "managedAccountId": 9,
                "credentialVersion": 3,
                "browserId": 23,
                "reason": reason,
                "pageClosed": true,
            }))
        );
        assert!(
            !watch.is_finished(),
            "a page closure must not stop the browser watch"
        );
        assert_eq!(
            status.current(),
            crate::managed_cdp::LoginGuardStatus::NotExpired
        );
        assert!(
            browsers.has_sessions_pending_cleanup(),
            "the browser must not be retired"
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(40), api.accept())
            .await
            .is_err(),
        "a page closure must not report expiry or fetch config"
    );
    exit.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), watch)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn managed_page_closed_ignores_stale_user_or_auth_generation_without_stopping_watch() {
    use std::time::Duration;

    use tauri::{
        test::{mock_builder, mock_context, noop_assets},
        Listener,
    };

    for (stale_user, stale_generation) in [(true, false), (false, true)] {
        let api = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let auth = crate::auth::tests::authenticated_state(&format!(
            "http://{}",
            api.local_addr().unwrap()
        ));
        let original_identity = auth.current_identity().unwrap();
        let (user_id, _, auth_generation) = original_identity.clone();
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let (events, mut received) = tokio::sync::mpsc::unbounded_channel();
        app.listen("managed-page-guard-failed", move |event| {
            events.send(event.payload().to_owned()).unwrap();
        });
        let browsers = crate::browser::BrowserSessionManager::default();
        browsers.insert_test_session(23, None);
        let status = crate::managed_cdp::LoginGuardStatusView::default();
        let context = ManagedLogoutContext {
            browsers: browsers.clone(),
            auth: auth.clone(),
            app: app.handle().clone(),
            browser_id: 23,
            platform_id: 7,
            user_id: if stale_user { user_id + 1 } else { user_id },
            auth_generation: if stale_generation {
                auth_generation + 1
            } else {
                auth_generation
            },
            device_id: None,
            identity: crate::managed_cdp::ManagedSessionIdentity {
                session_id: "11".into(),
                managed_account_id: 9,
                credential_version: 3,
            },
            status: status.clone(),
        };
        let (signals, signal_rx) = tokio::sync::mpsc::unbounded_channel();
        let (exit, exited) = tokio::sync::oneshot::channel();
        let watch = tokio::spawn(run_managed_watch(context, signal_rx, exited));
        signals
            .send(crate::cdp::ManagedSignal::PageClosed {
                reason: "guard_install_failed",
            })
            .unwrap();

        assert!(
            tokio::time::timeout(Duration::from_millis(40), received.recv())
                .await
                .is_err(),
            "a stale user or authentication generation must not receive the page-failure toast"
        );
        assert!(
            !watch.is_finished(),
            "stale page notifications are still nonterminal"
        );
        assert_eq!(
            auth.current_identity().unwrap(),
            original_identity,
            "the auth gate must be read-only"
        );
        assert_eq!(
            status.current(),
            crate::managed_cdp::LoginGuardStatus::NotExpired
        );
        assert!(browsers.has_sessions_pending_cleanup());
        assert!(
            tokio::time::timeout(Duration::from_millis(40), api.accept())
                .await
                .is_err(),
            "a stale page closure must not report expiry or fetch config"
        );
        exit.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), watch)
            .await
            .unwrap()
            .unwrap();
    }
}

#[test]
fn profile_check_failure_is_distinct_from_a_busy_environment() {
    let unknown = browser_command_error(BrowserError::from(profile::ProfileCheckError::Unknown));
    assert_eq!(unknown.code, "profile_check_failed");
    assert!(unknown.message.contains("无法确认"));
    let busy = browser_command_error(BrowserError::from(profile::ProfileCheckError::Busy));
    assert_eq!(busy.code, "profile_busy");
}

const TEST_API_BASE: &str = "https://api.example.test/vestus";

fn desktop_wire() -> DesktopConfigWire {
    serde_json::from_value(serde_json::json!({
        "proxy": {
            "id": 9,
            "name": "全局代理",
            "host": "203.0.113.8",
            "port": 8080,
            "username": "assigned-user",
            "password": "server-only-secret",
            "bypassHosts": ["LF3-AD-Platform.byteadverts.com", ".byteadverts.com"]
        },
        "platforms": [
            {"id": 2, "name": "平台二", "url": "https://two.example.test", "sortOrder": 20},
            {"id": 1, "name": "平台一", "url": "https://one.example.test", "sortOrder": 10,
             "managedAccounts": [
                {"id": 9, "name": "账号 A", "status": "active"},
                {"id": 10, "name": "账号 B", "status": "active"}
             ]}
        ],
        "profileKey": "profile-user-7",
        "lease": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }))
    .unwrap()
}

#[test]
fn command_error_keeps_code() {
    let err = CommandError::new("代理账号或密码错误", "auth_failed");
    let json = serde_json::to_string(&err).unwrap();
    assert!(json.contains("auth_failed"));
}

#[test]
fn rejects_bootstrap_response_for_a_different_managed_account() {
    let error = validate_bootstrap_account_id(Some(9), 10).unwrap_err();
    assert_eq!(error.code, "managed_session_invalid");
    assert!(error.message.contains("所选账号"));
    assert_eq!(validate_bootstrap_account_id(Some(9), 9).unwrap(), 9);
}

#[test]
fn validates_and_sorts_server_platform_allowlist() {
    let validated = validate_desktop_config(desktop_wire(), TEST_API_BASE).unwrap();
    assert_eq!(validated.platforms[0].id, 1);
    assert_eq!(validated.platforms[1].id, 2);
    assert_eq!(validated.platforms[0].managed_accounts.len(), 2);
    assert_eq!(validated.platforms[0].managed_accounts[1].name, "账号 B");
    let config = validated.proxy.unwrap();
    assert_eq!(config.password, "server-only-secret");
    assert_eq!(
        config.probe_url,
        "https://api.example.test/vestus/api/network/ip"
    );
    // 直连域名同样只认服务端下发，并在这里完成归一化
    assert_eq!(
        config.direct_hosts.entries(),
        vec![
            "lf3-ad-platform.byteadverts.com".to_string(),
            "*.byteadverts.com".to_string()
        ]
    );
}

#[test]
fn rejects_profile_keys_reserved_for_managed_namespaces() {
    let mut wire = desktop_wire();
    wire.profile_key = "profile-user-7::managed-account-9::credential-version-1".into();
    let error = match validate_desktop_config(wire, TEST_API_BASE) {
        Ok(_) => panic!("reserved managed profile marker should be rejected"),
        Err(error) => error,
    };
    assert_eq!(error.code, "invalid_desktop_config");
}

#[test]
fn platform_only_desktop_config_starts_lease_watchdog() {
    let mut wire = desktop_wire();
    wire.proxy = None;

    let validated = validate_desktop_config(wire, TEST_API_BASE).unwrap();

    assert!(!validated.platforms.is_empty());
    assert!(should_spawn_session_watchdog(&validated));
}

#[test]
fn platform_views_expose_only_api_scoped_uploaded_icons() {
    let mut wire = desktop_wire();
    wire.platforms[0].icon_url =
        Some("/uploads/2026/08/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png".into());
    wire.platforms[1].icon_url = Some("data:image/png;base64,AAAA".into());

    let validated = validate_desktop_config(wire, TEST_API_BASE).unwrap();
    let views = platform_views(&validated.platforms);

    assert_eq!(views[0].id, 1);
    assert_eq!(views[0].icon_url, None);
    assert_eq!(views[1].id, 2);
    assert_eq!(
        views[1].icon_url.as_deref(),
        Some(
            "https://api.example.test/vestus/uploads/2026/08/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png"
        )
    );
}

#[test]
fn rejects_unsafe_bypass_hosts_from_server() {
    for bad in ["127.0.0.1", "localhost", "http://a.com", "a.com:8080"] {
        let mut wire = desktop_wire();
        wire.proxy.as_mut().unwrap().bypass_hosts = vec![bad.into()];
        assert_eq!(
            validate_desktop_config(wire, TEST_API_BASE)
                .err()
                .unwrap()
                .code,
            "invalid_desktop_config",
            "应当拒绝直连域名：{bad}"
        );
    }
}

#[test]
fn sync_report_exposes_egress_ip_without_proxy_credentials() {
    let validated = validate_desktop_config(desktop_wire(), TEST_API_BASE).unwrap();
    let report = DesktopConfigSyncReport {
        proxy_assigned: validated.proxy.is_some(),
        proxy_ip: Some("203.0.113.27".to_string()),
        platforms: platform_views(&validated.platforms),
        direct_hosts: vec!["lf3-ad-platform.byteadverts.com".to_string()],
    };
    let value = serde_json::to_value(report).unwrap();
    let object = value.as_object().unwrap();
    assert_eq!(object.len(), 4);
    assert_eq!(value["proxy_assigned"], true);
    assert_eq!(value["proxy_ip"], "203.0.113.27");
    assert_eq!(value["platforms"][0].as_object().unwrap().len(), 4);
    assert!(value["platforms"][0]["managed_accounts"].is_array());
    assert!(value["platforms"][0]["icon_url"].is_null());
    assert_eq!(value["direct_hosts"][0], "lf3-ad-platform.byteadverts.com");
    let json = serde_json::to_string(&value).unwrap();
    assert!(!json.contains("server-only-secret"));
    assert!(!json.contains("password"));
    assert!(!json.contains("one.example.test"));
}

#[test]
fn rejects_duplicate_platform_ids_and_unsafe_urls() {
    let mut duplicate = desktop_wire();
    duplicate.platforms[1].id = duplicate.platforms[0].id;
    assert_eq!(
        validate_desktop_config(duplicate, TEST_API_BASE)
            .err()
            .unwrap()
            .code,
        "invalid_desktop_config"
    );

    let mut unsafe_url = desktop_wire();
    unsafe_url.platforms[0].url = "file:///tmp/secret".into();
    assert_eq!(
        validate_desktop_config(unsafe_url, TEST_API_BASE)
            .err()
            .unwrap()
            .code,
        "invalid_desktop_config"
    );

    let mut invalid_lease = desktop_wire();
    invalid_lease.lease = "not-a-lease".into();
    assert_eq!(
        validate_desktop_config(invalid_lease, TEST_API_BASE)
            .err()
            .unwrap()
            .code,
        "invalid_desktop_config"
    );

    let mut invalid_account = desktop_wire();
    invalid_account.platforms[1].managed_accounts[0].id = 0;
    assert_eq!(
        validate_desktop_config(invalid_account, TEST_API_BASE)
            .err()
            .unwrap()
            .code,
        "invalid_desktop_config"
    );
}

/// 托管启动独有的扩展准备失败必须翻成专属错误码，前端据此提示重新打开平台；
/// 其余浏览器启动失败保持通用错误码不变。
#[test]
fn managed_launch_maps_extension_preparation_failure_to_guard_unavailable() {
    let error =
        managed_launch_command_error(BrowserError::LoginGuardExtension("fixture blocked".into()));
    assert_eq!(error.code, "managed_guard_unavailable");
    assert_eq!(error.message, "托管登录防护扩展准备失败，请重试");

    let unrelated = managed_launch_command_error(BrowserError::ProfileBusy);
    assert_eq!(unrelated.code, "profile_busy");
    assert_eq!(unrelated.message, BrowserError::ProfileBusy.to_string());
}
