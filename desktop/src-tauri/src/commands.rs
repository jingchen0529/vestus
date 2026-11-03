//! 暴露给前端的 IPC 命令。
//!
//! 这一层只做三件事：转发参数、把 Rust 错误翻译成中文提示、维护状态机。
//! 真正的网络行为都在 [`crate::adapter`] 和 [`crate::upstream`] 里。
//!
//! 安全约束（与文档第 9 节一致）：
//! - 口令只进入 [`crate::config::ProxyForm`] 与当前 Rust 会话内存，绝不回传 JavaScript 或落盘；
//! - 返回给前端的任何结构体都不含口令字段；
//! - 浏览器窗口的代理只能是 `http://127.0.0.1:<port>`，不接受其他取值。

use std::collections::HashSet;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, Runtime};
use url::Url;

use crate::activity::{ActivityCollector, ActivityOwner, SessionKey as ActivitySessionKey};
use crate::auth::{resolve_uploaded_asset_url, DesktopAuthState};
use crate::browser::{BrowserError, BrowserSessionManager};
use crate::bypass::DirectHosts;
use crate::cdp;
use crate::config::{self, DesktopPlatform, ManagedAccountView, ProxyForm, ValidatedConfig};
use crate::device;
use crate::managed_cdp;
use crate::probe;
use crate::profile::{self, ProfileSpec};
use crate::rt;
use crate::state::{AppState, Session, StatusView};
use crate::{adapter, upstream::UpstreamProxy};

/// 租约轮询节奏。管理员改配置/轮换托管凭据后，桌面端最迟这个间隔自动生效；
/// 同时也是令牌被吊销后收敛代理与浏览器的上限。查询本身只是一条带鉴权的快照
/// 读取，10s 对服务端的成本可以忽略。
const SESSION_WATCHDOG_INTERVAL: Duration = Duration::from_secs(10);
/// 服务端自动登录恢复的等待节奏：3 秒轮询一次，最多等 3 分钟。
const RECOVERY_POLL_INTERVAL: Duration = Duration::from_secs(3);
const RECOVERY_WAIT_BUDGET: Duration = Duration::from_secs(180);
const RECOVERY_MAX_NETWORK_ERRORS: u8 = 5;
const NETWORK_IP_PATH: &str = "/api/network/ip";

/// 开发期覆盖出口检测地址的环境变量。只在 debug 构建生效。
#[cfg(all(debug_assertions, not(test)))]
const PROBE_URL_ENV: &str = "VESTUS_PROBE_URL";

/// 前端能看到的错误形态。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CommandError {
    /// 可直接显示的中文提示
    pub message: String,
    /// 归类用短代码，前端据此区分样式
    pub code: String,
}

impl CommandError {
    fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
        }
    }
}

type CmdResult<T> = Result<T, CommandError>;

fn require_desktop_auth(auth: &tauri::State<'_, DesktopAuthState>) -> CmdResult<()> {
    if auth.is_authenticated() {
        Ok(())
    } else {
        Err(CommandError::new(
            "桌面登录已失效，请重新登录",
            "unauthenticated",
        ))
    }
}

/// Exact response shape of the administrator-controlled desktop endpoint.
/// The proxy password is deserialized only into this private Rust type.
#[derive(serde::Deserialize)]
struct DesktopConfigWire {
    proxy: Option<DesktopProxyWire>,
    #[serde(default)]
    platforms: Vec<DesktopPlatformWire>,
    #[serde(rename = "profileKey", alias = "profile_key")]
    profile_key: String,
    lease: String,
}

#[derive(serde::Deserialize)]
struct DesktopProxyWire {
    id: i64,
    host: String,
    port: u16,
    username: String,
    password: String,
    /// 管理员下发的直连域名。缺省为空，即全部走代理。
    #[serde(rename = "bypassHosts", alias = "bypass_hosts", default)]
    bypass_hosts: Vec<String>,
}

#[derive(serde::Deserialize)]
struct DesktopPlatformWire {
    id: i64,
    name: String,
    url: String,
    #[serde(rename = "iconUrl", alias = "icon_url", default)]
    icon_url: Option<String>,
    #[serde(rename = "sortOrder", alias = "sort_order", default)]
    sort_order: i64,
    #[serde(rename = "managedAccounts", alias = "managed_accounts", default)]
    managed_accounts: Vec<ManagedAccountWire>,
}

#[derive(serde::Deserialize)]
struct ManagedAccountWire {
    id: i64,
    name: String,
    #[serde(default = "default_managed_account_status")]
    status: String,
    #[serde(rename = "credentialVersion", default)]
    credential_version: u64,
    #[serde(rename = "sessionStatus", default = "default_managed_session_status")]
    session_status: String,
    #[serde(rename = "autoRelogin", default)]
    auto_relogin: bool,
    #[serde(rename = "recoveryStatus", default = "default_managed_recovery_status")]
    recovery_status: String,
    #[serde(rename = "recoveryAttempts", default)]
    recovery_attempts: u32,
    #[serde(rename = "lastError", default)]
    last_error: Option<String>,
}

fn default_managed_session_status() -> String {
    "valid".into()
}

fn default_managed_recovery_status() -> String {
    "idle".into()
}

fn default_managed_account_status() -> String {
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

/// 打开浏览器后返回的令牌，仅用于把状态机里的会话和 Chromium 进程对上。
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserHandleView {
    pub browser_id: u64,
    /// 这个平台的浏览器本来就开着，这次没有启动新的浏览器进程。
    pub reused: bool,
    /// `reused` 为真时说明这次是把已有的同域标签切到了最前；重复点击不会创建
    /// 新标签或新窗口。
    pub tab_action: Option<String>,
    /// 实际使用的网络模式。托管平台可能把用户选择的直连请求强制改为代理。
    pub direct_mode: bool,
    /// 是否由后台托管会话启动；仅作为界面提示，不包含凭据。
    pub managed: bool,
}

/// 重置本机浏览器环境的结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserProfileResetView {
    /// 删掉的平台环境个数（代理与直连分开计）。
    pub removed: usize,
}

struct ValidatedDesktopConfig {
    proxy: Option<ValidatedConfig>,
    platforms: Vec<DesktopPlatform>,
    profile_key: String,
    lease: String,
}

/// 出口检测地址：默认就是自己后端的 `/api/network/ip`。
///
/// 刻意不回退到任何第三方 IP 回显服务——见 [`crate::config`] 里那条测试。
///
/// 但这个地址是**上游代理那一侧**去访问的，而开发默认的 API 基址是
/// `http://127.0.0.1:8000`：它在代理服务器上指向代理机自己，探测必然失败。所以
/// debug 构建允许用 `VESTUS_PROBE_URL` 单独指到一个公网可达的地址。release 构建
/// 里这段代码不存在，行为与之前逐字节相同。
///
/// 单元测试里也不启用覆盖：`network_probe_url` 的既有断言不该被外部环境左右。
fn network_probe_url(api_base: &str) -> String {
    #[cfg(all(debug_assertions, not(test)))]
    if let Ok(configured) = std::env::var(PROBE_URL_ENV) {
        let configured = configured.trim();
        if !configured.is_empty() {
            return configured.to_string();
        }
    }
    format!("{}{NETWORK_IP_PATH}", api_base.trim_end_matches('/'))
}

fn should_spawn_session_watchdog(config: &ValidatedDesktopConfig) -> bool {
    config.proxy.is_some() || !config.platforms.is_empty()
}

fn validate_desktop_config(
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

fn platform_views(platforms: &[DesktopPlatform]) -> Vec<DesktopPlatformView> {
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

fn validate_label(value: &str, label: &str, max_chars: usize) -> CmdResult<String> {
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

fn validate_http_url(value: &str, label: &str) -> CmdResult<String> {
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

fn validate_bootstrap_account_id(requested: Option<i64>, returned: u64) -> CmdResult<i64> {
    let returned = i64::try_from(returned)
        .map_err(|_| CommandError::new("托管账号 ID 无效", "managed_session_invalid"))?;
    if let Some(requested) = requested {
        if requested != returned {
            return Err(CommandError::new(
                "托管登录会话与所选账号不一致",
                "managed_session_invalid",
            ));
        }
    }
    Ok(returned)
}

/// 当前状态快照。前端轮询或收到事件后调用。
#[tauri::command]
pub fn get_status(
    state: tauri::State<'_, AppState>,
    auth: tauri::State<'_, DesktopAuthState>,
) -> CmdResult<StatusView> {
    require_desktop_auth(&auth)?;
    Ok(state.snapshot())
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

fn spawn_session_watchdog<R: Runtime>(
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

fn auth_command_error(error: crate::auth::DesktopAuthError) -> CommandError {
    CommandError::new(error.message, error.code)
}

/// Poll the server config until the reported managed account is re-logged-in.
///
/// 只读拉取配置（不关闭浏览器、不重建代理），凭据仍只留在 Rust 内存。恢复
/// 成功或确定失败后发一次 `managed-session-recovered`；前端据此自动重新打开。
async fn wait_managed_recovery<R: Runtime>(
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
        if !auth.current_identity().is_ok_and(|(current_user, _, generation)| {
            current_user == user_id && generation == auth_generation
        }) {
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
        if account.session_status == "valid" && account.credential_version > identity.credential_version
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

/// Probe the upstream without publishing a browser-ready local adapter. The
/// caller must revalidate the configuration lease after this potentially slow
/// operation and only then install a session.
async fn probe_proxy(config: &ValidatedConfig) -> CmdResult<String> {
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
async fn start_adapter(
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
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub async fn open_browser<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth: tauri::State<'_, DesktopAuthState>,
    browsers: tauri::State<'_, BrowserSessionManager>,
    activity: tauri::State<'_, ActivityCollector>,
    platform_id: i64,
    managed_account_id: Option<i64>,
    direct_mode: Option<bool>,
    disable_sandbox: Option<bool>,
) -> CmdResult<BrowserHandleView> {
    let mut direct_mode = direct_mode.unwrap_or(false);
    // 本机偏好：沙箱拉不起来的机器由用户在「系统配置」里关闭。默认保留沙箱。
    // 只影响 --no-sandbox，与代理链路正交。
    let disable_sandbox = disable_sandbox.unwrap_or(false);
    let _lifecycle_guard = state.lock_desktop_sync().await;
    require_desktop_auth(&auth)?;
    let (user_id, profile_key, auth_generation) =
        auth.current_identity().map_err(auth_command_error)?;
    let mut launch = state
        .resolve_browser_launch(
            user_id,
            auth_generation,
            profile_key.as_deref(),
            platform_id,
            managed_account_id,
            direct_mode,
        )
        .ok_or_else(|| {
            CommandError::new(
                "该平台不在管理员下发的允许列表中，请重新同步配置",
                "platform_not_allowed",
            )
        })?;
    // 先解析起始网址：下面分配浏览器槽位之后再失败，那个槽位就回收不了了。
    let target = Url::parse(&launch.target_url)
        .map_err(|error| CommandError::new(format!("起始网址无法解析：{error}"), "invalid_form"))?;
    // resolve_browser_launch 刚确认过它与这次同步下发的一致，走到这里不可能为空。
    let profile_key = profile_key
        .ok_or_else(|| CommandError::new("请先同步桌面配置，再打开浏览器", "not_ready"))?;
    let api_base = auth.api_base_url().map_err(auth_command_error)?.to_string();

    // A managed platform gets a profile namespace that includes the server
    // controlled account and credential version.  This prevents a rotated
    // account from inheriting the previous account's cookies/local storage.
    // The bootstrap payload is consumed only after the normal desktop auth
    // and platform allowlist checks above have succeeded.
    let requested_managed_account_id = managed_account_id;
    let device_id = device::wire_device_id();
    let managed_session = auth
        .fetch_managed_session::<managed_cdp::ManagedBootstrapWire>(
            platform_id,
            managed_account_id,
            device_id.clone(),
        )
        .await
        .map_err(auth_command_error)?
        .map(|wire| {
            let profile_key = format!(
                "{profile_key}::managed-account-{}::credential-version-{}",
                wire.managed_account_id, wire.credential_version
            );
            let managed_account_id = validate_bootstrap_account_id(
                requested_managed_account_id,
                wire.managed_account_id,
            )?;
            let session = managed_cdp::managed_session_from_bootstrap(target.as_str().into(), wire)
                .map_err(|error| {
                    CommandError::new(
                        format!("托管登录会话无效：{error}"),
                        "managed_session_invalid",
                    )
                })?;
            Ok::<_, CommandError>((profile_key, managed_account_id, session))
        })
        .transpose()?;
    let (browser_profile_key, resolved_managed_account_id, managed_session) = managed_session
        .map_or_else(
            || (profile_key.clone(), None, None),
            |(key, managed_account_id, session)| (key, Some(managed_account_id), Some(session)),
        );
    if requested_managed_account_id.is_some() && resolved_managed_account_id.is_none() {
        return Err(CommandError::new(
            "指定的托管账号不可用，请重新同步配置",
            "managed_account_not_found",
        ));
    }
    let managed_account_id = resolved_managed_account_id;

    // Managed sessions use the administrator-selected proxy route. A client
    // cannot create a second direct-mode profile containing the same account.
    if managed_session.is_some() && direct_mode {
        direct_mode = false;
        launch = state
            .resolve_browser_launch(
                user_id,
                auth_generation,
                Some(&profile_key),
                platform_id,
                managed_account_id,
                false,
            )
            .ok_or_else(|| {
                CommandError::new(
                    "托管平台必须使用管理员配置的代理线路",
                    "managed_proxy_required",
                )
            })?;
    }

    let profile = browsers
        .prepare_profile(
            &app,
            &ProfileSpec {
                api_base: &api_base,
                profile_key: &browser_profile_key,
                platform_id,
                direct_mode,
            },
        )
        .map_err(browser_command_error)?;

    // A credential rotation gets a new profile environment. Retire an older
    // managed version for this exact account/platform/mode before deciding
    // whether to reuse the current environment. Ordinary manual profiles in
    // the same account directory are deliberately left running.
    if let Some(managed_account_id) = managed_account_id {
        let account_dir = profile
            .dir()
            .parent()
            .expect("持久浏览器环境必须位于账号目录下")
            .to_path_buf();
        let _ = browsers
            .close_managed_profile_versions(
                &account_dir,
                platform_id,
                direct_mode,
                u64::try_from(managed_account_id).map_err(|_| {
                    CommandError::new("托管账号 ID 无效", "managed_session_invalid")
                })?,
                profile.dir(),
            )
            .await;
    }

    let local_proxy = launch.port.map(|p| format!("http://127.0.0.1:{p}"));

    if let Some(browser_id) = browsers.running_browser(profile.dir()) {
        // 已有浏览器只能激活已存在的平台标签。端点不可用、标签不存在或激活失败时
        // 直接失败；不创建第二个标签，也不转交到另一个窗口。
        // 托管复用也不再次注入：watcher 始终对应该进程最初使用的 bootstrap 身份。
        let endpoint = browsers.session_endpoint(browser_id).ok_or_else(|| {
            CommandError::new("平台页面尚未就绪，请稍后重试", "browser_page_unavailable")
        })?;
        cdp::open_or_activate_page(&endpoint, target.as_str())
            .await
            .map_err(|error| {
                let message = match error {
                    cdp::CdpError::NoMatchingPage => "平台页面已关闭，请重新初始化浏览器",
                    _ => "平台页面不可用，请关闭并重新打开浏览器",
                };
                CommandError::new(message, "browser_page_unavailable")
            })?;
        return Ok(BrowserHandleView {
            browser_id,
            reused: true,
            tab_action: Some("activated".into()),
            direct_mode,
            managed: managed_session.is_some(),
        });
    }

    let browser_id = state.mark_browser_opened(direct_mode).ok_or_else(|| {
        CommandError::new("请先同步并测试代理，通过后才能打开浏览器", "not_ready")
    })?;

    let state_for_exit = state.inner().clone();
    let app_for_exit = app.clone();
    // 采集通道：调试端点可读时才开，开不起来也只是这次会话没有日志。
    let activity_collector = activity.inner().clone();
    // Activity uploads are authorized against the server-issued base profile
    // key.  The managed account/version suffix is only the local Chromium
    // namespace and must never be sent as the owner's profile identity.
    let activity_owner = ActivityOwner::new(&api_base, &profile_key, user_id);
    let activity_key = ActivitySessionKey {
        browser_id,
        platform_id,
        managed_account_id,
        direct_mode,
    };
    let initial_url = if managed_session.is_some() {
        "about:blank"
    } else {
        target.as_str()
    };
    let managed_session_for_ready = managed_session.clone();
    let managed_launch = managed_session.is_some();
    let logout_context = managed_session
        .as_ref()
        .map(|session| ManagedLogoutContext {
            browsers: browsers.inner().clone(),
            auth: auth.inner().clone(),
            app: app.clone(),
            browser_id,
            platform_id,
            user_id,
            auth_generation,
            device_id,
            identity: session
                .identity
                .clone()
                .expect("consumed bootstrap has an identity"),
        });
    let (watch_exit_tx, watch_exit_rx) = if managed_launch {
        let (tx, rx) = tokio::sync::oneshot::channel();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    let (ready_tx, mut ready_rx) = if managed_launch {
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        (Some(tx), Some(rx))
    } else {
        (None, None)
    };
    if let Err(error) = browsers.launch(
        &app,
        browser_id,
        profile,
        local_proxy.as_deref(),
        initial_url,
        disable_sandbox,
        move |endpoint| {
            let injection = if let Some(session) = managed_session_for_ready {
                rt::runtime().block_on(async {
                    // Subscribe before navigation. A separate connection owns
                    // events even while the injection connection awaits replies.
                    match managed_cdp::prepare_logout_watch(&endpoint, &session).await {
                        Ok(Some(watch)) => {
                            if let (Some(context), Some(exited)) = (logout_context, watch_exit_rx) {
                                rt::runtime().spawn(watch_managed_logout(context, watch, exited));
                            }
                        }
                        Ok(None) => {}
                        Err(error) => eprintln!("托管登出监听未启用：{error}"),
                    }
                    managed_cdp::inject_session(&endpoint, &session)
                        .await
                        .map_err(|error| error.to_string())
                })
            } else {
                Ok(())
            };
            if let Some(tx) = ready_tx {
                let _ = tx.send(injection.clone());
            }
            if injection.is_err() {
                return;
            }
            activity_collector.start(activity_key, endpoint, activity_owner);
        },
        move || {
            if let Some(tx) = watch_exit_tx {
                let _ = tx.send(());
            }
            // The browser manager owns cleanup and the lease; a late exit
            // callback must never reacquire the path and delete a new profile.
            state_for_exit.mark_browser_closed_for(browser_id);
            let _ = app_for_exit.emit("status-changed", state_for_exit.snapshot());
        },
    ) {
        state.mark_browser_closed_for(browser_id);
        emit_status(&app, &state);
        return Err(browser_command_error(error));
    }

    if let Some(rx) = ready_rx.take() {
        let ready = tokio::time::timeout(Duration::from_secs(35), rx).await;
        match ready {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(message))) => {
                kill_managed_browser(browsers.inner().clone(), browser_id).await?;
                state.mark_browser_closed_for(browser_id);
                emit_status(&app, &state);
                return Err(CommandError::new(
                    format!("托管登录会话注入失败：{message}"),
                    "managed_session_invalid",
                ));
            }
            Ok(Err(_)) | Err(_) => {
                kill_managed_browser(browsers.inner().clone(), browser_id).await?;
                state.mark_browser_closed_for(browser_id);
                emit_status(&app, &state);
                return Err(CommandError::new(
                    "托管浏览器初始化超时，请联系管理员重新验证账号",
                    "managed_session_timeout",
                ));
            }
        }
    }

    emit_status(&app, &state);
    Ok(BrowserHandleView {
        browser_id,
        reused: false,
        tab_action: None,
        direct_mode,
        managed: managed_session.is_some(),
    })
}

async fn kill_managed_browser(browsers: BrowserSessionManager, browser_id: u64) -> CmdResult<()> {
    rt::runtime()
        .spawn_blocking(move || browsers.kill_browser(browser_id))
        .await
        .map_err(|error| CommandError::new(format!("浏览器关闭任务失败：{error}"), "internal"))?
        .map_err(browser_command_error)?;
    Ok(())
}

struct ManagedLogoutContext<R: Runtime> {
    browsers: BrowserSessionManager,
    auth: DesktopAuthState,
    app: AppHandle<R>,
    browser_id: u64,
    platform_id: i64,
    user_id: i64,
    auth_generation: u64,
    device_id: Option<String>,
    identity: managed_cdp::ManagedSessionIdentity,
}

/// Best-effort platform signal, not an authentication boundary. Never turn a
/// disconnected watcher into an expired account; reports are bound to the
/// consumed bootstrap and are independently checked by the server.
async fn watch_managed_logout<R: Runtime>(
    context: ManagedLogoutContext<R>,
    watch: managed_cdp::LogoutWatch,
    exited: tokio::sync::oneshot::Receiver<()>,
) {
    let detected = tokio::select! {
        biased;
        result = watch.wait() => result,
        _ = exited => return,
    };
    match detected {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => {
            eprintln!("托管登出监听已断开：{error}");
            return;
        }
    }
    let browsers = context.browsers.clone();
    let browser_id = context.browser_id;
    let closed = match rt::runtime()
        .spawn_blocking(move || browsers.kill_browser(browser_id))
        .await
    {
        Ok(Ok(closed)) => closed,
        Ok(Err(error)) => {
            eprintln!("托管会话强杀或清理失败：{error}");
            false
        }
        Err(error) => {
            eprintln!("托管会话关闭任务失败：{error}");
            false
        }
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

/// 浏览器层的错误翻给前端。被别的进程占着单独给一个代码，前端据此提示用户去关那个
/// 浏览器，而不是让他反复重试。
fn browser_command_error(error: BrowserError) -> CommandError {
    let code = match error {
        BrowserError::ProfileBusy => "profile_busy",
        BrowserError::ProfileCheckFailed => "profile_check_failed",
        BrowserError::ProfileCleanup(_) => "profile_cleanup_failed",
        BrowserError::ProcessTermination(_) => "browser_termination_failed",
        _ => "browser_start",
    };
    CommandError::new(error.to_string(), code)
}

/// 删掉当前账号在本机的全部浏览器环境（各平台，代理与直连）。
///
/// 用于环境坏了、或者需要让平台把这台电脑当成一台新设备的时候。已打开的浏览器先按
/// 正常流程关掉：Windows 上删不掉正在用的文件，macOS 上则会把跑着的浏览器弄坏。别的
/// Vestus 实例还开着其中某个环境时一个都不删。其他账号、其他服务器的环境不受影响。
#[tauri::command]
pub async fn reset_browser_profiles<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth: tauri::State<'_, DesktopAuthState>,
    browsers: tauri::State<'_, BrowserSessionManager>,
) -> CmdResult<BrowserProfileResetView> {
    let _lifecycle_guard = state.lock_desktop_sync().await;
    require_desktop_auth(&auth)?;
    let (_, profile_key, _) = auth.current_identity().map_err(auth_command_error)?;
    let profile_key = profile_key
        .ok_or_else(|| CommandError::new("请先同步桌面配置，再重置浏览器环境", "not_ready"))?;
    let api_base = auth.api_base_url().map_err(auth_command_error)?.to_string();
    let account_dir = browsers
        .account_profiles_dir(&app, &api_base, &profile_key)
        .map_err(browser_command_error)?;

    // 本实例里开着的浏览器都属于当前账号：换账号必先关掉全部浏览器。
    browsers.close_all().await;
    let removed = rt::runtime()
        .spawn_blocking(move || profile::remove_account(&account_dir))
        .await
        .map_err(|error| CommandError::new(format!("内部任务失败：{error}"), "internal"))?
        .map_err(|error| match error {
            profile::ResetError::Busy => browser_command_error(BrowserError::ProfileBusy),
            profile::ResetError::CheckFailed => {
                browser_command_error(BrowserError::ProfileCheckFailed)
            }
            profile::ResetError::Io(detail) => {
                CommandError::new(format!("浏览器环境没能全部删除：{detail}"), "reset_failed")
            }
        })?;
    Ok(BrowserProfileResetView { removed })
}

/// 获取用户当前本机的公网出口 IP（直连模式下展示）。
#[tauri::command(rename_all = "camelCase")]
pub async fn get_direct_ip(auth: tauri::State<'_, DesktopAuthState>) -> CmdResult<String> {
    require_desktop_auth(&auth)?;
    let api_base = auth.api_base_url().map_err(auth_command_error)?;
    let probe_url = network_probe_url(api_base);
    probe::probe_direct(&probe_url)
        .await
        .map_err(|error| CommandError::new(format!("获取本机公网 IP 失败：{error}"), error.code()))
}

/// 在操作系统默认浏览器中打开指定的外部 HTTP/HTTPS 链接（如 GitHub Release 与安装包下载）。
#[tauri::command(rename_all = "camelCase")]
pub async fn open_external_url(url: String) -> CmdResult<()> {
    let parsed =
        Url::parse(&url).map_err(|_| CommandError::new("无效的网址格式", "invalid_url"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(CommandError::new(
            "仅支持打开 HTTP 或 HTTPS 链接",
            "invalid_scheme",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| {
                CommandError::new(format!("打开系统默认浏览器失败：{e}"), "open_failed")
            })?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| {
                CommandError::new(format!("打开系统默认浏览器失败：{e}"), "open_failed")
            })?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| {
                CommandError::new(format!("打开系统默认浏览器失败：{e}"), "open_failed")
            })?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        return Err(CommandError::new(
            "当前操作系统不支持自动打开外部浏览器",
            "unsupported_os",
        ));
    }

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubReleaseAssetView {
    pub name: String,
    pub download_url: String,
    pub size: i64,
    pub platform: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubReleaseCheckView {
    pub tag_name: String,
    pub latest_version: String,
    pub published_at: String,
    pub html_url: String,
    pub body: String,
    pub assets: Vec<GithubReleaseAssetView>,
}

#[derive(serde::Deserialize)]
struct RawGithubAsset {
    #[serde(default)]
    name: String,
    #[serde(rename = "browser_download_url", default)]
    browser_download_url: String,
    #[serde(default)]
    size: i64,
}

#[derive(serde::Deserialize)]
struct RawGithubRelease {
    #[serde(rename = "tag_name", default)]
    tag_name: String,
    #[serde(default)]
    name: String,
    #[serde(rename = "published_at", default)]
    published_at: String,
    #[serde(rename = "html_url", default)]
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    assets: Vec<RawGithubAsset>,
}

fn classify_asset_platform(filename: &str) -> String {
    let name_lower = filename.to_lowercase();
    if name_lower.contains("macos") || name_lower.contains("darwin") || name_lower.contains(".dmg")
    {
        if name_lower.contains("aarch64")
            || name_lower.contains("arm64")
            || name_lower.contains("m1")
            || name_lower.contains("apple")
        {
            return "macOS (Apple Silicon M系列)".to_string();
        }
        return "macOS (Intel x86_64)".to_string();
    }
    if name_lower.contains("windows") || name_lower.contains(".exe") || name_lower.contains(".msi")
    {
        return "Windows (x86_64)".to_string();
    }
    if name_lower.contains("appimage") {
        return "Linux (AppImage)".to_string();
    }
    if name_lower.contains(".deb") {
        return "Linux (Debian / Ubuntu)".to_string();
    }
    "通用安装包".to_string()
}

fn normalize_version_str(ver: &str) -> String {
    let trimmed = ver.trim();
    let stripped_desktop = trimmed.strip_prefix("desktop-").unwrap_or(trimmed);
    let stripped_v = stripped_desktop
        .strip_prefix('v')
        .unwrap_or(stripped_desktop);
    stripped_v.to_string()
}

/// 由 Rust 原生端请求 GitHub API 获取 Release 版本信息，彻底规避 WebView CSP 拦截。
#[tauri::command(rename_all = "camelCase")]
pub async fn check_github_release(repo: Option<String>) -> CmdResult<GithubReleaseCheckView> {
    let clean_repo = repo
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| "jingchen0529/vestus".to_string());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Vestus-Desktop-Client")
        .build()
        .map_err(|e| CommandError::new(format!("初始化网络客户端失败：{e}"), "client_init"))?;

    let url = format!("https://api.github.com/repos/{clean_repo}/releases/latest");
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await;

    let raw_release = match resp {
        Ok(res) if res.status().is_success() => res
            .json::<RawGithubRelease>()
            .await
            .map_err(|e| CommandError::new(format!("解析版本信息失败：{e}"), "json_parse"))?,
        Ok(res) if res.status() == reqwest::StatusCode::NOT_FOUND => {
            let list_url = format!("https://api.github.com/repos/{clean_repo}/releases");
            let list_res = client
                .get(&list_url)
                .header("Accept", "application/vnd.github.v3+json")
                .send()
                .await
                .map_err(|e| {
                    CommandError::new(format!("连接 GitHub 失败：{e}"), "network_error")
                })?;

            if !list_res.status().is_success() {
                return Err(CommandError::new(
                    format!("获取 GitHub Release 失败 (HTTP {})", list_res.status()),
                    "release_not_found",
                ));
            }

            let mut list = list_res
                .json::<Vec<RawGithubRelease>>()
                .await
                .map_err(|e| CommandError::new(format!("解析版本列表失败：{e}"), "json_parse"))?;

            if list.is_empty() {
                return Err(CommandError::new(
                    "未在 GitHub 找到已发布的版本",
                    "no_release",
                ));
            }
            list.remove(0)
        }
        Ok(res) if res.status() == reqwest::StatusCode::FORBIDDEN => {
            return Err(CommandError::new(
                "GitHub API 访问频次受限，请稍后重试",
                "rate_limited",
            ));
        }
        Ok(res) => {
            return Err(CommandError::new(
                format!("GitHub 返回异常状态码: HTTP {}", res.status()),
                "http_error",
            ));
        }
        Err(e) => {
            return Err(CommandError::new(
                format!("连接 GitHub 失败，请检查网络连接：{e}"),
                "network_error",
            ));
        }
    };

    let tag_name = raw_release.tag_name.clone();
    let latest_version = if !tag_name.is_empty() {
        normalize_version_str(&tag_name)
    } else {
        normalize_version_str(&raw_release.name)
    };

    let assets = raw_release
        .assets
        .into_iter()
        .map(|a| {
            let platform = classify_asset_platform(&a.name);
            GithubReleaseAssetView {
                name: a.name,
                download_url: a.browser_download_url,
                size: a.size,
                platform,
            }
        })
        .collect();

    Ok(GithubReleaseCheckView {
        tag_name,
        latest_version,
        published_at: raw_release.published_at,
        html_url: if !raw_release.html_url.is_empty() {
            raw_release.html_url
        } else {
            format!("https://github.com/{clean_repo}/releases")
        },
        body: raw_release.body,
        assets,
    })
}

fn emit_status<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    let _ = app.emit("status-changed", state.snapshot());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_check_failure_is_distinct_from_a_busy_environment() {
        let unknown =
            browser_command_error(BrowserError::from(profile::ProfileCheckError::Unknown));
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
}
