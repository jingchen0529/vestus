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

use crate::auth::DesktopAuthState;
use crate::browser::BrowserSessionManager;
use crate::config::{self, DesktopPlatform, ProxyForm, ValidatedConfig, DEFAULT_PROBE_URL};
use crate::probe;
use crate::rt;
use crate::state::{AppState, Session, StatusView};
use crate::{adapter, upstream::UpstreamProxy};

const SESSION_WATCHDOG_INTERVAL: Duration = Duration::from_secs(30);

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
}

#[derive(serde::Deserialize)]
struct DesktopPlatformWire {
    id: i64,
    name: String,
    url: String,
    #[serde(rename = "sortOrder", alias = "sort_order", default)]
    sort_order: i64,
}

/// The platform button is the only administrator-controlled object exposed to
/// JavaScript. Its target URL remains in Rust's launch allowlist.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DesktopPlatformView {
    pub id: i64,
    pub name: String,
}

/// Stable snake_case IPC result requested by the desktop frontend.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DesktopConfigSyncReport {
    pub proxy_assigned: bool,
    pub platforms: Vec<DesktopPlatformView>,
}

struct ValidatedDesktopConfig {
    proxy: Option<ValidatedConfig>,
    platforms: Vec<DesktopPlatform>,
    profile_key: String,
    lease: String,
}

fn validate_desktop_config(wire: DesktopConfigWire) -> CmdResult<ValidatedDesktopConfig> {
    let profile_key = validate_label(&wire.profile_key, "浏览器环境标识", 512)?;
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
        platforms.push(DesktopPlatform {
            id: platform.id,
            name,
            url,
            sort_order: platform.sort_order,
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
                probe_url: DEFAULT_PROBE_URL.to_string(),
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
    browsers.close_all();
    state.teardown();

    let wire = match auth.fetch_desktop_config::<DesktopConfigWire>().await {
        Ok(wire) => wire,
        Err(error) => {
            emit_status(&app, &state);
            return Err(auth_command_error(error));
        }
    };
    let validated = match validate_desktop_config(wire) {
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
        emit_status(&app, &state);
        return Ok(DesktopConfigSyncReport {
            proxy_assigned: false,
            platforms: platform_views,
        });
    };

    if !state.begin_testing() {
        return Err(CommandError::new("正在测试中，请稍候", "busy"));
    }
    emit_status(&app, &state);

    match probe_proxy(&proxy_config).await {
        Ok(_) => {}
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
                "管理员已更新桌面配置，请重新同步",
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
    let handle = match start_adapter(upstream).await {
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
        platforms: platform_views,
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
                        app.state::<BrowserSessionManager>().close_all();
                        let _ = app.emit("status-changed", state.snapshot());
                    }
                    break;
                }
                Err(error) if error.code == "session_changed" => break,
                Err(error)
                    if matches!(error.code.as_str(), "network" | "server")
                        && transient_failures < 1 =>
                {
                    transient_failures += 1;
                }
                Err(_) => {
                    let _lifecycle_guard = state.lock_desktop_sync().await;
                    if state.invalidate_desktop_session(
                        user_id,
                        auth_generation,
                        assignment_revision,
                    ) {
                        app.state::<BrowserSessionManager>().close_all();
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
async fn start_adapter(upstream: UpstreamProxy) -> CmdResult<adapter::AdapterHandle> {
    rt::runtime()
        .spawn(async move { adapter::start(upstream).await })
        .await
        .map_err(|e| CommandError::new(format!("内部任务失败：{e}"), "internal"))?
        .map_err(|e| CommandError::new(format!("本地代理适配器启动失败：{e}"), "adapter_start"))
}

/// 用管理员分配的本地代理启动一个新的外置 Chromium。
///
/// 每次调用都会创建新的临时 profile，同一平台也允许多开。
#[tauri::command(rename_all = "camelCase")]
pub async fn open_browser<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    auth: tauri::State<'_, DesktopAuthState>,
    browsers: tauri::State<'_, BrowserSessionManager>,
    platform_id: i64,
) -> CmdResult<()> {
    let _lifecycle_guard = state.lock_desktop_sync().await;
    require_desktop_auth(&auth)?;
    let (user_id, profile_key, auth_generation) =
        auth.current_identity().map_err(auth_command_error)?;
    let launch = state
        .resolve_browser_launch(
            user_id,
            auth_generation,
            profile_key.as_deref(),
            platform_id,
        )
        .ok_or_else(|| {
            CommandError::new(
                "该平台不在管理员下发的允许列表中，请重新同步配置",
                "platform_not_allowed",
            )
        })?;
    let browser_id = state.mark_browser_opened().ok_or_else(|| {
        CommandError::new("请先同步并测试代理，通过后才能打开浏览器", "not_ready")
    })?;

    let local_proxy = format!("http://127.0.0.1:{}", launch.port);
    let target = Url::parse(&launch.target_url)
        .map_err(|error| CommandError::new(format!("起始网址无法解析：{error}"), "invalid_form"))?;
    let state_for_exit = state.inner().clone();
    let app_for_exit = app.clone();
    if let Err(error) = browsers.launch(&app, &local_proxy, target.as_str(), move || {
        state_for_exit.mark_browser_closed_for(browser_id);
        let _ = app_for_exit.emit("status-changed", state_for_exit.snapshot());
    }) {
        state.mark_browser_closed_for(browser_id);
        emit_status(&app, &state);
        return Err(CommandError::new(error.to_string(), "browser_start"));
    }

    emit_status(&app, &state);
    Ok(())
}

fn emit_status<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    let _ = app.emit("status-changed", state.snapshot());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desktop_wire() -> DesktopConfigWire {
        serde_json::from_value(serde_json::json!({
            "proxy": {
                "id": 9,
                "name": "专属代理",
                "host": "203.0.113.8",
                "port": 8080,
                "username": "assigned-user",
                "password": "server-only-secret"
            },
            "platforms": [
                {"id": 2, "name": "平台二", "url": "https://two.example.test", "sortOrder": 20},
                {"id": 1, "name": "平台一", "url": "https://one.example.test", "sortOrder": 10}
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
    fn validates_and_sorts_server_platform_allowlist() {
        let validated = validate_desktop_config(desktop_wire()).unwrap();
        assert_eq!(validated.platforms[0].id, 1);
        assert_eq!(validated.platforms[1].id, 2);
        let config = validated.proxy.unwrap();
        assert_eq!(config.password, "server-only-secret");
    }

    #[test]
    fn sync_report_is_snake_case_and_never_serializes_password() {
        let validated = validate_desktop_config(desktop_wire()).unwrap();
        let report = DesktopConfigSyncReport {
            proxy_assigned: validated.proxy.is_some(),
            platforms: platform_views(&validated.platforms),
        };
        let value = serde_json::to_value(report).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 2);
        assert_eq!(value["proxy_assigned"], true);
        assert_eq!(value["platforms"][0].as_object().unwrap().len(), 2);
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
            validate_desktop_config(duplicate).err().unwrap().code,
            "invalid_desktop_config"
        );

        let mut unsafe_url = desktop_wire();
        unsafe_url.platforms[0].url = "file:///tmp/secret".into();
        assert_eq!(
            validate_desktop_config(unsafe_url).err().unwrap().code,
            "invalid_desktop_config"
        );

        let mut invalid_lease = desktop_wire();
        invalid_lease.lease = "not-a-lease".into();
        assert_eq!(
            validate_desktop_config(invalid_lease).err().unwrap().code,
            "invalid_desktop_config"
        );
    }
}
