//! 应用运行状态。
//!
//! 状态机与文档第 7 节一致：
//! `未配置 → 正在测试 → 可以打开 → 浏览器运行中`，另有 `代理错误 / 代理断开` 两条旁路。
//!
//! 适配器句柄放在这里统一持有，保证「改代理必须重建浏览器」这条约束
//! 在代码层面只有一个执行点：[`AppState::teardown`]。

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::adapter::AdapterHandle;
use crate::config::DesktopPlatform;

/// 浏览器 / 代理的整体阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// 还没有可用配置
    Unconfigured,
    /// 正在测试代理，期间禁止重复提交
    Testing,
    /// 测试通过，可以打开浏览器
    Ready,
    /// 浏览器窗口已打开
    BrowserRunning,
    /// 代理测试失败或运行中断开
    ProxyError,
}

impl Phase {
    /// 是否允许打开浏览器。
    pub fn can_open_browser(self) -> bool {
        // OA 允许在已有窗口运行时继续打开新的独立浏览器。
        matches!(self, Phase::Ready | Phase::BrowserRunning)
    }
}

/// 运行中的浏览器会话。
pub struct Session {
    pub adapter: AdapterHandle,
    /// 当前由 [`crate::browser::BrowserSessionManager`] 管理的 Chromium token。
    /// 使用集合而不是计数，防止旧进程的延迟退出回调误减新会话。
    pub browser_ids: HashSet<u64>,
}

#[derive(Clone)]
struct DesktopAssignment {
    user_id: i64,
    auth_generation: u64,
    revision: u64,
    profile_key: String,
    platforms: Vec<DesktopPlatform>,
}

/// Immutable data needed to construct one browser window. Upstream credentials
/// stay inside the adapter and are deliberately absent here.
pub struct BrowserLaunchInfo {
    pub target_url: String,
    pub port: u16,
}

/// 前端渲染所需的完整快照。
#[derive(Debug, Clone, serde::Serialize)]
pub struct StatusView {
    pub phase: Phase,
    pub message: String,
    pub browser_open: bool,
    /// 最近一次失败的短代码，便于前端区分提示样式
    pub error_code: Option<String>,
}

struct Inner {
    shutting_down: bool,
    phase: Phase,
    message: String,
    error_code: Option<String>,
    session: Option<Session>,
    desktop: Option<DesktopAssignment>,
    next_desktop_revision: u64,
    next_browser_id: u64,
}

/// 全局状态，注册进 Tauri 的 `manage`。
#[derive(Clone)]
pub struct AppState {
    inner: Arc<Mutex<Inner>>,
    desktop_sync_gate: Arc<AsyncMutex<()>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                shutting_down: false,
                phase: Phase::Unconfigured,
                message: "尚未配置代理".to_string(),
                error_code: None,
                session: None,
                desktop: None,
                next_desktop_revision: 0,
                next_browser_id: 0,
            })),
            desktop_sync_gate: Arc::new(AsyncMutex::new(())),
        }
    }
}

impl AppState {
    /// Serialize the full desktop configuration lifecycle transaction. Sync
    /// commands may queue, and logout also takes this gate so teardown cannot
    /// race a late adapter publication from an in-flight sync.
    pub async fn lock_desktop_sync(&self) -> OwnedMutexGuard<()> {
        Arc::clone(&self.desktop_sync_gate).lock_owned().await
    }

    /// 尝试进入「正在测试」。已在测试中时返回 false，用于挡住重复提交。
    pub fn begin_testing(&self) -> bool {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        if guard.shutting_down || guard.phase == Phase::Testing {
            return false;
        }
        guard.phase = Phase::Testing;
        guard.message = "正在测试代理…".into();
        guard.error_code = None;
        true
    }

    /// 测试成功，进入可打开状态并保存新会话。
    ///
    /// 旧会话在这里被拆掉，对应文档 5.3 的「改代理必须重建」。
    pub fn mark_ready_for(&self, assignment_revision: u64, session: Session) -> bool {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        if guard.shutting_down
            || !guard
                .desktop
                .as_ref()
                .is_some_and(|desktop| desktop.revision == assignment_revision)
        {
            session.adapter.stop();
            return false;
        }
        if let Some(old) = guard.session.take() {
            old.adapter.stop();
        }
        guard.phase = Phase::Ready;
        guard.message = "代理连接成功".into();
        guard.error_code = None;
        guard.session = Some(session);
        true
    }

    /// 测试或运行期间出错。会话一并拆除，避免留下半可用状态。
    pub fn mark_error(&self, message: String, code: Option<String>) {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        if let Some(old) = guard.session.take() {
            old.adapter.stop();
        }
        guard.phase = Phase::ProxyError;
        guard.message = message;
        guard.error_code = code;
    }

    /// Replace the server-controlled platform allowlist for one authenticated
    /// user. Proxy teardown is intentionally handled by the sync command so a
    /// validated response can be installed atomically with its new session.
    pub fn set_desktop_assignment(
        &self,
        user_id: i64,
        auth_generation: u64,
        profile_key: String,
        platforms: Vec<DesktopPlatform>,
    ) -> u64 {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        if guard.shutting_down {
            return 0;
        }
        guard.next_desktop_revision = guard.next_desktop_revision.wrapping_add(1).max(1);
        let revision = guard.next_desktop_revision;
        guard.desktop = Some(DesktopAssignment {
            user_id,
            auth_generation,
            revision,
            profile_key,
            platforms,
        });
        revision
    }

    pub fn desktop_assignment_matches(
        &self,
        user_id: i64,
        auth_generation: u64,
        revision: u64,
    ) -> bool {
        let guard = self.inner.lock().expect("状态锁已中毒");
        !guard.shutting_down
            && guard.desktop.as_ref().is_some_and(|desktop| {
                desktop.user_id == user_id
                    && desktop.auth_generation == auth_generation
                    && desktop.revision == revision
            })
    }

    /// Close only the assignment owned by the watchdog that detected an
    /// expired/revoked session. A stale watchdog cannot tear down a later login.
    pub fn invalidate_desktop_session(
        &self,
        user_id: i64,
        auth_generation: u64,
        revision: u64,
    ) -> bool {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        let matches = guard.desktop.as_ref().is_some_and(|desktop| {
            desktop.user_id == user_id
                && desktop.auth_generation == auth_generation
                && desktop.revision == revision
        });
        if !matches {
            return false;
        }
        if let Some(old) = guard.session.take() {
            old.adapter.stop();
        }
        guard.desktop = None;
        guard.phase = Phase::Unconfigured;
        guard.message = "登录已失效，代理和浏览器已关闭".into();
        guard.error_code = Some("unauthenticated".into());
        true
    }

    /// Stop a running route when the administrator changes/revokes its proxy
    /// or platform assignment. This does not log the user out; the UI can
    /// synchronize the new assignment explicitly.
    pub fn invalidate_desktop_configuration(
        &self,
        user_id: i64,
        auth_generation: u64,
        revision: u64,
    ) -> bool {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        let matches = guard.desktop.as_ref().is_some_and(|desktop| {
            desktop.user_id == user_id
                && desktop.auth_generation == auth_generation
                && desktop.revision == revision
        });
        if !matches {
            return false;
        }
        if let Some(old) = guard.session.take() {
            old.adapter.stop();
        }
        guard.desktop = None;
        guard.phase = Phase::Unconfigured;
        guard.message = "管理员已更新桌面配置，代理和浏览器已关闭，请重新同步".into();
        guard.error_code = Some("desktop_config_changed".into());
        true
    }

    /// Resolve a platform ID solely through the last server-synchronized
    /// allowlist. There is no manual URL or fallback-platform path.
    pub fn resolve_browser_launch(
        &self,
        user_id: i64,
        auth_generation: u64,
        auth_profile_key: Option<&str>,
        platform_id: i64,
    ) -> Option<BrowserLaunchInfo> {
        let guard = self.inner.lock().expect("状态锁已中毒");
        if guard.shutting_down {
            return None;
        }
        let session = guard.session.as_ref()?;
        let desktop = guard.desktop.as_ref()?;
        if desktop.user_id != user_id
            || desktop.auth_generation != auth_generation
            || auth_profile_key != Some(desktop.profile_key.as_str())
        {
            return None;
        }
        let target_url = desktop
            .platforms
            .iter()
            .find(|platform| platform.id == platform_id)?
            .url
            .clone();

        Some(BrowserLaunchInfo {
            target_url,
            port: session.adapter.port,
        })
    }

    /// Reserve one browser slot before spawning Chromium. Multiple slots may
    /// coexist, including several launches of the same platform.
    pub fn mark_browser_opened(&self) -> Option<u64> {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        if guard.shutting_down || !guard.phase.can_open_browser() || guard.session.is_none() {
            return None;
        }
        guard.next_browser_id = guard.next_browser_id.wrapping_add(1).max(1);
        let browser_id = guard.next_browser_id;
        if let Some(session) = guard.session.as_mut() {
            session.browser_ids.insert(browser_id);
        }
        guard.phase = Phase::BrowserRunning;
        guard.message = "独立代理浏览器运行中".into();
        Some(browser_id)
    }

    /// One managed Chromium process exited.
    pub fn mark_browser_closed_for(&self, browser_id: u64) {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        if let Some(session) = guard.session.as_mut() {
            if !session.browser_ids.remove(&browser_id) {
                return;
            }
        }
        let any_open = guard
            .session
            .as_ref()
            .is_some_and(|session| !session.browser_ids.is_empty());
        if guard.phase == Phase::BrowserRunning && !any_open {
            guard.phase = Phase::Ready;
            guard.message = "浏览器已关闭，代理配置仍然可用".into();
        }
    }

    /// 彻底拆除当前会话：停适配器、清出口 IP、回到未配置之外的安全态。
    pub fn teardown(&self) {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        if let Some(old) = guard.session.take() {
            old.adapter.stop();
        }
        guard.desktop = None;
        guard.phase = Phase::Unconfigured;
        guard.message = "已停止代理适配器".into();
        guard.error_code = None;
    }

    /// Permanently reject adapter/browser publication during process exit.
    pub fn shutdown(&self) {
        let mut guard = self.inner.lock().expect("状态锁已中毒");
        guard.shutting_down = true;
        if let Some(old) = guard.session.take() {
            old.adapter.stop();
        }
        guard.desktop = None;
        guard.phase = Phase::Unconfigured;
        guard.message = "客户端正在退出".into();
        guard.error_code = None;
    }

    #[cfg(test)]
    pub fn can_open_browser(&self) -> bool {
        let guard = self.inner.lock().expect("状态锁已中毒");
        guard.phase.can_open_browser() && guard.session.is_some()
    }

    pub fn snapshot(&self) -> StatusView {
        let guard = self.inner.lock().expect("状态锁已中毒");
        let browser_open = guard
            .session
            .as_ref()
            .is_some_and(|session| !session.browser_ids.is_empty());

        StatusView {
            phase: guard.phase,
            message: guard.message.clone(),
            browser_open,
            error_code: guard.error_code.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_ready_session(state: &AppState, user_id: i64) {
        let config = crate::config::validate(&crate::config::ProxyForm {
            host: "127.0.0.1".into(),
            port: "9".into(),
            username: "proxy-user".into(),
            password: "proxy-password".into(),
            probe_url: crate::config::DEFAULT_PROBE_URL.into(),
            bypass_hosts: Vec::new(),
        })
        .unwrap();
        let adapter = crate::rt::runtime()
            .block_on(crate::adapter::start(
                config.upstream(),
                config.direct_hosts.clone(),
            ))
            .unwrap();
        let revision = state.set_desktop_assignment(
            user_id,
            user_id as u64,
            format!("profile-{user_id}"),
            vec![DesktopPlatform {
                id: 1,
                name: "平台".into(),
                url: "https://platform.example.test/".into(),
                icon_url: None,
                sort_order: 0,
            }],
        );
        assert!(state.begin_testing());
        assert!(state.mark_ready_for(
            revision,
            Session {
                adapter,
                browser_ids: HashSet::new(),
            },
        ));
    }

    #[test]
    fn starts_unconfigured_and_blocks_browser() {
        let state = AppState::default();
        assert_eq!(state.snapshot().phase, Phase::Unconfigured);
        assert!(!state.can_open_browser());
    }

    #[test]
    fn testing_blocks_duplicate_submit() {
        let state = AppState::default();
        assert!(state.begin_testing());
        // 第二次必须被挡住
        assert!(!state.begin_testing());
        assert_eq!(state.snapshot().phase, Phase::Testing);
    }

    #[test]
    fn desktop_sync_gate_serializes_full_transactions() {
        let state = AppState::default();
        let first = crate::rt::runtime().block_on(state.lock_desktop_sync());
        assert!(state.desktop_sync_gate.clone().try_lock_owned().is_err());

        drop(first);
        assert!(state.desktop_sync_gate.clone().try_lock_owned().is_ok());
    }

    #[test]
    fn multiple_browser_tokens_are_independent_and_stale_exit_is_ignored() {
        let state = AppState::default();
        install_ready_session(&state, 7);
        let old_first = state.mark_browser_opened().unwrap();
        let old_second = state.mark_browser_opened().unwrap();
        state.mark_browser_closed_for(old_first);
        assert!(state.snapshot().browser_open);
        assert_eq!(state.snapshot().phase, Phase::BrowserRunning);

        state.teardown();
        install_ready_session(&state, 8);
        let current = state.mark_browser_opened().unwrap();

        // Delayed callbacks from either old process must not consume the new
        // user's browser token.
        state.mark_browser_closed_for(old_first);
        state.mark_browser_closed_for(old_second);
        assert!(state.snapshot().browser_open);
        assert_eq!(state.snapshot().phase, Phase::BrowserRunning);

        state.mark_browser_closed_for(current);
        assert!(!state.snapshot().browser_open);
        assert_eq!(state.snapshot().phase, Phase::Ready);
    }

    #[test]
    fn error_clears_session_and_blocks_browser() {
        let state = AppState::default();
        state.begin_testing();
        state.mark_error("代理账号或密码错误".into(), Some("auth_failed".into()));

        let view = state.snapshot();
        assert_eq!(view.phase, Phase::ProxyError);
        assert_eq!(view.error_code.as_deref(), Some("auth_failed"));
        assert!(!view.browser_open);
        assert!(!state.can_open_browser());
    }

    #[test]
    fn teardown_returns_to_unconfigured() {
        let state = AppState::default();
        state.begin_testing();
        state.teardown();
        assert_eq!(state.snapshot().phase, Phase::Unconfigured);
        assert!(!state.can_open_browser());
    }

    #[test]
    fn shutdown_permanently_rejects_new_runtime_publication() {
        let state = AppState::default();
        state.shutdown();

        assert!(!state.begin_testing());
        assert_eq!(
            state.set_desktop_assignment(
                7,
                1,
                "profile-7".into(),
                vec![DesktopPlatform {
                    id: 1,
                    name: "平台".into(),
                    url: "https://platform.example.test/".into(),
                    icon_url: None,
                    sort_order: 0,
                }],
            ),
            0
        );
        assert!(!state.can_open_browser());
        assert_eq!(state.snapshot().message, "客户端正在退出");
    }

    #[test]
    fn snapshot_never_exposes_password_field() {
        let state = AppState::default();
        let json = serde_json::to_string(&state.snapshot()).unwrap();
        assert!(!json.contains("password"));
    }
}
