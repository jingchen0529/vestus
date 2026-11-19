use super::*;

use crate::{auth::DesktopAuthState, browser::BrowserSessionManager, state::AppState};

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{
    test::{mock_builder, mock_context, noop_assets, MockRuntime},
    Manager,
};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

struct ConfigServer {
    base: String,
    response: Arc<Mutex<(u16, Value)>>,
    task: tokio::task::JoinHandle<()>,
}

impl ConfigServer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let response = Arc::new(Mutex::new((
            200,
            json!({
                "proxy": null,
                "platforms": [{"id": 1, "name": "测试平台", "url": "https://platform.example.test/",
                    "managedAccounts": [{"id": 9, "name": "测试账号", "status": "active", "credentialVersion": 1}]}],
                "profileKey": "profile-user-7",
                "lease": "a".repeat(64),
            }),
        )));
        let current = response.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (head, _) = crate::httpio::read_head(&mut stream).await.unwrap();
                let request = crate::httpio::parse_request_head(&head).unwrap();
                let (status, mut data) = current.lock().unwrap().clone();
                if request.target.ends_with("/lease") {
                    data = json!({"lease": data["lease"]});
                }
                let body =
                    json!({"code": if status == 200 { 0 } else { 1 }, "data": data}).to_string();
                let reply = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
            }
        });
        Self {
            base,
            response,
            task,
        }
    }
}

impl Drop for ConfigServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn app(server: &ConfigServer) -> tauri::App<MockRuntime> {
    mock_builder()
        .manage(AppState::default())
        .manage(crate::auth::tests::authenticated_state(&server.base))
        .manage(BrowserSessionManager::default())
        .manage(crate::commands::NetworkMonitor::default())
        .build(mock_context(noop_assets()))
        .unwrap()
}

async fn sync(app: &tauri::App<MockRuntime>) -> CmdResult<DesktopConfigSyncReport> {
    sync_desktop_config(
        app.handle().clone(),
        app.state::<AppState>(),
        app.state::<DesktopAuthState>(),
        app.state::<BrowserSessionManager>(),
        app.state::<crate::commands::NetworkMonitor>(),
    )
    .await
}

#[tokio::test]
async fn repeated_sync_keeps_open_direct_browser_and_refreshes_metadata() {
    let server = ConfigServer::start().await;
    let app = app(&server);
    sync(&app).await.unwrap();
    let state = app.state::<AppState>();
    let browser_id = state.mark_browser_opened(true).unwrap();
    let before = state.snapshot();
    server.response.lock().unwrap().1["platforms"][0]["managedAccounts"][0]["name"] =
        json!("刷新后的账号名称");

    let report = sync(&app).await.unwrap();

    assert_eq!(
        report.platforms[0].managed_accounts[0].name,
        "刷新后的账号名称"
    );
    assert!(
        state.snapshot().browser_open,
        "refresh must not retire the open browser session"
    );
    assert_eq!(state.snapshot().phase, before.phase);
    state.mark_browser_closed_for(browser_id);
    assert!(!state.snapshot().browser_open);
    state.shutdown();
}

#[tokio::test]
async fn repeated_proxy_sync_preserves_port_and_does_not_probe_again() {
    let server = ConfigServer::start().await;
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = proxy.local_addr().unwrap();
    server.response.lock().unwrap().1["proxy"] = json!({
        "id": 1, "host": "127.0.0.1", "port": address.port(),
        "username": "test-proxy", "password": "test-only-password", "bypassHosts": [],
    });
    let proxy_task = tokio::spawn(async move {
        let (mut preflight, _) = proxy.accept().await.unwrap();
        let _ = crate::httpio::read_head(&mut preflight).await.unwrap();
        preflight
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        let (mut request, _) = proxy.accept().await.unwrap();
        let _ = crate::httpio::read_head(&mut request).await.unwrap();
        request
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n203.0.113.7",
            )
            .await
            .unwrap();
    });
    let app = app(&server);
    let initial = sync(&app).await.unwrap();
    proxy_task.await.unwrap();
    let state = app.state::<AppState>();
    let (_, key, generation) = app.state::<DesktopAuthState>().current_identity().unwrap();
    let port = state
        .resolve_browser_launch(7, generation, key.as_deref(), 1, None, false)
        .unwrap()
        .port;
    state.mark_browser_opened(false).unwrap();

    // The probe listener has gone away. A needless second probe would fail.
    let refreshed = sync(&app).await.unwrap();

    assert_eq!(initial.proxy_ip.as_deref(), Some("203.0.113.7"));
    assert_eq!(refreshed.proxy_ip, initial.proxy_ip);
    assert!(state.snapshot().browser_open);
    assert_eq!(
        state
            .resolve_browser_launch(7, generation, key.as_deref(), 1, None, false)
            .unwrap()
            .port,
        port
    );
    state.shutdown();
}

#[tokio::test]
async fn failed_proxy_initialization_is_not_cached_as_applied() {
    let server = ConfigServer::start().await;
    let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = proxy.local_addr().unwrap();
    server.response.lock().unwrap().1["proxy"] = json!({
        "id": 1, "host": "127.0.0.1", "port": address.port(),
        "username": "test-proxy", "password": "test-only-password", "bypassHosts": [],
    });
    let proxy_task = tokio::spawn(async move {
        let (mut denied, _) = proxy.accept().await.unwrap();
        let _ = crate::httpio::read_head(&mut denied).await.unwrap();
        denied
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        let (mut preflight, _) = proxy.accept().await.unwrap();
        let _ = crate::httpio::read_head(&mut preflight).await.unwrap();
        preflight
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .unwrap();
        let (mut request, _) = proxy.accept().await.unwrap();
        let _ = crate::httpio::read_head(&mut request).await.unwrap();
        request
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n203.0.113.7",
            )
            .await
            .unwrap();
    });
    let app = app(&server);
    assert_eq!(sync(&app).await.unwrap_err().code, "auth_failed");

    let retried = sync(&app).await.unwrap();

    assert_eq!(retried.proxy_ip.as_deref(), Some("203.0.113.7"));
    assert!(app.state::<AppState>().can_open_browser());
    proxy_task.await.unwrap();
    app.state::<AppState>().shutdown();
}

#[tokio::test]
async fn refresh_outage_preserves_session_then_recovers() {
    let server = ConfigServer::start().await;
    let app = app(&server);
    sync(&app).await.unwrap();
    let state = app.state::<AppState>();
    state.mark_browser_opened(true).unwrap();
    let generation = app
        .state::<DesktopAuthState>()
        .current_identity()
        .unwrap()
        .2;
    let revision = state.desktop_assignment_revision(7, generation).unwrap();
    server.response.lock().unwrap().0 = 503;

    for _ in 0..4 {
        assert_eq!(sync(&app).await.unwrap_err().code, "server");
        assert!(state.snapshot().browser_open);
        assert_eq!(
            state.desktop_assignment_revision(7, generation),
            Some(revision)
        );
    }
    server.response.lock().unwrap().0 = 200;
    sync(&app).await.unwrap();
    assert!(state.snapshot().browser_open);
    assert_eq!(
        state.desktop_assignment_revision(7, generation),
        Some(revision)
    );
    state.shutdown();
}

#[tokio::test]
async fn changed_lease_and_effective_account_expiry_still_retire_old_sessions() {
    for expiry_without_new_lease in [false, true] {
        let server = ConfigServer::start().await;
        let app = app(&server);
        sync(&app).await.unwrap();
        let state = app.state::<AppState>();
        state.mark_browser_opened(true).unwrap();
        if expiry_without_new_lease {
            server.response.lock().unwrap().1["platforms"][0]["managedAccounts"][0]["status"] =
                json!("expired");
        } else {
            server.response.lock().unwrap().1["lease"] = json!("b".repeat(64));
        }

        let report = sync(&app).await.unwrap();

        assert!(!state.snapshot().browser_open);
        assert!(app.state::<DesktopAuthState>().is_authenticated());
        if expiry_without_new_lease {
            assert_eq!(report.platforms[0].managed_accounts[0].status, "expired");
        }
        state.shutdown();
    }
}

#[tokio::test]
async fn concurrent_refreshes_keep_the_same_assignment() {
    let server = ConfigServer::start().await;
    let app = app(&server);
    sync(&app).await.unwrap();
    let state = app.state::<AppState>();
    state.mark_browser_opened(true).unwrap();
    let generation = app
        .state::<DesktopAuthState>()
        .current_identity()
        .unwrap()
        .2;
    let revision = state.desktop_assignment_revision(7, generation).unwrap();

    let (first, second) = tokio::join!(sync(&app), sync(&app));

    first.unwrap();
    second.unwrap();
    assert!(state.snapshot().browser_open);
    assert_eq!(
        state.desktop_assignment_revision(7, generation),
        Some(revision)
    );
    state.shutdown();
}

#[tokio::test]
async fn lease_watchdog_survives_repeated_outages_without_retiring_browsers() {
    let server = ConfigServer::start().await;
    let app = app(&server);
    sync(&app).await.unwrap();
    let state = app.state::<AppState>();
    let auth = app.state::<DesktopAuthState>();
    let network = app.state::<crate::commands::NetworkMonitor>();
    let generation = auth.current_identity().unwrap().2;
    let revision = state.desktop_assignment_revision(7, generation).unwrap();
    state.mark_browser_opened(true).unwrap();
    server.response.lock().unwrap().0 = 503;

    for _ in 0..4 {
        assert!(
            check_desktop_session(
                app.handle(),
                &state,
                &auth,
                7,
                generation,
                revision,
                &"a".repeat(64),
                &network,
            )
            .await
        );
        assert!(state.snapshot().browser_open);
        assert!(auth.is_authenticated());
        assert_eq!(
            state.snapshot().error_code.as_deref(),
            Some("desktop_service_unavailable")
        );
    }
    server.response.lock().unwrap().0 = 200;
    assert!(
        check_desktop_session(
            app.handle(),
            &state,
            &auth,
            7,
            generation,
            revision,
            &"a".repeat(64),
            &network,
        )
        .await
    );
    assert!(state.snapshot().browser_open);
    assert_eq!(state.snapshot().error_code, None);
    state.shutdown();
}

#[tokio::test]
async fn watchdog_still_closes_revoked_sessions_and_ignores_stale_revisions() {
    let server = ConfigServer::start().await;
    let app = app(&server);
    sync(&app).await.unwrap();
    let state = app.state::<AppState>();
    let auth = app.state::<DesktopAuthState>();
    let network = app.state::<crate::commands::NetworkMonitor>();
    let generation = auth.current_identity().unwrap().2;
    let original_revision = state.desktop_assignment_revision(7, generation).unwrap();
    state.mark_browser_opened(true).unwrap();
    server.response.lock().unwrap().1["lease"] = json!("b".repeat(64));
    assert!(
        !check_desktop_session(
            app.handle(),
            &state,
            &auth,
            7,
            generation,
            original_revision,
            &"a".repeat(64),
            &network,
        )
        .await
    );
    assert!(!state.snapshot().browser_open);
    assert_eq!(
        state.snapshot().error_code.as_deref(),
        Some("desktop_config_changed")
    );

    sync(&app).await.unwrap();
    let revision = state.desktop_assignment_revision(7, generation).unwrap();
    assert_ne!(revision, original_revision);
    state.mark_browser_opened(true).unwrap();
    assert!(
        !check_desktop_session(
            app.handle(),
            &state,
            &auth,
            7,
            generation,
            original_revision,
            &"a".repeat(64),
            &network,
        )
        .await
    );
    assert!(state.snapshot().browser_open);

    server.response.lock().unwrap().0 = 401;
    assert!(
        !check_desktop_session(
            app.handle(),
            &state,
            &auth,
            7,
            generation,
            revision,
            &"b".repeat(64),
            &network,
        )
        .await
    );
    assert!(!state.snapshot().browser_open);
    assert_eq!(
        state.snapshot().error_code.as_deref(),
        Some("unauthenticated")
    );
    state.shutdown();
}

#[tokio::test]
async fn malformed_config_fails_closed_without_claiming_logout() {
    let server = ConfigServer::start().await;
    let app = app(&server);
    sync(&app).await.unwrap();
    let state = app.state::<AppState>();
    state.mark_browser_opened(true).unwrap();
    server.response.lock().unwrap().1["platforms"][0]["url"] = json!("file:///invalid");

    assert_eq!(sync(&app).await.unwrap_err().code, "invalid_desktop_config");

    assert!(!state.snapshot().browser_open);
    assert!(app.state::<DesktopAuthState>().is_authenticated());
    assert_eq!(
        state.snapshot().error_code.as_deref(),
        Some("desktop_config_invalid")
    );
    state.shutdown();
}

#[cfg(unix)]
#[tokio::test]
async fn refresh_preserves_owned_process_but_revocation_and_exit_end_it() {
    use std::os::unix::fs::PermissionsExt;
    let server = ConfigServer::start().await;
    let app = app(&server);
    sync(&app).await.unwrap();
    let state = app.state::<AppState>();
    let browsers = app.state::<BrowserSessionManager>();
    let mut nonce = [0u8; 8];
    getrandom::getrandom(&mut nonce).unwrap();
    let root = std::env::temp_dir().join(format!(
        "vestus-config-refresh-{}",
        u64::from_le_bytes(nonce)
    ));
    std::fs::create_dir(&root).unwrap();
    let executable = root.join("owned-browser");
    std::fs::write(&executable, "#!/bin/sh\nexec sleep 60\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let profile = root.join("profile");
    let browser_id = state.mark_browser_opened(true).unwrap();
    let on_exit = state.inner().clone();
    browsers
        .launch_test_process(browser_id, &executable, profile.clone(), move || {
            on_exit.mark_browser_closed_for(browser_id)
        })
        .unwrap();

    sync(&app).await.unwrap();

    assert!(browsers.is_running(browser_id));
    assert_eq!(browsers.running_browser(&profile), Some(browser_id));
    assert!(state.snapshot().browser_open);
    server.response.lock().unwrap().1["lease"] = json!("b".repeat(64));
    sync(&app).await.unwrap();
    assert!(!browsers.is_running(browser_id));
    assert_eq!(browsers.running_browser(&profile), None);

    let next_id = state.mark_browser_opened(true).unwrap();
    let on_exit = state.inner().clone();
    browsers
        .launch_test_process(next_id, &executable, profile.clone(), move || {
            on_exit.mark_browser_closed_for(next_id)
        })
        .unwrap();
    assert!(browsers.is_running(next_id));
    browsers.shutdown();
    state.shutdown();
    assert!(!browsers.is_running(next_id));
    assert!(
        profile.exists(),
        "ordinary persistent profiles are not deleted on exit"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn failed_managed_cleanup_blocks_reconfiguration_until_retry_succeeds() {
    use std::os::unix::fs::PermissionsExt;
    let server = ConfigServer::start().await;
    let app = app(&server);
    sync(&app).await.unwrap();
    let state = app.state::<AppState>();
    let browsers = app.state::<BrowserSessionManager>();
    let mut nonce = [0u8; 8];
    getrandom::getrandom(&mut nonce).unwrap();
    let root = std::env::temp_dir().join(format!(
        "vestus-refresh-cleanup-{}",
        u64::from_le_bytes(nonce)
    ));
    std::fs::create_dir(&root).unwrap();
    let executable = root.join("owned-browser");
    std::fs::write(&executable, "#!/bin/sh\nexec sleep 60\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    let profile = crate::profile::profile_dir(
        &root,
        &crate::profile::ProfileSpec {
            api_base: &server.base,
            profile_key: "profile-user-7::managed-account-9::credential-version-1",
            platform_id: 1,
            direct_mode: true,
        },
    );
    let browser_id = state.mark_browser_opened(true).unwrap();
    let on_exit = state.inner().clone();
    browsers
        .launch_test_process(browser_id, &executable, profile.clone(), move || {
            on_exit.mark_browser_closed_for(browser_id)
        })
        .unwrap();
    // An unknown on-disk owner must retain the managed directory and its lease.
    std::fs::write(profile.join("SingletonLock"), b"not-a-link").unwrap();
    server.response.lock().unwrap().1["lease"] = json!("b".repeat(64));

    let result = sync(&app).await;

    assert!(
        result.is_err(),
        "a failed close must not publish the next configuration"
    );
    assert_eq!(result.unwrap_err().code, "browser_cleanup_pending");
    assert_eq!(
        state.snapshot().error_code.as_deref(),
        Some("browser_cleanup_pending")
    );
    assert!(
        state.snapshot().browser_open,
        "do not report unconfirmed cleanup as closed"
    );
    assert!(state.mark_browser_opened(true).is_none());
    assert!(profile.exists());

    std::fs::remove_file(profile.join("SingletonLock")).unwrap();
    sync(&app).await.unwrap();
    assert!(!state.snapshot().browser_open);
    assert_eq!(state.snapshot().error_code, None);
    assert!(!profile.exists());
    state.shutdown();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn refresh_with_revoked_auth_closes_the_previous_session() {
    for status in [401, 403] {
        let server = ConfigServer::start().await;
        let app = app(&server);
        sync(&app).await.unwrap();
        let state = app.state::<AppState>();
        state.mark_browser_opened(true).unwrap();
        server.response.lock().unwrap().0 = status;

        let error = sync(&app).await.unwrap_err();

        assert_eq!(error.code, "unauthenticated");
        assert!(
            !state.snapshot().browser_open,
            "an explicit {status} must retire the prior authorization"
        );
        assert!(!app.state::<DesktopAuthState>().is_authenticated());
        state.shutdown();
    }
}
