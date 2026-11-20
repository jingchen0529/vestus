//! 托管会话的后台 watch 与恢复等待。

use std::time::Duration;

use tauri::{AppHandle, Emitter, Runtime};

use crate::auth::DesktopAuthState;
use crate::browser::{BrowserSessionManager, CloseReason};
use crate::managed_cdp;
use crate::rt;

use super::*;

/// 服务端自动登录恢复的等待节奏：3 秒轮询一次，最多等 3 分钟。
pub(crate) const RECOVERY_POLL_INTERVAL: Duration = Duration::from_secs(3);
pub(crate) const RECOVERY_WAIT_BUDGET: Duration = Duration::from_secs(180);
pub(crate) const RECOVERY_MAX_NETWORK_ERRORS: u8 = 5;
/// Poll the server config until the reported managed account is re-logged-in.
///
/// 只读拉取配置（不关闭浏览器、不重建代理），凭据仍只留在 Rust 内存。恢复
/// 成功或确定失败后发一次 `managed-session-recovered`；前端据此自动重新打开。
pub(crate) async fn wait_managed_recovery<R: Runtime>(
    auth: DesktopAuthState,
    app: AppHandle<R>,
    user_id: i64,
    auth_generation: u64,
    platform_id: i64,
    identity: managed_cdp::ManagedSessionIdentity,
) {
    let deadline = tokio::time::Instant::now() + RECOVERY_WAIT_BUDGET;
    let mut network_errors = 0u8;
    loop {
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(RECOVERY_POLL_INTERVAL).await;
        // 登录用户已变化（退出/换号）：旧 watcher 不得再发出恢复通知。
        if !auth
            .current_identity()
            .is_ok_and(|(current_user, _, generation)| {
                current_user == user_id && generation == auth_generation
            })
        {
            return;
        }
        let wire = match auth.fetch_desktop_config::<DesktopConfigWire>().await {
            Ok(wire) => {
                network_errors = 0;
                wire
            }
            Err(error) if matches!(error.code.as_str(), "network" | "server") => {
                network_errors += 1;
                if network_errors >= RECOVERY_MAX_NETWORK_ERRORS {
                    break;
                }
                continue;
            }
            Err(_) => return,
        };
        let Some(account) = wire
            .platforms
            .iter()
            .find(|platform| platform.id == platform_id)
            .and_then(|platform| {
                platform
                    .managed_accounts
                    .iter()
                    .find(|account| account.id as u64 == identity.managed_account_id)
            })
        else {
            return;
        };
        if account.session_status == "valid"
            && account.credential_version > identity.credential_version
        {
            let _ = app.emit(
                "managed-session-recovered",
                serde_json::json!({
                    "platformId": platform_id,
                    "managedAccountId": identity.managed_account_id,
                    "credentialVersion": account.credential_version,
                    "recovered": true,
                }),
            );
            return;
        }
        if account.recovery_status == "failed" {
            let _ = app.emit(
                "managed-session-recovered",
                serde_json::json!({
                    "platformId": platform_id,
                    "managedAccountId": identity.managed_account_id,
                    "credentialVersion": identity.credential_version,
                    "recovered": false,
                    "detail": account.last_error.clone().unwrap_or_else(|| "自动登录失败".into()),
                }),
            );
            return;
        }
    }
    let _ = app.emit(
        "managed-session-recovered",
        serde_json::json!({
            "platformId": platform_id,
            "managedAccountId": identity.managed_account_id,
            "credentialVersion": identity.credential_version,
            "recovered": false,
            "detail": "等待自动恢复超时，请稍后手动重新打开",
        }),
    );
}

pub(crate) async fn kill_managed_browser(
    browsers: BrowserSessionManager,
    browser_id: u64,
) -> CmdResult<()> {
    kill_managed_browser_with_reason(
        browsers,
        browser_id,
        CloseReason::ManagedInitializationFailed,
    )
    .await
}

async fn kill_managed_browser_with_reason(
    browsers: BrowserSessionManager,
    browser_id: u64,
    reason: CloseReason,
) -> CmdResult<()> {
    rt::runtime()
        .spawn_blocking(move || browsers.kill_browser_with_reason(browser_id, reason))
        .await
        .map_err(|error| CommandError::new(format!("浏览器关闭任务失败：{error}"), "internal"))?
        .map_err(browser_command_error)?;
    Ok(())
}

pub(crate) struct ManagedLogoutContext<R: Runtime> {
    pub(crate) browsers: BrowserSessionManager,
    pub(crate) auth: DesktopAuthState,
    pub(crate) app: AppHandle<R>,
    pub(crate) browser_id: u64,
    pub(crate) platform_id: i64,
    pub(crate) user_id: i64,
    pub(crate) auth_generation: u64,
    pub(crate) device_id: Option<String>,
    pub(crate) identity: managed_cdp::ManagedSessionIdentity,
    /// watcher 强杀前只读复核的阶段；只有监控器判定 ExpiryValid 才动凭据。
    pub(crate) status: managed_cdp::LoginGuardStatusView,
}

/// 等候经过复核的信号；旧 Expired 在健康监控下被撤销时继续等候，不关闭页面。
pub(crate) async fn wait_managed_signal(
    status: &managed_cdp::LoginGuardStatusView,
    signals: &mut tokio::sync::mpsc::UnboundedReceiver<crate::cdp::ManagedSignal>,
    exited: &mut tokio::sync::oneshot::Receiver<()>,
) -> Option<crate::cdp::ManagedSignal> {
    loop {
        let signal = tokio::select! {
            biased;
            _ = &mut *exited => return None,
            signal = signals.recv() => signal,
        };
        if !matches!(signal, Some(crate::cdp::ManagedSignal::Expired)) {
            return Some(crate::cdp::ManagedSignal::ConnectionLost);
        }
        // 留出一次事件处理窗口，让排队的加载开始、跳离或断连撤销旧判定。
        tokio::select! {
            biased;
            _ = &mut *exited => return None,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
        match status.current() {
            managed_cdp::LoginGuardStatus::ExpiryValid => return signal,
            managed_cdp::LoginGuardStatus::MonitorGone => {
                return Some(crate::cdp::ManagedSignal::ConnectionLost)
            }
            managed_cdp::LoginGuardStatus::NotExpired => {}
        }
    }
}

/// 有效失效才关闭并上报；断连只关闭本地浏览器，不修改凭据。
pub(crate) async fn run_managed_watch<R: Runtime>(
    context: ManagedLogoutContext<R>,
    mut signals: tokio::sync::mpsc::UnboundedReceiver<crate::cdp::ManagedSignal>,
    mut exited: tokio::sync::oneshot::Receiver<()>,
) {
    let closed = loop {
        let Some(detected) = wait_managed_signal(&context.status, &mut signals, &mut exited).await
        else {
            return;
        };
        if matches!(detected, crate::cdp::ManagedSignal::ConnectionLost) {
            // Chromium 可能在进程退出回调之前先断开调试连接。这段宽限只为
            // 生命周期收尾，绝不是给仍在运行的未防护进程续命；还活着就强关。
            if tokio::time::timeout(Duration::from_millis(200), &mut exited)
                .await
                .is_ok()
            {
                return;
            }
            let browsers = context.browsers.clone();
            let browser_id = context.browser_id;
            let running = rt::runtime()
                .spawn_blocking(move || browsers.is_running(browser_id))
                .await
                .unwrap_or(true);
            if !running {
                return;
            }
            let closed = kill_managed_browser_with_reason(
                context.browsers.clone(),
                context.browser_id,
                CloseReason::MonitorDisconnected,
            )
            .await
            .is_ok();
            if context
                .auth
                .current_identity()
                .is_ok_and(|(user_id, _, generation)| {
                    user_id == context.user_id && generation == context.auth_generation
                })
            {
                let _ = context.app.emit(
                    "managed-session-guard-failed",
                    serde_json::json!({
                        "platformId": context.platform_id,
                        "managedAccountId": context.identity.managed_account_id,
                        "credentialVersion": context.identity.credential_version,
                        "browserId": context.browser_id,
                        "reason": "monitor_disconnected",
                        "browserClosed": closed,
                    }),
                );
            }
            return;
        }
        let browsers = context.browsers.clone();
        let browser_id = context.browser_id;
        let status = context.status.clone();
        let outcome = rt::runtime()
            .spawn_blocking(move || {
                if !status.is_expiry_valid() {
                    return None;
                }
                Some(browsers.kill_browser_with_reason(browser_id, CloseReason::ManagedLogout))
            })
            .await;
        break match outcome {
            Ok(None) => continue,
            Ok(Some(Ok(closed))) => closed,
            Ok(Some(Err(error))) => {
                eprintln!("托管会话强杀或清理失败：{error}");
                false
            }
            Err(error) => {
                eprintln!("托管会话关闭任务失败：{error}");
                false
            }
        };
    };
    for attempt in 0..3 {
        match context
            .auth
            .report_managed_session_expired(
                context.user_id,
                context.auth_generation,
                context.platform_id,
                &context.identity,
                context.device_id.as_deref(),
            )
            .await
        {
            Ok(receipt) => {
                // Emit only after the write/ignore receipt, so React cannot
                // refresh the old valid state before the report commits.
                if context
                    .auth
                    .current_identity()
                    .is_ok_and(|(user_id, _, generation)| {
                        user_id == context.user_id && generation == context.auth_generation
                    })
                {
                    let _ = context.app.emit(
                        "managed-session-expired",
                        serde_json::json!({
                            "platformId": context.platform_id,
                            "managedAccountId": context.identity.managed_account_id,
                            "credentialVersion": context.identity.credential_version,
                            "sessionStatus": receipt.session_status,
                            "applied": receipt.applied,
                            "reported": true,
                            "browserClosed": closed,
                            "autoRelogin": receipt.auto_relogin,
                        }),
                    );
                }
                // 服务端已受理失效并对该账号开启自动重登：后台等待恢复完成后
                // 通知前端重新打开托管浏览器。仅此一次上报的 watcher 会等待，
                // 用户退出登录、配置更换都会让 current_identity 校验终止等待。
                if receipt.applied
                    && receipt.auto_relogin
                    && receipt.session_status == "expired"
                    && matches!(
                        receipt.recovery_status.as_str(),
                        "pending" | "running" | "retry_wait" | ""
                    )
                {
                    wait_managed_recovery(
                        context.auth.clone(),
                        context.app.clone(),
                        context.user_id,
                        context.auth_generation,
                        context.platform_id,
                        context.identity.clone(),
                    )
                    .await;
                }
                return;
            }
            Err(error) if matches!(error.code.as_str(), "network" | "server") && attempt < 2 => {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(error) => {
                eprintln!("托管会话失效上报未完成：{}", error.code);
                if context
                    .auth
                    .current_identity()
                    .is_ok_and(|(user_id, _, generation)| {
                        user_id == context.user_id && generation == context.auth_generation
                    })
                {
                    let _ = context.app.emit(
                        "managed-session-expired",
                        serde_json::json!({
                            "platformId": context.platform_id,
                            "managedAccountId": context.identity.managed_account_id,
                            "credentialVersion": context.identity.credential_version,
                            "sessionStatus": "unknown",
                            "applied": false,
                            "reported": false,
                            "browserClosed": closed,
                        }),
                    );
                }
                return;
            }
        }
    }
}
