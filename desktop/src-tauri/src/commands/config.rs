//! 桌面配置同步:下发校验、租约与看门狗、代理适配器启动。

use std::collections::HashSet;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use url::Url;

use crate::auth::{resolve_uploaded_asset_url, DesktopAuthState};
use crate::browser::BrowserSessionManager;
use crate::bypass::DirectHosts;
use crate::config::{self, DesktopPlatform, ManagedAccountView, ProxyForm, ValidatedConfig};
use crate::probe;
use crate::profile::{self};
use crate::rt;
use crate::state::{AppState, Session};
use crate::{adapter, upstream::UpstreamProxy};

use super::*;

/// 租约轮询节奏。管理员改配置/轮换托管凭据后，桌面端最迟这个间隔自动生效；
/// 同时也是令牌被吊销后收敛代理与浏览器的上限。查询本身只是一条带鉴权的快照
/// 读取，10s 对服务端的成本可以忽略。
pub(crate) const SESSION_WATCHDOG_INTERVAL: Duration = Duration::from_secs(10);
/// Exact response shape of the administrator-controlled desktop endpoint.
/// The proxy password is deserialized only into this private Rust type.
#[derive(serde::Deserialize)]
pub(crate) struct DesktopConfigWire {
    pub(crate) proxy: Option<DesktopProxyWire>,
    #[serde(default)]
    pub(crate) platforms: Vec<DesktopPlatformWire>,
    #[serde(rename = "profileKey", alias = "profile_key")]
    pub(crate) profile_key: String,
    pub(crate) lease: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct DesktopProxyWire {
    pub(crate) id: i64,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) password: String,
    /// 管理员下发的直连域名。缺省为空，即全部走代理。
    #[serde(rename = "bypassHosts", alias = "bypass_hosts", default)]
    pub(crate) bypass_hosts: Vec<String>,
}

#[derive(serde::Deserialize)]
pub(crate) struct DesktopPlatformWire {
    pub(crate) id: i64,
    pub(crate) name: String,
    pub(crate) url: String,
    #[serde(rename = "iconUrl", alias = "icon_url", default)]
    pub(crate) icon_url: Option<String>,
    #[serde(rename = "sortOrder", alias = "sort_order", default)]
    pub(crate) sort_order: i64,
    #[serde(rename = "managedAccounts", alias = "managed_accounts", default)]
    pub(crate) managed_accounts: Vec<ManagedAccountWire>,
}

#[derive(serde::Deserialize)]
pub(crate) struct ManagedAccountWire {
    pub(crate) id: i64,
    pub(crate) name: String,
    #[serde(default = "default_managed_account_status")]
    pub(crate) status: String,
    #[serde(rename = "credentialVersion", default)]
    pub(crate) credential_version: u64,
    #[serde(rename = "sessionStatus", default = "default_managed_session_status")]
    pub(crate) session_status: String,
    #[serde(rename = "autoRelogin", default)]
    pub(crate) auto_relogin: bool,
    #[serde(rename = "recoveryStatus", default = "default_managed_recovery_status")]
    pub(crate) recovery_status: String,
    #[serde(rename = "recoveryAttempts", default)]
    pub(crate) recovery_attempts: u32,
    #[serde(rename = "lastError", default)]
    pub(crate) last_error: Option<String>,
}

pub(crate) fn default_managed_session_status() -> String {
    "valid".into()
}

pub(crate) fn default_managed_recovery_status() -> String {
    "idle".into()
}

pub(crate) fn default_managed_account_status() -> String {
    "active".into()
}

/// The platform button is the only administrator-controlled object exposed to
/// JavaScript. Its target URL remains in Rust's launch allowlist.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DesktopPlatformView {
    pub id: i64,
    pub name: String,
    pub icon_url: Option<String>,
    pub managed_accounts: Vec<DesktopManagedAccountView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DesktopManagedAccountView {
    pub id: i64,
    pub name: String,
    pub status: String,
    pub credential_version: u64,
    pub session_status: String,
    pub auto_relogin: bool,
    pub recovery_status: String,
    pub recovery_attempts: u32,
    pub last_error: Option<String>,
}

/// Stable snake_case IPC result requested by the desktop frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DesktopConfigSyncReport {
    pub proxy_assigned: bool,
    /// 通过当前全局上游代理探测到的公网出口 IP；没有 active 代理时为空。
    pub proxy_ip: Option<String>,
    pub platforms: Vec<DesktopPlatformView>,
    /// 归一化后的直连域名，仅用于界面提示「这些域名不走代理」。
    pub direct_hosts: Vec<String>,
}

pub(crate) struct ValidatedDesktopConfig {
    pub(crate) proxy: Option<ValidatedConfig>,
    pub(crate) platforms: Vec<DesktopPlatform>,
    pub(crate) profile_key: String,
    pub(crate) lease: String,
}

pub(crate) fn should_spawn_session_watchdog(config: &ValidatedDesktopConfig) -> bool {
    config.proxy.is_some() || !config.platforms.is_empty()
}

pub(crate) fn validate_desktop_config(
    wire: DesktopConfigWire,
    api_base: &str,
) -> CmdResult<ValidatedDesktopConfig> {
    let profile_key = validate_label(&wire.profile_key, "浏览器环境标识", 512)?;
    if profile::contains_managed_profile_marker(&profile_key) {
        return Err(CommandError::new(
            "管理员下发的浏览器环境标识使用了保留格式",
            "invalid_desktop_config",
        ));
    }
    let lease = wire.lease.trim().to_ascii_lowercase();
    if lease.len() != 64 || !lease.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(CommandError::new(
            "管理员下发的桌面配置租约无效",
            "invalid_desktop_config",
        ));
    }
    let mut ids = HashSet::new();
    let mut platforms = Vec::with_capacity(wire.platforms.len());
    for platform in wire.platforms {
        if platform.id <= 0 || !ids.insert(platform.id) {
            return Err(CommandError::new(
                "管理员下发的平台 ID 无效或重复",
                "invalid_desktop_config",
            ));
        }
        let name = validate_label(&platform.name, "平台名称", 100)?;
        let url = validate_http_url(&platform.url, "平台网址")?;
        let mut account_ids = HashSet::new();
        let mut managed_accounts = Vec::with_capacity(platform.managed_accounts.len());
        for account in platform.managed_accounts {
            if account.id <= 0 || !account_ids.insert(account.id) {
                return Err(CommandError::new(
                    "管理员下发的托管账号 ID 无效或重复",
                    "invalid_desktop_config",
                ));
            }
            let account_name = validate_label(&account.name, "托管账号名称", 255)?;
            let status = account.status.trim().to_ascii_lowercase();
            if !matches!(
                status.as_str(),
                "active" | "expired" | "revoked" | "invalid"
            ) {
                return Err(CommandError::new(
                    "管理员下发的托管账号状态无效",
                    "invalid_desktop_config",
                ));
            }
            let recovery_status = account.recovery_status.trim().to_ascii_lowercase();
            if !matches!(
                recovery_status.as_str(),
                "idle" | "pending" | "running" | "retry_wait" | "failed"
            ) {
                return Err(CommandError::new(
                    "管理员下发的托管账号恢复状态无效",
                    "invalid_desktop_config",
                ));
            }
            let session_status = account.session_status.trim().to_ascii_lowercase();
            if !matches!(session_status.as_str(), "valid" | "expired") {
                return Err(CommandError::new(
                    "管理员下发的托管账号会话状态无效",
                    "invalid_desktop_config",
                ));
            }
            managed_accounts.push(ManagedAccountView {
                id: account.id,
                name: account_name,
                status,
                credential_version: account.credential_version,
                session_status,
                auto_relogin: account.auto_relogin,
                recovery_status,
                recovery_attempts: account.recovery_attempts,
                last_error: account.last_error,
            });
        }
        platforms.push(DesktopPlatform {
            id: platform.id,
            name,
            url,
            icon_url: platform
                .icon_url
                .as_deref()
                .and_then(|value| resolve_uploaded_asset_url(api_base, value)),
            sort_order: platform.sort_order,
            managed_accounts,
        });
    }
    platforms.sort_by_key(|platform| (platform.sort_order, platform.id));

    let proxy = match wire.proxy {
        Some(proxy) => {
            if proxy.id <= 0 {
                return Err(CommandError::new(
                    "管理员下发的代理 ID 无效",
                    "invalid_desktop_config",
                ));
            }
            let form = ProxyForm {
                host: proxy.host,
                port: proxy.port.to_string(),
                username: proxy.username,
                password: proxy.password,
                probe_url: network_probe_url(api_base),
                bypass_hosts: proxy.bypass_hosts,
            };
            let config = config::validate(&form)
                .map_err(|e| CommandError::new(e.to_string(), "invalid_desktop_config"))?;
            Some(config)
        }
        None => None,
    };

    Ok(ValidatedDesktopConfig {
        proxy,
        platforms,
        profile_key,
        lease,
    })
}

pub(crate) fn platform_views(platforms: &[DesktopPlatform]) -> Vec<DesktopPlatformView> {
    platforms
        .iter()
        .map(|platform| DesktopPlatformView {
            id: platform.id,
            name: platform.name.clone(),
            icon_url: platform.icon_url.clone(),
            managed_accounts: platform
                .managed_accounts
                .iter()
                .map(|account| DesktopManagedAccountView {
                    id: account.id,
                    name: account.name.clone(),
                    status: account.status.clone(),
                    credential_version: account.credential_version,
                    session_status: account.session_status.clone(),
                    auto_relogin: account.auto_relogin,
                    recovery_status: account.recovery_status.clone(),
                    recovery_attempts: account.recovery_attempts,
                    last_error: account.last_error.clone(),
                })
                .collect(),
        })
        .collect()
}

pub(crate) fn validate_label(value: &str, label: &str, max_chars: usize) -> CmdResult<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars || value.chars().any(char::is_control)
    {
        return Err(CommandError::new(
            format!("管理员下发的{label}无效"),
            "invalid_desktop_config",
        ));
    }
    Ok(value.to_string())
}

pub(crate) fn validate_http_url(value: &str, label: &str) -> CmdResult<String> {
    let parsed = Url::parse(value.trim()).map_err(|_| {
        CommandError::new(
            format!("管理员下发的{label}格式错误"),
            "invalid_desktop_config",
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(CommandError::new(
            format!("管理员下发的{label}只允许无账号的 http(s) 地址"),
            "invalid_desktop_config",
        ));
    }
    Ok(parsed.to_string())
}

/// Pull the authenticated user's administrator-assigned proxy and platform
/// allowlist and leave a tested local
/// adapter ready for the browser. A missing proxy is a valid unconfigured state.
#[tauri::command]
pub async fn sync_desktop_config<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth: tauri::State<'_, DesktopAuthState>,
    browsers: tauri::State<'_, BrowserSessionManager>,
) -> CmdResult<DesktopConfigSyncReport> {
    // Keep the entire server fetch + proxy probe + adapter install atomic from
    // the desktop user's perspective. The auth check intentionally happens
    // after acquiring the gate so a queued command cannot reuse an old login.
    let _sync_guard = state.lock_desktop_sync().await;
    require_desktop_auth(&auth)?;
    let (user_id, _, auth_generation) = auth.current_identity().map_err(auth_command_error)?;

    // A refresh is fail-closed: no old proxy/browser may keep running if the
    // server rejects this token or the new assignment cannot be validated.
    browsers.close_all().await;
    state.teardown();

    let wire = match auth.fetch_desktop_config::<DesktopConfigWire>().await {
        Ok(wire) => wire,
        Err(error) => {
            emit_status(&app, &state);
            return Err(auth_command_error(error));
        }
    };
    let api_base = auth.api_base_url().map_err(auth_command_error)?.to_string();
    let validated = match validate_desktop_config(wire, &api_base) {
        Ok(config) => config,
        Err(error) => {
            emit_status(&app, &state);
            return Err(error);
        }
    };

    // Reject a late response if logout/login happened while the request was in flight.
    let (current_user_id, _, current_generation) =
        auth.current_identity().map_err(auth_command_error)?;
    if current_user_id != user_id || current_generation != auth_generation {
        return Err(CommandError::new(
            "登录用户已发生变化，请重新同步桌面配置",
            "session_changed",
        ));
    }
    auth.set_profile_key(user_id, validated.profile_key.clone())
        .map_err(auth_command_error)?;

    let assignment_revision = state.set_desktop_assignment(
        user_id,
        auth_generation,
        validated.profile_key.clone(),
        validated.platforms.clone(),
    );
    if assignment_revision == 0 {
        return Err(CommandError::new(
            "客户端正在退出，不能再同步配置",
            "shutting_down",
        ));
    }
    let platform_views = platform_views(&validated.platforms);

    let Some(proxy_config) = validated.proxy else {
        // Platform-only configurations still need lease monitoring so a
        // revoked platform allowlist closes any direct browser sessions.
        if should_spawn_session_watchdog(&validated) {
            spawn_session_watchdog(
                app.clone(),
                state.inner().clone(),
                auth.inner().clone(),
                user_id,
                auth_generation,
                assignment_revision,
                validated.lease.clone(),
            );
        }
        emit_status(&app, &state);
        return Ok(DesktopConfigSyncReport {
            proxy_assigned: false,
            proxy_ip: None,
            platforms: platform_views,
            direct_hosts: Vec::new(),
        });
    };

    if !state.begin_testing() {
        return Err(CommandError::new("正在测试中，请稍候", "busy"));
    }
    emit_status(&app, &state);

    let proxy_ip = match probe_proxy(&proxy_config).await {
        Ok(ip) => ip,
        Err(error) => {
            if state.desktop_assignment_matches(user_id, auth_generation, assignment_revision) {
                state.mark_error(error.message.clone(), Some(error.code.clone()));
                emit_status(&app, &state);
            }
            return Err(error);
        }
    };

    // A proxy probe can be slow. Revalidate both the exact login generation and
    // the server-issued configuration lease before installing any local route.
    let session_still_current = auth
        .current_identity()
        .map(|(current_user, _, generation)| {
            current_user == user_id && generation == auth_generation
        })
        .unwrap_or(false);
    if !session_still_current {
        if state.invalidate_desktop_session(user_id, auth_generation, assignment_revision) {
            emit_status(&app, &state);
        }
        return Err(CommandError::new(
            "登录已失效，已停止代理适配器",
            "unauthenticated",
        ));
    }

    match auth
        .validate_desktop_lease(user_id, auth_generation, &validated.lease)
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            if state.invalidate_desktop_configuration(user_id, auth_generation, assignment_revision)
            {
                emit_status(&app, &state);
            }
            return Err(CommandError::new(
                "管理员已更新全局桌面配置，请重新同步",
                "desktop_config_changed",
            ));
        }
        Err(error) => {
            let error = auth_command_error(error);
            if error.code == "unauthenticated" {
                state.invalidate_desktop_session(user_id, auth_generation, assignment_revision);
            } else if error.code != "session_changed"
                && state.desktop_assignment_matches(user_id, auth_generation, assignment_revision)
            {
                state.mark_error(error.message.clone(), Some(error.code.clone()));
            }
            emit_status(&app, &state);
            return Err(error);
        }
    }

    let upstream = proxy_config.upstream();
    let direct_hosts = proxy_config.direct_hosts.clone();
    let direct_host_view = direct_hosts.entries();
    let handle = match start_adapter(upstream, direct_hosts).await {
        Ok(handle) => handle,
        Err(error) => {
            if state.desktop_assignment_matches(user_id, auth_generation, assignment_revision) {
                state.mark_error(error.message.clone(), Some(error.code.clone()));
                emit_status(&app, &state);
            }
            return Err(error);
        }
    };
    // Recheck local expiry after adapter startup, then atomically publish the
    // candidate only for this exact assignment revision.
    let session_still_current = auth
        .current_identity()
        .map(|(current_user, _, generation)| {
            current_user == user_id && generation == auth_generation
        })
        .unwrap_or(false);
    if !session_still_current {
        handle.stop();
        if state.invalidate_desktop_session(user_id, auth_generation, assignment_revision) {
            emit_status(&app, &state);
        }
        return Err(CommandError::new(
            "登录已失效，已停止代理适配器",
            "unauthenticated",
        ));
    }
    if !state.mark_ready_for(
        assignment_revision,
        Session {
            adapter: handle,
            browser_ids: HashSet::new(),
        },
    ) {
        return Err(CommandError::new(
            "桌面配置已被新的同步任务替换",
            "session_changed",
        ));
    }

    spawn_session_watchdog(
        app.clone(),
        state.inner().clone(),
        auth.inner().clone(),
        user_id,
        auth_generation,
        assignment_revision,
        validated.lease,
    );
    emit_status(&app, &state);
    Ok(DesktopConfigSyncReport {
        proxy_assigned: true,
        proxy_ip: Some(proxy_ip),
        platforms: platform_views,
        direct_hosts: direct_host_view,
    })
}

pub(crate) fn spawn_session_watchdog<R: Runtime>(
    app: AppHandle<R>,
    state: AppState,
    auth: DesktopAuthState,
    user_id: i64,
    auth_generation: u64,
    assignment_revision: u64,
    expected_lease: String,
) {
    rt::runtime().spawn(async move {
        let mut transient_failures = 0u8;
        loop {
            tokio::time::sleep(SESSION_WATCHDOG_INTERVAL).await;
            if !state.desktop_assignment_matches(user_id, auth_generation, assignment_revision) {
                break;
            }

            match auth
                .validate_desktop_lease(user_id, auth_generation, &expected_lease)
                .await
            {
                Ok(true) => transient_failures = 0,
                Ok(false) => {
                    let _lifecycle_guard = state.lock_desktop_sync().await;
                    if state.invalidate_desktop_configuration(
                        user_id,
                        auth_generation,
                        assignment_revision,
                    ) {
                        let browsers = app.state::<BrowserSessionManager>().inner().clone();
                        browsers.close_all().await;
                        let _ = app.emit("status-changed", state.snapshot());
                    }
                    break;
                }
                Err(error) if error.code == "session_changed" => break,
                Err(error)
                    if matches!(error.code.as_str(), "network" | "server")
                        && transient_failures < 2 =>
                {
                    // 间隔缩短后允许连续两次网络抖动，避免一次断网就把会话拆掉。
                    transient_failures += 1;
                }
                Err(_) => {
                    let _lifecycle_guard = state.lock_desktop_sync().await;
                    if state.invalidate_desktop_session(
                        user_id,
                        auth_generation,
                        assignment_revision,
                    ) {
                        let browsers = app.state::<BrowserSessionManager>().inner().clone();
                        browsers.close_all().await;
                        let _ = app.emit("status-changed", state.snapshot());
                    }
                    break;
                }
            }
        }
    });
}

/// Probe the upstream without publishing a browser-ready local adapter. The
/// caller must revalidate the configuration lease after this potentially slow
/// operation and only then install a session.
pub(crate) async fn probe_proxy(config: &ValidatedConfig) -> CmdResult<String> {
    let upstream = config.upstream();
    let probe_url = config.probe_url.clone();

    rt::runtime()
        .spawn({
            let upstream = upstream.clone();
            let probe_url = probe_url.clone();
            async move { probe::probe_via_upstream(&upstream, &probe_url).await }
        })
        .await
        .map_err(|e| CommandError::new(format!("内部任务失败：{e}"), "internal"))?
        .map_err(|e| CommandError::new(e.to_string(), e.code()))
}

/// 在应用自己的运行时里启动适配器，避免绑定到 Tauri 的事件循环线程。
///
/// `direct` 是管理员下发并已校验的直连域名列表，空列表表示全部走代理。
pub(crate) async fn start_adapter(
    upstream: UpstreamProxy,
    direct: DirectHosts,
) -> CmdResult<adapter::AdapterHandle> {
    rt::runtime()
        .spawn(async move { adapter::start(upstream, direct).await })
        .await
        .map_err(|e| CommandError::new(format!("内部任务失败：{e}"), "internal"))?
        .map_err(|e| CommandError::new(format!("本地代理适配器启动失败：{e}"), "adapter_start"))
}

/// 打开一个平台：它在本机的持久环境没在运行就启动一个 Chromium，已经在运行就让那个
/// 浏览器新开一个窗口。
///
/// 同一个环境同时只能有一个 Chromium 进程（见 [`crate::browser`] 模块文档）。重复点击
/// 同一平台只激活已经存在的页面；找不到页面时失败，不创建第二个标签或窗口。不同平台、
/// 同一平台的代理与直连，仍然是各自独立的浏览器。
// Tauri 注入的 State 参数就占了 5 个，再加平台 ID 与两个本机开关（直连、关沙箱）
// 必然超过 clippy 的 7 个阈值；这是 IPC 命令的固有形态，不是设计问题。
pub(crate) fn emit_status<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    let _ = app.emit("status-changed", state.snapshot());
}
