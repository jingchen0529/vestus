//! 命令层的共享形态:错误类型、鉴权守卫、错误翻译、出口探测 URL。

use crate::auth::DesktopAuthState;
use crate::browser::BrowserError;

pub(crate) const NETWORK_IP_PATH: &str = "/api/network/ip";

/// 开发期覆盖出口检测地址的环境变量。只在 debug 构建生效。
#[cfg(all(debug_assertions, not(test)))]
pub(crate) const PROBE_URL_ENV: &str = "VESTUS_PROBE_URL";

/// 前端能看到的错误形态。
#[derive(Debug, Clone, serde::Serialize)]
pub struct CommandError {
    /// 可直接显示的中文提示
    pub message: String,
    /// 归类用短代码，前端据此区分样式
    pub code: String,
}

impl CommandError {
    pub(crate) fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: code.into(),
        }
    }
}

pub(crate) type CmdResult<T> = Result<T, CommandError>;

pub(crate) fn require_desktop_auth(auth: &tauri::State<'_, DesktopAuthState>) -> CmdResult<()> {
    if auth.is_authenticated() {
        Ok(())
    } else {
        Err(CommandError::new(
            "桌面登录已失效，请重新登录",
            "unauthenticated",
        ))
    }
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
pub(crate) fn network_probe_url(api_base: &str) -> String {
    #[cfg(all(debug_assertions, not(test)))]
    if let Ok(configured) = std::env::var(PROBE_URL_ENV) {
        let configured = configured.trim();
        if !configured.is_empty() {
            return configured.to_string();
        }
    }
    format!("{}{NETWORK_IP_PATH}", api_base.trim_end_matches('/'))
}

pub(crate) fn auth_command_error(error: crate::auth::DesktopAuthError) -> CommandError {
    CommandError::new(error.message, error.code)
}

/// 浏览器层的错误翻给前端。被别的进程占着单独给一个代码，前端据此提示用户去关那个
/// 浏览器，而不是让他反复重试。
pub(crate) fn browser_command_error(error: BrowserError) -> CommandError {
    let code = match error {
        BrowserError::ProfileBusy => "profile_busy",
        BrowserError::ProfileCheckFailed => "profile_check_failed",
        BrowserError::ProfileCleanup(_) => "profile_cleanup_failed",
        BrowserError::ProcessTermination(_) => "browser_termination_failed",
        _ => "browser_start",
    };
    CommandError::new(error.to_string(), code)
}
