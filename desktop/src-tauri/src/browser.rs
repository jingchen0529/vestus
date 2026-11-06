//! 外置 Chromium 多会话管理。
//!
//! Tauri 只做登录壳，业务网站交给随应用发布的 Chromium。普通手工环境持久保存；
//! 托管账号环境是一次性的，启动前及退出后都在同一跨进程 lease 内清空，失败禁止复用。
//! 环境按服务器、账号、平台、代理/直连隔离；目录与占用检查见 [`crate::profile`]。
//!
//! 起始网址作为命令行最后一个参数交给 Chromium 直接打开。
//!
//! # 一个环境一个进程
//!
//! Chromium 一个 user-data-dir 同时只允许一个进程：再起一个，它会把自己的命令行转交
//! 给已在运行的那个然后退出，自己带的开关全部作废。所以同一个环境已经开着时，「再
//! 打开一次」绝不另起进程，而是先查本实例的会话表，把已有的平台页面原样激活
//! （见 [`BrowserSessionManager::running_browser`] 与 commands 的复用分支）。不同平台、
//! 同一平台的代理与直连是不同的环境，照样各自独立运行。
//!
//! # 关闭
//!
//! 通常关闭先发 `Browser.close` 或 SIGTERM / WM_CLOSE，让普通持久环境落盘；到
//! [`GRACEFUL_CLOSE_TIMEOUT`] 才强杀。托管登出调用 [`BrowserSessionManager::kill_browser`]
//! 则不走任何优雅退出路径：仅强杀本次启动的进程组/Windows Job。两种路径都确认整个
//! 子树退出后才清理托管目录，再显式释放 lease；失败保留会话和 lease、禁止重开。
//! 用户自己关窗口也走同一个幂等 finalizer，因此旧监控线程不能删除后来新开的环境。
//!
//! # 调试端点
//!
//! 本模块**会**开 DevTools 端点（`--remote-debugging-port=0`），因为管理台要求
//! 记录客户在浏览器里访问了哪些页面、做了多少次操作，而这是唯一能同时拿到
//! 完整 URL 和页面内事件的通道；持久环境下的正常关闭也借它发一条 `Browser.close`。
//! 收敛措施：
//!
//! * 端口传 `0` 让内核分配，每次启动都换一个，只写在 profile 目录里的
//!   `DevToolsActivePort`；
//! * 不传 `--remote-debugging-address`，沿用 Chromium 只绑 127.0.0.1 的默认；
//! * 不传 `--remote-allow-origins`，所以带 `Origin` 头的请求（也就是被打开的
//!   网页自己发起的那些）会被 Chromium 直接拒绝，网页拿不到这个通道。
//!
//! 无法消除的残余风险：**本机同用户的其他进程**只要能读到 profile 目录就能连上
//! 这个端点。这是开调试端口的固有代价，接受它是记录页面级操作日志的前提。profile
//! 的位置现在是固定的，但这并没有让情况变坏：同用户进程以前也列得出临时目录，现在
//! 和以前一样本来就读得到 profile 里的 Cookie 库。
//!
//! 不用 `--incognito`：隐身模式和持久环境正好相反，还会限制站点的 localStorage/
//! IndexedDB，并让目标站点直接识别出隐身特征。
//! 启动里（见上文），正式启动一个环境时不带它。
//!
//! 窗口几何**总是**显式下发，从不使用 `--start-maximized`：后者要等窗口建好再
//! 最大化，这次 resize 和渲染器首帧存在竞态，在远程桌面/无独显的机器上会停在空白
//! 帧上（表现为内容区灰屏、刷新才恢复）。读不到显示器几何时用 [`FALLBACK_WINDOW`]
//! 兜底，而不是把这个开关加回来——恰恰是读不到显示器的那批机器（远程桌面、虚拟
//! 显卡）最容易踩上面那个竞态。
//!
//! # Windows：随包 Chromium 的沙箱权限
//!
//! Windows 上启动前必须确认 chromium 目录对沙箱 SID 可读可执行，见
//! [`ensure_sandbox_access`]。少了这个权限的表现极具误导性：浏览器窗口正常打开，
//! 进程也活着，但网络服务（跑在 LPAC 沙箱里）读不到自己的 chrome.exe 起不来，于是
//! **任何导航都提交不了**，窗口停在 about:blank——没有标题，也没有地址。
//!
//! 这个故障没有自证能力：我们这边拿不到任何错误，日志干净，代理和 CDP 全都正常，
//! 现场只能看到「白屏很久然后一个空窗口」。2026-09 排查过一次，从代理、CDP 采集、
//! 窗口几何一路查下去全是好的，最后靠隔离启动 Chromium 才看到
//! `Sandbox cannot access executable ... 拒绝访问 (0x5)`。
//!
//! 触发条件是安装目录继承不到那几个 SID：`C:\Program Files` 的默认 ACL 自带它们
//! （所以系统装的 Edge/Chrome 一切正常），而用户自选的目录——尤其是建在盘根下的
//! `D:\Vestus`——继承不到。安装器（`installer-hooks.nsh`）在装完时补一次，这里在
//! 每次启动前再补一次，覆盖「装的是老版本」和「目录被整体搬走」。
//!
//! # 沙箱逃生阀（`--no-sandbox`）
//!
//! 上面的 [`ensure_sandbox_access`] 是让沙箱**能用**。但有的机器上沙箱根本拉不
//! 起来，补权限也白搭：企业组策略禁掉了 AppContainer、安全软件拦截沙箱子进程、
//! 或者跑在本就不支持沙箱的受限/虚拟化环境里。症状和缺权限时一模一样——窗口开得
//! 出来，但任何导航都提交不了，停在白屏。
//!
//! 给这类机器留一个逃生阀：用户在「系统配置」里关掉沙箱，[`chromium_arguments`]
//! 就补一个 `--no-sandbox`。这会削弱浏览器的进程隔离，所以默认保留沙箱，只有确实
//! 打不开的机器才由用户主动关。这个开关是**本机偏好**（前端 localStorage 持久化），
//! 不随管理员的全局桌面配置下发。
//!
//! `--no-sandbox` 与代理正交：它只动沙箱，不碰 `--proxy-server`，关掉沙箱后代理
//! 链路逐字节不变。

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Runtime};

use crate::cdp;
use crate::profile::{self, ProfileSpec, DEVTOOLS_PORT_FILE};
use crate::rt;

mod process_tree;
use process_tree::OwnedProcess;

/// Isolated integration fixtures reuse OS process-tree ownership, not PID scans.
#[cfg(test)]
pub(crate) struct TestBrowserProcess(OwnedProcess);

#[cfg(test)]
impl TestBrowserProcess {
    pub(crate) fn spawn(command: &mut Command) -> std::io::Result<Self> {
        OwnedProcess::spawn(command).map(Self)
    }

    pub(crate) fn id(&self) -> u32 {
        self.0.id()
    }

    pub(crate) fn has_exited(&self) -> std::io::Result<bool> {
        self.0.has_exited()
    }

    pub(crate) fn terminate(&mut self) -> std::io::Result<()> {
        self.0.terminate()
    }
}

#[cfg(any(debug_assertions, test))]
const CHROMIUM_PATH_ENV: &str = "VESTUS_CHROMIUM_PATH";
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Chromium 写 `DevToolsActivePort` 的等待上限。超时就放弃采集，浏览器照常用。
const DEVTOOLS_PORT_TIMEOUT: Duration = Duration::from_secs(20);
const DEVTOOLS_PORT_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// 只认这次启动之后写出的 `DevToolsActivePort`；留一点余量给文件系统时间戳的粒度。
const DEVTOOLS_PORT_CLOCK_SLACK: Duration = Duration::from_secs(2);
/// 主动关闭时，从请 Chromium 退出到强杀之间最多等多久。正常退出一两秒就完，这里是
/// 它被卡住时的上限——登出、切换账号和退出应用都在等它。
const GRACEFUL_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(100);
/// 低于这个边长的工作区当作读数异常，退回 [`FALLBACK_WINDOW`]。
const MIN_WINDOW_EDGE: u32 = 320;
type ProcessSlot = Arc<Mutex<Option<OwnedProcess>>>;
/// 读到之前是 `None`；读不到（超时或进程先没了）也一直是 `None`。
type EndpointSlot = Arc<Mutex<Option<DevToolsEndpoint>>>;
type BrowserCloseEntry = (u64, Arc<ManagedBrowser>);

/// 一个 Chromium 进程的 browser 级 DevTools 入口。
///
/// 用 browser 级而不是 page 级：只有它能 `Target.setAutoAttach`，从而覆盖用户
/// 后开的标签页和弹窗；page 级连接只看得到建立连接时那一个页面。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevToolsEndpoint {
    pub port: u16,
    /// `DevToolsActivePort` 第二行，形如 `/devtools/browser/<uuid>`。
    pub browser_path: String,
}

impl DevToolsEndpoint {
    pub fn websocket_url(&self) -> String {
        format!("ws://127.0.0.1:{}{}", self.port, self.browser_path)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("无法定位应用资源目录：{0}")]
    ResourceDirectory(String),
    #[cfg(any(debug_assertions, test))]
    #[error("{CHROMIUM_PATH_ENV} 必须指向一个绝对的 Chromium 可执行文件路径")]
    InvalidOverride,
    #[error("未找到可用的 Chromium。请确认安装包包含浏览器资源")]
    ChromiumMissing,
    #[error("无法准备浏览器环境目录：{0}")]
    ProfileDirectory(String),
    #[error("浏览器环境正在使用或重置（另一个客户端正在启动、使用或重置环境，或上次异常退出后残留的浏览器仍未关闭），请稍后重试；若浏览器仍在使用，请先关闭它")]
    ProfileBusy,
    #[error("无法确认浏览器环境是否被占用，已停止操作以保护现有数据。请关闭相关浏览器后重试；如仍失败，请联系管理员检查系统进程查询和目录访问权限")]
    ProfileCheckFailed,
    #[error("无法清理托管浏览器环境，已禁止复用旧登录态：{0}")]
    ProfileCleanup(String),
    #[error("无法确认本次浏览器进程树已全部退出，环境保持锁定：{0}")]
    ProcessTermination(String),
    #[error("这个平台的浏览器已经在运行")]
    AlreadyRunning,
    #[error("无法启动 Chromium：{0}")]
    Spawn(String),
    #[error("客户端正在退出，不能再启动浏览器")]
    ShuttingDown,
}

impl From<profile::ProfileCheckError> for BrowserError {
    fn from(error: profile::ProfileCheckError) -> Self {
        match error {
            profile::ProfileCheckError::Busy => Self::ProfileBusy,
            profile::ProfileCheckError::Unknown => Self::ProfileCheckFailed,
        }
    }
}

impl From<profile::ProfileCleanupError> for BrowserError {
    fn from(error: profile::ProfileCleanupError) -> Self {
        match error {
            profile::ProfileCleanupError::Check(error) => error.into(),
            profile::ProfileCleanupError::Io(message) => Self::ProfileCleanup(message),
        }
    }
}

#[derive(Clone)]
pub struct BrowserSessionManager {
    inner: Arc<BrowserSessionInner>,
}

struct BrowserSessionInner {
    accepting_launches: AtomicBool,
    sessions: Mutex<HashMap<u64, Arc<ManagedBrowser>>>,
}

struct ManagedBrowser {
    process: ProcessSlot,
    profile_dir: PathBuf,
    endpoint: EndpointSlot,
    ephemeral: bool,
    closing: AtomicBool,
    /// Serializes every exit path. The sole lease is released explicitly only
    /// after all owned processes and profile cleanup have completed, never by a
    /// delayed monitor/callback dropping an extra lease Arc.
    finish: Mutex<BrowserFinish>,
    /// A failed finalizer is not a closed session. The monitor waits here for a
    /// successful retry rather than firing on_exit or repeatedly deleting.
    finished: Condvar,
}

/// The session's sole exit barrier: exactly one lease, released only after all
/// owned processes are gone and profile cleanup has succeeded.
struct BrowserFinish {
    lease: Option<profile::ProfileLease>,
}

/// 解析好的一次启动：用哪个 Chromium、开哪个环境，是否必须用完删除。
pub struct PreparedProfile {
    executable: PathBuf,
    dir: PathBuf,
    ephemeral: bool,
}

impl PreparedProfile {
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// 启动时直接下发给 Chromium 的窗口几何。
///
/// Chromium 的 `--window-position` / `--window-size` 按逻辑像素解释，所以这里
/// 存的是已经除过显示器缩放比的值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// 读不到可信的显示器几何时下发的窗口。
///
/// 取一个在任何还能跑这套系统的屏幕上都画得出来的尺寸。它在大屏上偏小，但用户点
/// 一下最大化就好了；`--start-maximized` 换来的灰屏用户没法自己解决。
const FALLBACK_WINDOW: WindowGeometry = WindowGeometry {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
};

/// 兜底窗口不能大到超出老机器的屏幕——那是另一种「用户自己解决不了」。编译期钉住。
const _: () = assert!(FALLBACK_WINDOW.width <= 1280 && FALLBACK_WINDOW.height <= 800);

struct LaunchProcessRequest<'a> {
    session_id: u64,
    executable: &'a Path,
    profile_dir: PathBuf,
    ephemeral: bool,
    #[cfg(test)]
    extra_arguments: &'a [&'a str],
    local_proxy: Option<&'a str>,
    target_url: &'a str,
    window: Option<WindowGeometry>,
    /// 关掉浏览器沙箱（追加 `--no-sandbox`）。给沙箱拉不起来的机器留的逃生阀，
    /// 见模块文档「沙箱逃生阀」。与代理正交。
    disable_sandbox: bool,
}

impl Default for BrowserSessionManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(BrowserSessionInner {
                accepting_launches: AtomicBool::new(true),
                sessions: Mutex::new(HashMap::new()),
            }),
        }
    }
}

impl BrowserSessionManager {
    /// 解析一个环境：定位 Chromium，算出它的持久 profile 目录。
    ///
    /// 这里只算路径；目录在拿到跨进程锁后才创建。是复用还是新起进程，由
    /// 调用方拿 [`Self::running_browser`] 决定。
    pub fn prepare_profile<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        spec: &ProfileSpec<'_>,
    ) -> Result<PreparedProfile, BrowserError> {
        let (executable, root) = resolve_executable_and_root(app)?;
        let dir = profile::profile_dir(&root, spec);
        Ok(PreparedProfile {
            executable,
            dir,
            ephemeral: profile::is_managed_profile_key(spec.profile_key),
        })
    }

    /// 持久环境的根目录（供启动清扫定位残留的托管 profile）。
    ///
    /// 解析不出可用浏览器时为 `None`：没有浏览器就无所谓残留。
    pub fn profiles_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
        resolve_executable_and_root(app).ok().map(|(_, root)| root)
    }

    /// 一个账号在本机全部环境所在的目录（按这次会用的 Chromium 解析根目录）。
    pub fn account_profiles_dir<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        api_base: &str,
        profile_key: &str,
    ) -> Result<PathBuf, BrowserError> {
        let (_, root) = resolve_executable_and_root(app)?;
        Ok(profile::account_dir(&root, api_base, profile_key))
    }

    /// 这个环境是否有一个本实例托管、仍在运行的进程；有就返回它的会话号。
    pub fn running_browser(&self, profile_dir: &Path) -> Option<u64> {
        let sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
        live_session_on(&sessions, profile_dir)
    }

    /// 一个运行中会话的调试端点。端点还没读到（进程刚起，或端口一直没等到）时是
    /// `None`，调用方退回命令行转交。
    pub fn session_endpoint(&self, session_id: u64) -> Option<DevToolsEndpoint> {
        let sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
        sessions
            .get(&session_id)
            .and_then(|session| session.endpoint.lock().expect("调试端点锁已中毒").clone())
    }

    /// A monitor disconnect during an intentional close is not a guard failure.
    /// Unknown process status is kept live so a failed guard still forces cleanup.
    pub(crate) fn is_running(&self, session_id: u64) -> bool {
        let session = self
            .inner
            .sessions
            .lock()
            .expect("浏览器会话锁已中毒")
            .get(&session_id)
            .cloned();
        session.is_some_and(|session| {
            !session.closing.load(Ordering::Acquire)
                && !matches!(process_exit_status(&session.process), Ok(true))
        })
    }

    /// Start one Chromium process on a persistent profile.
    ///
    /// `on_ready` fires once the DevTools endpoint is readable; `on_exit` fires
    /// only after the owned tree is gone and protected cleanup succeeded. Both
    /// run on the monitor thread. A failed close keeps the lease and parks its
    /// notification until a later successful retry (without blocking kill).
    #[allow(clippy::too_many_arguments)]
    pub fn launch<R, F, G>(
        &self,
        app: &AppHandle<R>,
        session_id: u64,
        profile: PreparedProfile,
        local_proxy: Option<&str>,
        target_url: &str,
        disable_sandbox: bool,
        on_ready: G,
        on_exit: F,
    ) -> Result<u64, BrowserError>
    where
        R: Runtime,
        F: FnOnce() + Send + 'static,
        G: FnOnce(DevToolsEndpoint) + Send + 'static,
    {
        if !self.inner.accepting_launches.load(Ordering::Acquire) {
            return Err(BrowserError::ShuttingDown);
        }
        let window = primary_window_geometry(app);
        self.launch_process_with_hook(
            LaunchProcessRequest {
                session_id,
                executable: &profile.executable,
                profile_dir: profile.dir,
                ephemeral: profile.ephemeral,
                #[cfg(test)]
                extra_arguments: &[],
                local_proxy,
                target_url,
                window,
                disable_sandbox,
            },
            on_ready,
            on_exit,
            || {},
        )
    }

    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn launch_process<F, G>(
        &self,
        session_id: u64,
        executable: &Path,
        profile_dir: PathBuf,
        local_proxy: Option<&str>,
        target_url: &str,
        window: Option<WindowGeometry>,
        disable_sandbox: bool,
        on_ready: G,
        on_exit: F,
    ) -> Result<u64, BrowserError>
    where
        F: FnOnce() + Send + 'static,
        G: FnOnce(DevToolsEndpoint) + Send + 'static,
    {
        self.launch_process_with_hook(
            LaunchProcessRequest {
                session_id,
                executable,
                ephemeral: profile_dir
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(profile::is_managed_environment_name),
                profile_dir,
                extra_arguments: &[],
                local_proxy,
                target_url,
                window,
                disable_sandbox,
            },
            on_ready,
            on_exit,
            || {},
        )
    }

    fn launch_process_with_hook<F, G, H>(
        &self,
        request: LaunchProcessRequest<'_>,
        on_ready: G,
        on_exit: F,
        on_launch_lock: H,
    ) -> Result<u64, BrowserError>
    where
        F: FnOnce() + Send + 'static,
        G: FnOnce(DevToolsEndpoint) + Send + 'static,
        H: FnOnce(),
    {
        let LaunchProcessRequest {
            session_id,
            executable,
            profile_dir,
            ephemeral,
            #[cfg(test)]
            extra_arguments,
            local_proxy,
            target_url,
            window,
            disable_sandbox,
        } = request;
        if !self.inner.accepting_launches.load(Ordering::Acquire) {
            return Err(BrowserError::ShuttingDown);
        }
        if self.running_browser(&profile_dir).is_some() {
            return Err(BrowserError::AlreadyRunning);
        }
        // This exact lease protects cold cleanup, spawn, the complete process
        // tree, and final cleanup. A caller never wipes/reacquires it later.
        let lease = profile::acquire_profile_lease(&profile_dir)?;
        if ephemeral {
            lease.clear_managed_profile()?;
        }
        create_private_dir(&profile_dir)?;
        profile::prepare_for_launch(&profile_dir).map_err(BrowserError::from)?;
        let arguments = chromium_arguments(
            &profile_dir,
            local_proxy,
            target_url,
            window,
            disable_sandbox,
        );
        #[cfg(test)]
        let arguments = {
            let mut arguments = arguments;
            let url = arguments.pop();
            arguments.extend(extra_arguments.iter().map(OsString::from));
            arguments.extend(url);
            arguments
        };
        let mut command = chromium_command(executable, arguments);
        let endpoint: EndpointSlot = Arc::new(Mutex::new(None));
        let launched_at = SystemTime::now();
        // Publishing and spawning remain one critical section with shutdown.
        let session = {
            let mut sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
            if !self.inner.accepting_launches.load(Ordering::Acquire) {
                return Err(BrowserError::ShuttingDown);
            }
            if sessions.contains_key(&session_id)
                || live_session_on(&sessions, &profile_dir).is_some()
            {
                return Err(BrowserError::AlreadyRunning);
            }
            on_launch_lock();
            let child = OwnedProcess::spawn(&mut command)
                .map_err(|error| BrowserError::Spawn(error.to_string()))?;
            let session = Arc::new(ManagedBrowser {
                process: Arc::new(Mutex::new(Some(child))),
                profile_dir: profile_dir.clone(),
                endpoint: Arc::clone(&endpoint),
                ephemeral,
                closing: AtomicBool::new(false),
                finish: Mutex::new(BrowserFinish { lease: Some(lease) }),
                finished: Condvar::new(),
            });
            sessions.insert(session_id, Arc::clone(&session));
            session
        };

        let manager = self.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("vestus-browser-{session_id}"))
            .spawn({
                let session = Arc::clone(&session);
                move || {
                    if let Some(ready) =
                        read_devtools_endpoint(&profile_dir, &session.process, launched_at)
                    {
                        if !session.closing.load(Ordering::Acquire) {
                            *endpoint.lock().expect("调试端点锁已中毒") = Some(ready.clone());
                            on_ready(ready);
                        }
                    }
                    wait_for_process_exit(&session.process);
                    // The same serial finalizer is used by kill/close and the
                    // monitor. It cannot delete a later session's directory.
                    manager.finish_and_notify(session_id, &session, on_exit);
                }
            })
        {
            self.finish_session(session_id, &session)?;
            return Err(BrowserError::Spawn(format!(
                "无法创建浏览器监控线程：{error}"
            )));
        }
        Ok(session_id)
    }

    /// Close every Chromium process owned by this desktop session. Ordinary
    /// profiles keep graceful persistence; managed directories are erased by
    /// the lifecycle finalizer before their leases are released.
    pub async fn close_all(&self) -> usize {
        let sessions = self.closing_sessions(true, |_| true, false);
        let count = sessions.len();
        self.close_gracefully(sessions).await;
        count
    }

    /// No Browser.close, SIGTERM or WM_CLOSE: kill this session's owned tree,
    /// verify exit, then finish protected cleanup. Failure retains the session
    /// and lease and cannot be reused by running_browser or a cold launch.
    pub fn kill_browser(&self, session_id: u64) -> Result<bool, BrowserError> {
        let Some(session) = self.closing_session(session_id) else {
            return Ok(false);
        };
        self.finish_session(session_id, &session)?;
        Ok(true)
    }

    /// Retire only older versions in this exact managed account/platform/mode.
    pub async fn close_managed_profile_versions(
        &self,
        account_dir: &Path,
        platform_id: i64,
        direct_mode: bool,
        managed_account_id: u64,
        keep_profile: &Path,
    ) -> usize {
        let sessions = self.closing_sessions(
            true,
            |session| {
                session.ephemeral
                    && session.profile_dir != keep_profile
                    && profile::is_managed_profile_for(
                        account_dir,
                        &session.profile_dir,
                        platform_id,
                        direct_mode,
                        managed_account_id,
                    )
            },
            false,
        );
        let count = sessions.len();
        self.close_gracefully(sessions).await;
        count
    }

    /// Permanently reject launches before taking a close snapshot. Failed
    /// finalizers stay in the table holding their lease; shutdown never treats
    /// an unverified termination as a successful release.
    pub fn shutdown(&self) -> usize {
        let sessions = self.closing_sessions(true, |_| true, true);
        let count = sessions.len();
        if tokio::runtime::Handle::try_current().is_ok() {
            for (id, session) in sessions {
                if let Err(error) = self.finish_session(id, &session) {
                    eprintln!("browser shutdown failed for {id}: {error}");
                }
            }
        } else if count > 0 {
            rt::runtime().block_on(self.close_gracefully(sessions));
        }
        count
    }

    fn closing_session(&self, session_id: u64) -> Option<Arc<ManagedBrowser>> {
        let sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
        let session = Arc::clone(sessions.get(&session_id)?);
        session.closing.store(true, Ordering::Release);
        Some(session)
    }

    fn closing_sessions(
        &self,
        include_closing: bool,
        mut matches: impl FnMut(&ManagedBrowser) -> bool,
        stop_accepting: bool,
    ) -> Vec<BrowserCloseEntry> {
        let sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
        if stop_accepting {
            self.inner
                .accepting_launches
                .store(false, Ordering::Release);
        }
        sessions
            .iter()
            .filter(|(_, session)| matches(session))
            .filter_map(|(id, session)| {
                let was_closing = session.closing.swap(true, Ordering::AcqRel);
                (include_closing || !was_closing).then(|| (*id, Arc::clone(session)))
            })
            .collect()
    }

    async fn close_gracefully(&self, sessions: Vec<BrowserCloseEntry>) {
        let deadline = tokio::time::Instant::now() + GRACEFUL_CLOSE_TIMEOUT;
        let tasks = sessions
            .into_iter()
            .map(|(id, session)| {
                let manager = self.clone();
                rt::runtime().spawn(async move {
                    close_one(&session, deadline).await;
                    // Termination and filesystem retries must not block a runtime
                    // worker, and must not depend on on_ready/on_exit returning.
                    let result =
                        tokio::task::spawn_blocking(move || manager.finish_session(id, &session))
                            .await;
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => eprintln!("browser close failed for {id}: {error}"),
                        Err(error) => eprintln!("browser close task failed for {id}: {error}"),
                    }
                })
            })
            .collect::<Vec<_>>();
        for task in tasks {
            let _ = task.await;
        }
    }

    fn finish_and_notify(
        &self,
        session_id: u64,
        session: &Arc<ManagedBrowser>,
        on_exit: impl FnOnce(),
    ) {
        if let Err(error) = self.finish_session(session_id, session) {
            eprintln!("browser session {session_id} cleanup failed: {error}");
            // Keep the monitor callback (including the caller's exit signal)
            // alive but do not claim the browser is closed. The mutex guards
            // both the predicate and notification, so a fast retry cannot be
            // lost between this failed attempt and going to sleep.
            let finish = session.finish.lock().expect("浏览器结束锁已中毒");
            let finish = session
                .finished
                .wait_while(finish, |finish| finish.lease.is_some())
                .expect("浏览器结束锁已中毒");
            drop(finish);
        }
        // Never invoke caller state bookkeeping while holding lifecycle locks.
        on_exit();
    }

    fn finish_session(
        &self,
        session_id: u64,
        session: &Arc<ManagedBrowser>,
    ) -> Result<(), BrowserError> {
        session.closing.store(true, Ordering::Release);
        let mut finish = session.finish.lock().expect("浏览器结束锁已中毒");
        if finish.lease.is_none() {
            return Ok(());
        }
        // Stop the owned process tree before cleanup. A failed termination
        // retains the lease (ProcessTermination) so a retry can finish the
        // job instead of unlocking a live browser.
        stop_process(&session.process)?;
        if session.ephemeral {
            finish
                .lease
                .as_ref()
                .expect("lease checked above")
                .clear_managed_profile()?;
        }
        let mut sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
        if sessions
            .get(&session_id)
            .is_some_and(|current| Arc::ptr_eq(current, session))
        {
            sessions.remove(&session_id);
        }
        // Explicit completion point. The monitor Arc may still exist, but it
        // holds no extra lease and cannot clean this directory again.
        drop(finish.lease.take());
        session.finished.notify_all();
        Ok(())
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.inner
            .sessions
            .lock()
            .expect("浏览器会话锁已中毒")
            .len()
    }
}

/// 表里开着这个环境、而且进程还活着的那个会话。
///
/// 进程已经退出、只是监视线程还没来得及摘掉的会话不算：否则用户关掉浏览器后马上再点，
/// 会被当成「已经在运行」挡回去。
fn live_session_on(
    sessions: &HashMap<u64, Arc<ManagedBrowser>>,
    profile_dir: &Path,
) -> Option<u64> {
    sessions
        .iter()
        .find(|(_, session)| {
            session.profile_dir == profile_dir
                && !session.closing.load(Ordering::Acquire)
                && matches!(process_exit_status(&session.process), Ok(false))
        })
        .map(|(session_id, _)| *session_id)
}

/// Poll the profile for Chromium's `DevToolsActivePort` until it parses.
///
/// Returns `None` when the process dies first or the wait times out. Both are
/// non-fatal: the browser is fully usable without a telemetry channel, so a
/// failure here must never surface to the user as a launch error.
fn read_devtools_endpoint(
    profile_dir: &Path,
    process: &ProcessSlot,
    launched_at: SystemTime,
) -> Option<DevToolsEndpoint> {
    let deadline = SystemTime::now() + DEVTOOLS_PORT_TIMEOUT;
    let port_file = profile_dir.join(DEVTOOLS_PORT_FILE);
    let not_before = launched_at
        .checked_sub(DEVTOOLS_PORT_CLOCK_SLACK)
        .unwrap_or(launched_at);
    loop {
        if let Some(endpoint) = read_fresh_port_file(&port_file, not_before) {
            return Some(endpoint);
        }
        if process_has_exited(process) || SystemTime::now() >= deadline {
            return None;
        }
        thread::sleep(DEVTOOLS_PORT_POLL_INTERVAL);
    }
}

/// 只认这次启动之后写出来的端口文件。
///
/// 启动前已经删过上一次运行留下的那份（[`profile::prepare_for_launch`]），但删除可能
/// 失败——Windows 上杀毒软件正好开着它就删不掉。旧文件指向一个早已关闭、甚至已经换了
/// 主人的端口，连上去轻则没有采集，重则把控制命令发给别的程序。
fn read_fresh_port_file(port_file: &Path, not_before: SystemTime) -> Option<DevToolsEndpoint> {
    let modified = std::fs::metadata(port_file)
        .and_then(|meta| meta.modified())
        .ok()?;
    if modified < not_before {
        return None;
    }
    parse_devtools_active_port(&std::fs::read_to_string(port_file).ok()?)
}

/// Ask politely, but leave the ownership barrier/final cleanup to the common
/// finalizer. A monitor can finish concurrently without releasing a live tree.
async fn close_one(session: &ManagedBrowser, deadline: tokio::time::Instant) {
    if process_has_exited(&session.process) {
        return;
    }
    let endpoint = session.endpoint.lock().expect("调试端点锁已中毒").clone();
    let asked = match &endpoint {
        Some(endpoint) => cdp::request_exit(endpoint).await.is_ok(),
        None => false,
    };
    if !asked {
        request_polite_exit(&session.process);
    }
    while !process_has_exited(&session.process) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(CLOSE_POLL_INTERVAL).await;
    }
}

fn request_polite_exit(process: &ProcessSlot) {
    let guard = process.lock().expect("浏览器进程锁已中毒");
    if let Some(child) = guard.as_ref() {
        child.request_polite_exit();
    }
}

/// Spawn configuration for real launches: no stdio, and run from the browser's
/// own directory.
fn chromium_command(executable: &Path, arguments: Vec<OsString>) -> Command {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(directory) = executable.parent() {
        command.current_dir(directory);
    }
    command
}

/// Observe parent exit without releasing its OS identity. On Unix waitid uses
/// WNOWAIT so the process-group leader cannot be recycled before tree cleanup.
fn process_exit_status(process: &ProcessSlot) -> std::io::Result<bool> {
    let guard = process.lock().expect("浏览器进程锁已中毒");
    match guard.as_ref() {
        Some(child) => child.has_exited(),
        None => Ok(true),
    }
}

fn process_has_exited(process: &ProcessSlot) -> bool {
    matches!(process_exit_status(process), Ok(true))
}

/// `DevToolsActivePort` is two lines: the port, then the browser WebSocket path.
///
/// Chromium creates the file before finishing the write, so a torn read is
/// normal rather than exceptional -- every field is validated and a partial file
/// simply yields `None` so the caller polls again.
pub(crate) fn parse_devtools_active_port(contents: &str) -> Option<DevToolsEndpoint> {
    let mut lines = contents.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    if port == 0 {
        return None;
    }
    let browser_path = lines.next()?.trim();
    // Only the shape Chromium documents. Anything else means a torn or foreign
    // file, and this string goes straight into a URL we then connect to.
    if !browser_path.starts_with("/devtools/browser/")
        || browser_path.len() > 200
        || !browser_path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_'))
    {
        return None;
    }
    Some(DevToolsEndpoint {
        port,
        browser_path: browser_path.to_string(),
    })
}

fn wait_for_process_exit(process: &ProcessSlot) {
    while matches!(process_exit_status(process), Ok(false)) {
        thread::sleep(PROCESS_POLL_INTERVAL);
    }
}

fn stop_process(process: &ProcessSlot) -> Result<(), BrowserError> {
    let mut guard = process.lock().expect("浏览器进程锁已中毒");
    if let Some(child) = guard.as_mut() {
        // Do not take/drop the process (or release its owning lease) before a
        // verified tree-wide termination. Failure remains available for retry.
        child
            .terminate()
            .map_err(|error| BrowserError::ProcessTermination(error.to_string()))?;
        guard.take();
    }
    Ok(())
}

/// 建环境目录。Unix 上只给当前用户权限：profile 里是各平台的登录态。
fn create_private_dir(dir: &Path) -> Result<(), BrowserError> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|error| BrowserError::ProfileDirectory(error.to_string()))
}

/// 这次会用的 Chromium，以及它对应的持久环境根目录。
fn resolve_executable_and_root<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(PathBuf, PathBuf), BrowserError> {
    let (executable, bundled) = resolve_chromium_executable(app)?;
    let local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|error| BrowserError::ProfileDirectory(error.to_string()))?;
    let root = profile::profiles_root(&local_data, &executable, bundled);
    Ok((executable, root))
}

/// 该给哪个目录补沙箱权限：随包的那份返回 chromium 目录，其他情况返回 `None`。
///
/// 返回的是 chromium 目录整棵树，而不是可执行文件所在的那一层——macOS 上后者是
/// `<浏览器>.app/Contents/MacOS`，深了三层，补在那里对沙箱没用。
///
/// dev 里回退到的系统 Chrome 装在 Program Files（或 /Applications）下，权限本来
/// 就是对的，去改它既没必要也越界，所以必须先确认这个可执行文件真的在我们自己
/// 铺的资源目录里。
fn sandbox_fixup_root<'a>(executable: &Path, bundled_root: &'a Path) -> Option<&'a Path> {
    executable.starts_with(bundled_root).then_some(bundled_root)
}

/// 给随包 Chromium 目录补齐沙箱要的读取执行权限，每个进程只做一次。
///
/// 正常情况下这件事由安装器（`installer-hooks.nsh`）做完了，这里是第二道：
///
/// * 安装器那次 `icacls` 失败过（权限不够、目录被占用）；
/// * 用户把安装目录整个搬到了别的盘，ACL 没跟着走；
/// * 装的是加这个 hook 之前的版本，重装之前一直是坏的。
///
/// 少了这些权限的后果不是「浏览器打不开」而是**打得开但导航永远提交不了**：
/// Chromium 的网络服务跑在 LPAC 沙箱里，读不到自己的 chrome.exe 就起不来
/// （`Sandbox cannot access executable` / `拒绝访问 (0x5)`），窗口停在
/// about:blank，没有标题也没有地址。浏览器进程活着，所以这边完全看不出异常。
///
/// 失败**不阻止**启动：多数机器上权限本来就是对的，这里报错更可能是我们判断错了
/// 而不是浏览器真的不能用。SID 用数字写法，中文 Windows 上按名字授权会失败。
#[cfg(target_os = "windows")]
fn ensure_sandbox_access(chromium_dir: &Path) {
    use std::os::windows::process::CommandExt;
    use std::sync::Once;

    /// 不要让 icacls 闪出一个控制台窗口。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    static ONCE: Once = Once::new();

    ONCE.call_once(|| {
        // S-1-15-2-1 ALL APPLICATION PACKAGES（普通 AppContainer 令牌带它）
        // S-1-15-2-2 ALL RESTRICTED APPLICATION PACKAGES（LPAC 令牌带它，且**不**带
        //            S-1-15-2-1，所以两个都要给）
        // S-1-5-12   RESTRICTED（渲染器受限令牌的 restricting SID）
        // 只给 RX：沙箱进程要读自己的程序文件，不需要写它。
        //
        // 用绝对路径而不是裸 "icacls"：CreateProcess 的搜索顺序把**当前进程所在
        // 目录**排在系统目录前面，安装目录里放一个 icacls.exe 就能劫持这次调用。
        // 这个目录恰恰是普通用户可写的（currentUser 安装模式）。
        let icacls = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
            .join("System32")
            .join("icacls.exe");
        let _ = Command::new(icacls)
            .arg(chromium_dir)
            .args([
                "/grant",
                "*S-1-15-2-1:(OI)(CI)RX",
                "*S-1-15-2-2:(OI)(CI)RX",
                "*S-1-5-12:(OI)(CI)RX",
                "/T",
                "/C",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    });
}

#[cfg(not(target_os = "windows"))]
fn ensure_sandbox_access(_chromium_dir: &Path) {}

/// 定位这次要启动的 Chromium。第二个返回值表示它是不是随包的那份——持久环境的根目录
/// 按它分开，见 [`profile::profiles_root`]。
fn resolve_chromium_executable<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(PathBuf, bool), BrowserError> {
    #[cfg(any(debug_assertions, test))]
    {
        if let Some(raw) = std::env::var_os(CHROMIUM_PATH_ENV) {
            let path = PathBuf::from(raw);
            if !path.is_absolute() || !path.is_file() {
                return Err(BrowserError::InvalidOverride);
            }
            return Ok((path, false));
        }
    }

    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| BrowserError::ResourceDirectory(error.to_string()))?;
    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    {
        candidates.push(resources.join("chromium").join("chrome.exe"));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(resources.join("chromium").join("chrome"));
    }

    #[cfg(target_os = "macos")]
    {
        candidates.extend(bundled_macos_executables(&resources.join("chromium")));
        #[cfg(any(debug_assertions, test))]
        {
            candidates.push(PathBuf::from(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ));
            candidates.push(PathBuf::from(
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ));
        }
    }

    let executable = candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or(BrowserError::ChromiumMissing)?;

    let bundled_root = resources.join("chromium");
    let bundled_fixup = sandbox_fixup_root(&executable, &bundled_root);
    let bundled = bundled_fixup.is_some();
    if let Some(root) = bundled_fixup {
        ensure_sandbox_access(root);
    }
    Ok((executable, bundled))
}

/// 随包 macOS 浏览器的候选可执行文件。
///
/// Playwright 会随版本改这个 bundle 的名字（`Chromium.app` →
/// `Google Chrome for Testing.app`），所以扫描资源目录里的 `.app` 而不是把名字
/// 写死；`desktop/scripts/prepare-chromium.mjs` 保证目录里只放一个 `.app`。
#[cfg(target_os = "macos")]
fn bundled_macos_executables(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut executables = Vec::new();
    for entry in entries.flatten() {
        let bundle = entry.path();
        if bundle.extension().and_then(|extension| extension.to_str()) != Some("app") {
            continue;
        }
        if let Ok(files) = std::fs::read_dir(bundle.join("Contents").join("MacOS")) {
            executables.extend(
                files
                    .flatten()
                    .map(|file| file.path())
                    .filter(|path| path.is_file()),
            );
        }
    }
    // 目录遍历顺序由文件系统决定；排序保证同一份资源每次都启动同一个进程。
    executables.sort();
    executables
}

/// 主显示器的工作区几何，拿不到就返回 None，由调用方用 [`FALLBACK_WINDOW`] 兜底。
fn primary_window_geometry<R: Runtime>(app: &AppHandle<R>) -> Option<WindowGeometry> {
    let monitor = app.primary_monitor().ok().flatten()?;
    let area = monitor.work_area();
    window_geometry(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
        monitor.scale_factor(),
    )
}

/// 把物理像素的工作区换算成 Chromium 要的逻辑像素。
///
/// 缩放比或尺寸读数不可信时返回 None——错的几何比没有几何更糟，宁可退回
/// [`FALLBACK_WINDOW`]。
fn window_geometry(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Option<WindowGeometry> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return None;
    }
    let logical_width = (f64::from(width) / scale_factor).round();
    let logical_height = (f64::from(height) / scale_factor).round();
    if logical_width < f64::from(MIN_WINDOW_EDGE) || logical_height < f64::from(MIN_WINDOW_EDGE) {
        return None;
    }
    Some(WindowGeometry {
        x: (f64::from(x) / scale_factor).round() as i32,
        y: (f64::from(y) / scale_factor).round() as i32,
        width: logical_width as u32,
        height: logical_height as u32,
    })
}

fn chromium_arguments(
    profile_dir: &Path,
    local_proxy: Option<&str>,
    target_url: &str,
    window: Option<WindowGeometry>,
    disable_sandbox: bool,
) -> Vec<OsString> {
    // 占用检测按这个参数去认进程，所以必须和 profile 模块用同一个函数拼。
    let mut args = vec![OsString::from(profile::user_data_dir_argument(profile_dir))];
    if let Some(proxy) = local_proxy {
        args.push(OsString::from(format!("--proxy-server={proxy}")));
        args.push(OsString::from("--proxy-bypass-list=<-loopback>"));
    } else {
        args.push(OsString::from("--no-proxy-server"));
    }
    // 沙箱逃生阀：仅当用户在「系统配置」里关掉沙箱时追加。与上面的代理开关正交，
    // 不影响 --proxy-server；见模块文档「沙箱逃生阀」。
    if disable_sandbox {
        args.push(OsString::from("--no-sandbox"));
    }
    args.extend(vec![
        // 端口 0 = 由内核分配，每次启动都换一个，只写进这个 profile 的
        // DevToolsActivePort。
        // 不传 --remote-debugging-address（默认只绑 127.0.0.1），也不传
        // --remote-allow-origins（于是带 Origin 的网页请求会被 Chromium 拒绝）。
        OsString::from("--remote-debugging-port=0"),
        OsString::from("--disable-quic"),
        OsString::from("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
        OsString::from("--disable-background-mode"),
        // Crashpad daemonizes outside the browser process group on Unix. This
        // client does not upload browser crashes; do not spawn an unowned helper.
        OsString::from("--disable-breakpad"),
        OsString::from("--no-first-run"),
        OsString::from("--no-default-browser-check"),
        // Chrome for Testing shows an infobar in persistent profiles. Playwright
        // uses this switch for the same context; other Chrome builds ignore it.
        OsString::from("--disable-infobars"),
        // 持久 profile 被强杀过（等不到它正常退出，或客户端自己崩了）之后，下次启动
        // Chromium 会弹「要恢复页面吗」。起始网址已经由我们给定，这个气泡只会诱人点回
        // 上一次的标签页。
        OsString::from("--hide-crash-restore-bubble"),
    ]);
    // 几何总是显式下发。读不到显示器就用兜底值，绝不回退到 --start-maximized：
    // 那次 resize 和渲染器首帧的竞态就是灰屏的来源。
    let geometry = window.unwrap_or(FALLBACK_WINDOW);
    args.push(OsString::from(format!(
        "--window-position={},{}",
        geometry.x, geometry.y
    )));
    args.push(OsString::from(format!(
        "--window-size={},{}",
        geometry.width, geometry.height
    )));
    args.push(OsString::from(target_url));
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::sync::atomic::AtomicUsize;
    #[cfg(unix)]
    use std::sync::mpsc;
    use std::time::UNIX_EPOCH;

    #[test]
    fn chromium_arguments_use_only_loopback_proxy_and_the_given_profile() {
        let profile = Path::new("/tmp/vestus-profile-test");
        let arguments = chromium_arguments(
            profile,
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            None,
            false,
        );
        let rendered: Vec<String> = arguments
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        // 必须和占用检测认进程用的是同一个字符串，差一个字就认不出自己的环境。
        assert_eq!(rendered[0], profile::user_data_dir_argument(profile));
        assert!(rendered.contains(&"--proxy-server=http://127.0.0.1:51234".into()));
        assert!(rendered.contains(&"--proxy-bypass-list=<-loopback>".into()));
        // 调试端点必须请内核分配端口：写死端口会让任何本机进程直接猜到控制通道，
        // 端口 0 则每次启动都换一个。
        assert!(rendered.contains(&"--remote-debugging-port=0".into()));
        // 这两个开关会把控制通道分别暴露给外部主机和被打开的网页自身。
        assert!(!rendered
            .iter()
            .any(|argument| argument.starts_with("--remote-debugging-address")));
        assert!(!rendered
            .iter()
            .any(|argument| argument.starts_with("--remote-allow-origins")));
        // Chrome for Testing's persistent profile infobar consumes part of the
        // visible page viewport unless this switch is passed at launch.
        assert!(rendered.contains(&"--disable-infobars".into()));
        assert!(rendered.contains(&"--disable-quic".into()));
        // 被强杀过的持久 profile 不能在下次启动时诱人恢复上一次的标签页。
        assert!(rendered.contains(&"--hide-crash-restore-bubble".into()));
        assert_eq!(rendered.last().unwrap(), "https://platform.example.test/");
        assert!(!rendered.join(" ").contains("proxy-password"));
        // 默认保留沙箱：不显式关闭时绝不能出现 --no-sandbox。
        assert!(!rendered.contains(&"--no-sandbox".into()));
    }

    /// 关闭沙箱是给「本机沙箱拉不起来」的机器留的逃生阀：追加 --no-sandbox，但**绝不
    /// 能**顺带动到代理——沙箱和代理是两条正交的开关，客户就是靠代理才成立的。
    #[test]
    fn chromium_arguments_disable_sandbox_appends_no_sandbox_and_keeps_proxy() {
        let rendered: Vec<String> = chromium_arguments(
            Path::new("/tmp/vestus-profile-test"),
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            None,
            true,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();

        assert!(rendered.contains(&"--no-sandbox".into()));
        // 代理必须原样保留：这正是「关沙箱但代理照常」的核心保证。
        assert!(rendered.contains(&"--proxy-server=http://127.0.0.1:51234".into()));
        assert!(rendered.contains(&"--proxy-bypass-list=<-loopback>".into()));
        // 起始网址仍然必须是最后一个参数。
        assert_eq!(rendered.last().unwrap(), "https://platform.example.test/");
    }

    /// 关沙箱也不该改变代理的「关」态：直连（无代理）+ 关沙箱时，--no-proxy-server
    /// 与 --no-sandbox 两者都在，互不干扰。
    #[test]
    fn chromium_arguments_disable_sandbox_is_orthogonal_to_direct_mode() {
        let rendered: Vec<String> = chromium_arguments(
            Path::new("/tmp/vestus-profile-test"),
            None,
            "https://platform.example.test/",
            None,
            true,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();

        assert!(rendered.contains(&"--no-sandbox".into()));
        assert!(rendered.contains(&"--no-proxy-server".into()));
        assert!(!rendered
            .iter()
            .any(|arg| arg.starts_with("--proxy-server=")));
    }

    /// 隐身模式和持久环境正好相反，还会被站点识别；`--new-window` 只对转交给已在
    /// 运行的进程的启动有意义，而我们从不那样启动。两个都不能出现。
    #[test]
    fn chromium_arguments_omit_incognito_and_new_window() {
        let rendered: Vec<String> = chromium_arguments(
            Path::new("/tmp/vestus-profile-test"),
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            None,
            false,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();

        assert!(!rendered.contains(&"--incognito".into()));
        assert!(!rendered.contains(&"--new-window".into()));
    }

    /// 拿到显示器几何时必须显式下发窗口大小，而不是靠启动后再最大化——那次
    /// resize 会和渲染器首帧竞态，导致内容区停在空白帧上。
    #[test]
    fn chromium_arguments_prefer_explicit_geometry_over_start_maximized() {
        let geometry = WindowGeometry {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        let rendered: Vec<String> = chromium_arguments(
            Path::new("/tmp/vestus-profile-test"),
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            Some(geometry),
            false,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();

        assert!(rendered.contains(&"--window-position=0,0".into()));
        assert!(rendered.contains(&"--window-size=1920,1040".into()));
        assert!(!rendered.contains(&"--start-maximized".into()));
        // 起始网址必须始终是最后一个参数
        assert_eq!(rendered.last().unwrap(), "https://platform.example.test/");
    }

    /// 读不到可信的显示器几何时仍然显式下发窗口，不能把 `--start-maximized` 加回
    /// 来：读不到显示器的机器（远程桌面、虚拟显卡）正是最容易踩上那个首帧竞态的。
    #[test]
    fn chromium_arguments_fall_back_to_explicit_geometry_not_start_maximized() {
        let rendered: Vec<String> = chromium_arguments(
            Path::new("/tmp/vestus-profile-test"),
            None,
            "https://platform.example.test/",
            None,
            false,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();

        assert!(!rendered.contains(&"--start-maximized".into()));
        assert!(rendered.contains(&format!(
            "--window-position={},{}",
            FALLBACK_WINDOW.x, FALLBACK_WINDOW.y
        )));
        assert!(rendered.contains(&format!(
            "--window-size={},{}",
            FALLBACK_WINDOW.width, FALLBACK_WINDOW.height
        )));
    }

    /// Chromium 按逻辑像素解释窗口参数，高 DPI 下必须除掉缩放比，
    /// 否则窗口会大出屏幕一倍。
    #[test]
    fn window_geometry_converts_physical_pixels_to_logical() {
        assert_eq!(
            window_geometry(0, 0, 3840, 2080, 2.0),
            Some(WindowGeometry {
                x: 0,
                y: 0,
                width: 1920,
                height: 1040,
            })
        );
        // 工作区不从原点开始（任务栏在上、或副屏在左）时位置同样要换算
        assert_eq!(
            window_geometry(-2560, 100, 2560, 1400, 1.0),
            Some(WindowGeometry {
                x: -2560,
                y: 100,
                width: 2560,
                height: 1400,
            })
        );
    }

    /// 完整的两行文件是唯一被接受的形状。
    #[test]
    fn devtools_active_port_parses_the_documented_two_lines() {
        let endpoint = parse_devtools_active_port("51234\n/devtools/browser/2f9a-3b1c\n")
            .expect("应当解析成功");
        assert_eq!(endpoint.port, 51234);
        assert_eq!(endpoint.browser_path, "/devtools/browser/2f9a-3b1c");
        assert_eq!(
            endpoint.websocket_url(),
            "ws://127.0.0.1:51234/devtools/browser/2f9a-3b1c"
        );
    }

    /// Chromium 先建文件再写内容，所以读到半截是常态而不是异常：只能回 `None`
    /// 让调用方继续轮询，绝不能把半截路径拼进 URL 去连。
    #[test]
    fn devtools_active_port_rejects_a_torn_file() {
        assert!(parse_devtools_active_port("").is_none());
        assert!(parse_devtools_active_port("51234").is_none());
        assert!(parse_devtools_active_port("51234\n").is_none());
        assert!(parse_devtools_active_port("512").is_none());
    }

    /// 端口 0 是「还没分配」的写法，不是可连的端口。
    #[test]
    fn devtools_active_port_rejects_a_zero_port() {
        assert!(parse_devtools_active_port("0\n/devtools/browser/2f9a\n").is_none());
        assert!(parse_devtools_active_port("70000\n/devtools/browser/2f9a\n").is_none());
        assert!(parse_devtools_active_port("abc\n/devtools/browser/2f9a\n").is_none());
    }

    /// 第二行会原样拼进 WebSocket URL，所以只认 Chromium 文档的那个形状：
    /// 别的进程写进这个路径的内容不能变成一次跨主机或跨路径的连接。
    #[test]
    fn devtools_active_port_rejects_a_foreign_browser_path() {
        assert!(parse_devtools_active_port("51234\n/devtools/page/2f9a\n").is_none());
        assert!(parse_devtools_active_port("51234\n../devtools/browser/2f9a\n").is_none());
        assert!(parse_devtools_active_port("51234\n/devtools/browser/a?b=c\n").is_none());
        assert!(parse_devtools_active_port("51234\n/devtools/browser/a#b\n").is_none());
        assert!(parse_devtools_active_port("51234\n/devtools/browser/a b\n").is_none());
        assert!(parse_devtools_active_port(&format!(
            "51234\n/devtools/browser/{}\n",
            "a".repeat(300)
        ))
        .is_none());
    }

    #[test]
    fn window_geometry_rejects_unusable_readings() {
        // 缩放比非法
        assert_eq!(window_geometry(0, 0, 1920, 1080, 0.0), None);
        assert_eq!(window_geometry(0, 0, 1920, 1080, -1.0), None);
        assert_eq!(window_geometry(0, 0, 1920, 1080, f64::NAN), None);
        // 换算后的窗口小得不可用
        assert_eq!(window_geometry(0, 0, 300, 1080, 1.0), None);
        assert_eq!(window_geometry(0, 0, 1920, 200, 1.0), None);
    }

    #[test]
    fn chromium_arguments_direct_mode_uses_no_proxy_server() {
        let profile = Path::new("/tmp/vestus-profile-test-direct");
        let arguments =
            chromium_arguments(profile, None, "https://platform.example.test/", None, false);
        let rendered: Vec<String> = arguments
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert!(rendered.contains(&"--no-proxy-server".into()));
        assert!(!rendered
            .iter()
            .any(|arg| arg.starts_with("--proxy-server=")));
    }

    #[test]
    fn empty_manager_closes_nothing() {
        let manager = BrowserSessionManager::default();
        assert_eq!(manager.active_count(), 0);
        assert_eq!(rt::runtime().block_on(manager.close_all()), 0);
        assert_eq!(manager.shutdown(), 0);
    }

    fn scratch_dir(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "vestus-browser-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        root
    }

    /// 在 `root` 下放一个假 Chromium 脚本。
    #[cfg(unix)]
    fn fake_chromium(root: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;

        let executable = root.join("fake-chromium.sh");
        std::fs::write(&executable, script).unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions).unwrap();
        executable
    }

    #[cfg(unix)]
    fn launch_fake(
        manager: &BrowserSessionManager,
        session_id: u64,
        executable: &Path,
        profile: &Path,
    ) -> Result<u64, BrowserError> {
        manager.launch_process(
            session_id,
            executable,
            profile.to_path_buf(),
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            None,
            false,
            |_| {},
            || {},
        )
    }

    /// 关浏览器不等于删环境：进程收走之后 profile 里的数据必须原样留着。
    #[cfg(unix)]
    #[test]
    fn manager_tracks_multiple_processes_and_keeps_each_profile() {
        let root = scratch_dir("manager");
        let executable = fake_chromium(&root, "#!/bin/sh\nexec sleep 30\n");

        let first_profile = root.join("profile-one");
        let second_profile = root.join("profile-two");
        for profile in [&first_profile, &second_profile] {
            std::fs::create_dir(profile).unwrap();
            std::fs::write(profile.join("Cookies"), b"logged-in").unwrap();
        }
        let callbacks = Arc::new(AtomicUsize::new(0));
        let manager = BrowserSessionManager::default();

        for (id, profile) in [(1, first_profile.clone()), (2, second_profile.clone())] {
            let callbacks = Arc::clone(&callbacks);
            manager
                .launch_process(
                    id,
                    &executable,
                    profile,
                    Some("http://127.0.0.1:51234"),
                    "https://platform.example.test/",
                    None,
                    false,
                    |_| {},
                    move || {
                        callbacks.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .unwrap();
        }

        assert_eq!(manager.active_count(), 2);
        assert_eq!(rt::runtime().block_on(manager.close_all()), 2);
        assert_eq!(manager.active_count(), 0);

        for _ in 0..40 {
            if callbacks.load(Ordering::SeqCst) == 2 {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(callbacks.load(Ordering::SeqCst), 2);
        for profile in [&first_profile, &second_profile] {
            assert_eq!(
                std::fs::read(profile.join("Cookies")).unwrap(),
                b"logged-in"
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn environment_lease_survives_launch_and_is_released_after_close() {
        let root = scratch_dir("lease-lifecycle");
        let account = root.join("account");
        let profile = account.join("p1-proxy");
        let executable = fake_chromium(&root, "#!/bin/sh\nexec sleep 30\n");
        let manager = BrowserSessionManager::default();
        launch_fake(&manager, 1, &executable, &profile).unwrap();
        assert!(matches!(
            profile::acquire_profile_lease(&profile),
            Err(profile::ProfileCheckError::Busy)
        ));
        assert_eq!(
            profile::remove_account(&account),
            Err(profile::ResetError::Busy)
        );
        let other = BrowserSessionManager::default();
        assert!(matches!(
            launch_fake(&other, 1, &executable, &profile),
            Err(BrowserError::ProfileBusy)
        ));
        let other_platform = profile::acquire_profile_lease(&account.join("p2-proxy")).unwrap();
        drop(other_platform);
        let closing = manager.closing_sessions(true, |_| true, false);
        assert_eq!(closing.len(), 1);
        // 从管理表摘掉还不代表进程已经退出，关闭任务仍须持锁。
        assert!(matches!(
            profile::acquire_profile_lease(&profile),
            Err(profile::ProfileCheckError::Busy)
        ));
        rt::runtime().block_on(manager.close_gracefully(closing));
        let lease = profile::acquire_profile_lease(&profile).unwrap();
        drop(lease);
        assert_eq!(profile::remove_account(&account), Ok(1));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_spawn_releases_environment_lease_and_keeps_data() {
        let root = scratch_dir("lease-spawn-failure");
        let profile = root.join("account/p1-proxy");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("Cookies"), b"keep").unwrap();
        let manager = BrowserSessionManager::default();
        assert!(matches!(
            launch_fake(&manager, 1, &root.join("missing-browser"), &profile),
            Err(BrowserError::Spawn(_))
        ));
        let lease = profile::acquire_profile_lease(&profile).unwrap();
        assert_eq!(std::fs::read(profile.join("Cookies")).unwrap(), b"keep");
        drop(lease);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 新写入的可执行脚本可能启动较慢；必须等 trap 安装完成，不能靠固定延时猜测。
    #[cfg(unix)]
    fn wait_for_fake_browser_ready(manager: &BrowserSessionManager, profile: &Path, ready: &Path) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            assert!(
                manager.running_browser(profile).is_some(),
                "假浏览器在安装信号处理前退出"
            );
            if ready.exists() {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "假浏览器未在期限内安装信号处理"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    /// 主动关闭必须先请浏览器自己退出（这样 Cookie 才会落盘），而不是上来就强杀。
    /// 假浏览器在收到 SIGTERM 时留下记号——强杀是收不到信号的。
    #[cfg(unix)]
    #[test]
    fn closing_asks_the_browser_to_exit_before_killing_it() {
        let root = scratch_dir("graceful");
        let marker = root.join("exited-gracefully");
        let ready = root.join("ready");
        let executable = fake_chromium(
            &root,
            &format!(
                "#!/bin/sh\ntrap 'echo graceful > \"{}\"; exit 0' TERM\necho ready > \"{}\"\nwhile :; do sleep 0.05; done\n",
                marker.display(),
                ready.display()
            ),
        );
        let profile = root.join("profile");
        std::fs::create_dir(&profile).unwrap();
        let manager = BrowserSessionManager::default();
        launch_fake(&manager, 1, &executable, &profile).unwrap();
        wait_for_fake_browser_ready(&manager, &profile, &ready);

        let started = std::time::Instant::now();
        assert_eq!(rt::runtime().block_on(manager.close_all()), 1);
        assert!(started.elapsed() < GRACEFUL_CLOSE_TIMEOUT);
        assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "graceful");
        assert!(profile.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// 不肯退出的浏览器到点必须被强杀，关闭流程不能跟着卡住。
    #[cfg(unix)]
    #[test]
    fn a_browser_that_ignores_the_request_is_killed_at_the_deadline() {
        let root = scratch_dir("stubborn");
        let ready = root.join("ready");
        let executable = fake_chromium(
            &root,
            &format!(
                "#!/bin/sh\ntrap '' TERM\necho ready > \"{}\"\nwhile :; do sleep 0.05; done\n",
                ready.display()
            ),
        );
        let profile = root.join("profile");
        std::fs::create_dir(&profile).unwrap();
        let manager = BrowserSessionManager::default();
        launch_fake(&manager, 1, &executable, &profile).unwrap();
        wait_for_fake_browser_ready(&manager, &profile, &ready);

        let started = std::time::Instant::now();
        assert_eq!(manager.shutdown(), 1);
        let elapsed = started.elapsed();
        assert!(elapsed >= GRACEFUL_CLOSE_TIMEOUT);
        assert!(elapsed < GRACEFUL_CLOSE_TIMEOUT + Duration::from_secs(3));
        assert_eq!(manager.active_count(), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    /// 同一个环境只能有一个进程：本实例已经开着它时，再启动必须被拒绝（调用方改走
    /// 复用分支激活已有页面），而且不能碰那个进程的端口文件。
    #[cfg(unix)]
    #[test]
    fn a_running_environment_is_reused_not_relaunched() {
        let root = scratch_dir("reuse");
        let executable = fake_chromium(&root, "#!/bin/sh\nexec sleep 30\n");
        let profile = root.join("profile");
        let other = root.join("other-profile");
        std::fs::create_dir(&profile).unwrap();
        std::fs::create_dir(&other).unwrap();
        let manager = BrowserSessionManager::default();

        launch_fake(&manager, 1, &executable, &profile).unwrap();
        assert_eq!(manager.running_browser(&profile), Some(1));
        assert_eq!(manager.running_browser(&other), None);

        // 内容故意不合法：只关心它会不会被删，不想让监视线程真的去连一个端口。
        std::fs::write(profile.join(DEVTOOLS_PORT_FILE), "not a port file").unwrap();
        assert!(matches!(
            launch_fake(&manager, 2, &executable, &profile),
            Err(BrowserError::AlreadyRunning)
        ));
        assert!(profile.join(DEVTOOLS_PORT_FILE).exists());
        assert_eq!(manager.active_count(), 1);

        // 别的环境不受影响，照样独立启动。
        launch_fake(&manager, 3, &executable, &other).unwrap();
        assert_eq!(manager.active_count(), 2);

        assert_eq!(rt::runtime().block_on(manager.close_all()), 2);
        assert_eq!(manager.running_browser(&profile), None);
        let _ = std::fs::remove_dir_all(root);
    }

    /// Credential rotation must retire only the matching managed version. A
    /// normal profile and another platform's managed profile keep running.
    #[cfg(unix)]
    #[test]
    fn managed_version_cleanup_is_scoped_to_account_platform_and_mode() {
        let root = scratch_dir("managed-version-cleanup");
        let executable = fake_chromium(&root, "#!/bin/sh\nexec sleep 30\n");
        let account = root.join("account");
        let old = account.join("p3-proxy-managed-a9-v3");
        let manual = account.join("p3-proxy");
        let other_platform = account.join("p4-proxy-managed-a9-v3");
        let current = account.join("p3-proxy-managed-a9-v4");
        let manager = BrowserSessionManager::default();

        launch_fake(&manager, 1, &executable, &old).unwrap();
        launch_fake(&manager, 2, &executable, &manual).unwrap();
        launch_fake(&manager, 3, &executable, &other_platform).unwrap();
        assert_eq!(manager.active_count(), 3);

        assert_eq!(
            rt::runtime()
                .block_on(manager.close_managed_profile_versions(&account, 3, false, 9, &current,)),
            1
        );
        assert_eq!(manager.running_browser(&old), None);
        assert_eq!(manager.running_browser(&manual), Some(2));
        assert_eq!(manager.running_browser(&other_platform), Some(3));
        assert_eq!(manager.active_count(), 2);

        rt::runtime().block_on(manager.close_all());
        let _ = std::fs::remove_dir_all(root);
    }

    /// 环境被另一个进程开着（另一个 Vestus 实例、崩溃残留的浏览器）时不能启动：
    /// Chromium 会把我们的命令行转交给它，窗口开进一个我们既不采集、代理也不归我们
    /// 管的浏览器里。
    #[cfg(unix)]
    #[test]
    fn launch_refuses_an_environment_held_by_another_process() {
        let root = scratch_dir("busy");
        let executable = fake_chromium(&root, "#!/bin/sh\nexec sleep 30\n");
        let profile = root.join("profile");
        std::fs::create_dir(&profile).unwrap();
        let mut owner = Command::new("/bin/sh")
            .args(["-c", "sleep 30; :", "vestus-test"])
            .arg(profile::user_data_dir_argument(&profile))
            .spawn()
            .unwrap();
        std::os::unix::fs::symlink(
            format!("testhost-{}", owner.id()),
            profile.join("SingletonLock"),
        )
        .unwrap();

        let manager = BrowserSessionManager::default();
        assert!(matches!(
            launch_fake(&manager, 1, &executable, &profile),
            Err(BrowserError::ProfileBusy)
        ));
        assert_eq!(manager.active_count(), 0);

        owner.kill().unwrap();
        owner.wait().unwrap();
        // 占用者没了，残留的锁不能再挡路。
        launch_fake(&manager, 2, &executable, &profile).unwrap();
        assert_eq!(rt::runtime().block_on(manager.close_all()), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    /// 持久 profile 里上一次运行留下的端口文件绝不能被当成这一次的。
    #[test]
    fn a_port_file_from_a_previous_run_is_ignored() {
        let root = scratch_dir("port-file");
        let port_file = root.join(DEVTOOLS_PORT_FILE);
        std::fs::write(&port_file, "51234\n/devtools/browser/previous\n").unwrap();
        let launched_at = SystemTime::now();
        let hour_ago = launched_at - Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&port_file)
            .unwrap()
            .set_modified(hour_ago)
            .unwrap();

        let not_before = launched_at - DEVTOOLS_PORT_CLOCK_SLACK;
        assert_eq!(read_fresh_port_file(&port_file, not_before), None);

        std::fs::write(&port_file, "51235\n/devtools/browser/current\n").unwrap();
        assert_eq!(
            read_fresh_port_file(&port_file, not_before),
            Some(DevToolsEndpoint {
                port: 51235,
                browser_path: "/devtools/browser/current".to_string(),
            })
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_cannot_miss_a_launch_holding_the_session_lock() {
        let root = scratch_dir("shutdown");
        let executable = fake_chromium(&root, "#!/bin/sh\nexec sleep 30\n");
        let profile = root.join("profile");
        std::fs::create_dir(&profile).unwrap();

        let manager = BrowserSessionManager::default();
        let launch_manager = manager.clone();
        let launch_executable = executable.clone();
        let launch_profile = profile.clone();
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let launch = thread::spawn(move || {
            launch_manager.launch_process_with_hook(
                LaunchProcessRequest {
                    session_id: 1,
                    executable: &launch_executable,
                    profile_dir: launch_profile,
                    ephemeral: false,
                    extra_arguments: &[],
                    local_proxy: Some("http://127.0.0.1:51234"),
                    target_url: "https://platform.example.test/",
                    window: None,
                    disable_sandbox: false,
                },
                |_| {},
                || {},
                move || {
                    locked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                },
            )
        });

        locked_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let shutdown_manager = manager.clone();
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let shutdown = thread::spawn(move || {
            shutdown_tx.send(shutdown_manager.shutdown()).unwrap();
        });

        // shutdown must wait for the launch's session-lock critical section.
        assert!(shutdown_rx.recv_timeout(Duration::from_millis(50)).is_err());
        release_tx.send(()).unwrap();
        assert!(launch.join().unwrap().is_ok());
        assert_eq!(shutdown_rx.recv_timeout(Duration::from_secs(2)).unwrap(), 1);
        shutdown.join().unwrap();

        assert_eq!(manager.active_count(), 0);
        // 持久环境：进程收走了，环境本身必须留着。
        assert!(profile.exists());
        let rejected_profile = root.join("rejected-profile");
        std::fs::create_dir(&rejected_profile).unwrap();
        assert!(matches!(
            manager.launch_process(
                2,
                &executable,
                rejected_profile.clone(),
                Some("http://127.0.0.1:51234"),
                "https://platform.example.test/",
                None,
                false,
                |_| {},
                || {},
            ),
            Err(BrowserError::ShuttingDown)
        ));
        // 被拒绝的启动同样不能删别人的环境。
        assert!(rejected_profile.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    // 补 ACL 是个副作用，只能落在我们自己铺的资源目录上。dev 会回退到系统装的
    // Chrome，去改 Program Files / /Applications 的权限属于越界。
    #[test]
    fn sandbox_fixup_only_targets_the_bundled_copy() {
        let bundled_root = Path::new("/opt/vestus/resources/chromium");

        // Windows 布局：chromium/chrome.exe，补的是 chromium 目录本身。
        assert_eq!(
            sandbox_fixup_root(&bundled_root.join("chrome.exe"), bundled_root),
            Some(bundled_root)
        );

        // macOS 布局：可执行文件深在 .app/Contents/MacOS 里，补的仍然是整棵树，
        // 而不是它所在的那一层。
        let nested = bundled_root
            .join("Google Chrome for Testing.app")
            .join("Contents")
            .join("MacOS")
            .join("Google Chrome for Testing");
        assert_eq!(
            sandbox_fixup_root(&nested, bundled_root),
            Some(bundled_root)
        );

        // dev 回退到的系统浏览器：一个都不能碰。
        for outside in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        ] {
            assert_eq!(
                sandbox_fixup_root(Path::new(outside), bundled_root),
                None,
                "系统装的浏览器不该被改权限：{outside}"
            );
        }

        // 前缀相近但不是同一个目录，不能因为字符串前缀就命中。
        assert_eq!(
            sandbox_fixup_root(
                Path::new("/opt/vestus/resources/chromium-backup/chrome.exe"),
                bundled_root
            ),
            None
        );
    }

    // 随包浏览器的 bundle 名字由 Playwright 决定，会随版本变；解析必须靠扫描，
    // 否则升级 Playwright 就会变成「安装包里有浏览器却报找不到」。
    #[cfg(target_os = "macos")]
    #[test]
    fn bundled_macos_executables_accept_any_app_bundle_name() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "vestus-chromium-scan-test-{}-{unique}",
            std::process::id()
        ));
        let macos_dir = root
            .join("Google Chrome for Testing.app")
            .join("Contents")
            .join("MacOS");
        std::fs::create_dir_all(&macos_dir).unwrap();
        let executable = macos_dir.join("Google Chrome for Testing");
        std::fs::write(&executable, b"").unwrap();
        // 同级的附属目录不是 .app，不能被当成浏览器。
        std::fs::create_dir_all(root.join("resources")).unwrap();

        assert_eq!(bundled_macos_executables(&root), vec![executable]);
        assert!(bundled_macos_executables(&root.join("missing")).is_empty());

        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(all(test, unix))]
mod lifecycle_tests;
#[cfg(test)]
mod persistence_tests;
