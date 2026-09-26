//! 外置 Chromium 多会话管理。
//!
//! Tauri 只做登录壳，业务网站交给随应用发布的 Chromium。每个平台在本机有一套
//! **持久**的浏览器环境（profile），按服务器、账号、平台、代理/直连隔离；它放在哪、
//! 归谁、怎么认出被别人占着，见 [`crate::profile`]。
//!
//! 起始网址作为命令行最后一个参数交给 Chromium 直接打开。
//!
//! # 一个环境一个进程
//!
//! Chromium 一个 user-data-dir 同时只允许一个进程：再起一个，它会把自己的命令行转交
//! 给已在运行的那个然后退出，自己带的开关全部作废。所以同一个环境已经开着时，「再
//! 打开一次」就是有意利用这个转交：带上 `--new-window` 再起一次，让原来那个浏览器新开
//! 一个窗口（[`BrowserSessionManager::hand_off`]）。这和用户在桌面上再点一次浏览器图标
//! 是同一回事，不需要调试端点——采集通道是只读的，不给它开窗口的能力。不同平台、同一
//! 平台的代理与直连是不同的环境，照样各自独立运行。
//!
//! # 关闭
//!
//! 我们主动关浏览器（同步配置、租约失效、登出、退出应用、重置环境）时先请它正常
//! 退出——有调试端点就发 `Browser.close`，没有就发 SIGTERM / WM_CLOSE——等到
//! [`GRACEFUL_CLOSE_TIMEOUT`] 还没退才强杀。临时 profile 时代强杀无所谓，现在却会丢
//! 数据：Chromium 的 Cookie 库大约每 30 秒才批量落一次盘，刚登录拿到的登录态就在
//! 这一批里。用户自己关窗口本来就是正常退出，不受影响。
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
//! IndexedDB，并让目标站点直接识别出隐身特征。`--new-window` 只出现在转交用的那次
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
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Runtime};

use crate::cdp;
use crate::profile::{self, ProfileSpec, DEVTOOLS_PORT_FILE};
use crate::rt;

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
/// 转交用的那次启动最多等多久。正常几百毫秒就把命令行交出去退出了；到点还在，说明
/// 原来那个浏览器没接住（卡住了，或恰好在这一瞬间退出、这个进程于是自己当了浏览器）。
const HAND_OFF_TIMEOUT: Duration = Duration::from_secs(15);
const HAND_OFF_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// 低于这个边长的工作区当作读数异常，退回 [`FALLBACK_WINDOW`]。
const MIN_WINDOW_EDGE: u32 = 320;
type ProcessSlot = Arc<Mutex<Option<Child>>>;
/// 读到之前是 `None`；读不到（超时或进程先没了）也一直是 `None`。
type EndpointSlot = Arc<Mutex<Option<DevToolsEndpoint>>>;
type BrowserCloseEntry = (ProcessSlot, Option<DevToolsEndpoint>);

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
    #[error("这个平台的浏览器环境正被另一个浏览器占用（同一账号在另一个 Vestus 窗口里打开了它，或是上次异常退出后残留的浏览器），请先关闭那个浏览器再试")]
    ProfileBusy,
    #[error("这个平台的浏览器已经在运行")]
    AlreadyRunning,
    #[error("浏览器已经关闭，请重新打开")]
    NotRunning,
    #[error("无法在已打开的浏览器里新建窗口：{0}")]
    OpenWindow(String),
    #[error("无法启动 Chromium：{0}")]
    Spawn(String),
    #[error("客户端正在退出，不能再启动浏览器")]
    ShuttingDown,
}

#[derive(Clone)]
pub struct BrowserSessionManager {
    inner: Arc<BrowserSessionInner>,
}

struct BrowserSessionInner {
    accepting_launches: AtomicBool,
    sessions: Mutex<HashMap<u64, ManagedBrowser>>,
}

struct ManagedBrowser {
    process: ProcessSlot,
    profile_dir: PathBuf,
    endpoint: EndpointSlot,
}

/// 解析好的一次启动：用哪个 Chromium、开哪个持久环境。
pub struct PreparedProfile {
    executable: PathBuf,
    dir: PathBuf,
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
    /// 解析一个环境：定位 Chromium，算出它的持久 profile 目录并确保目录存在。
    ///
    /// 只算路径、建空目录，不碰里面的数据；是复用已在运行的进程还是新起一个，由
    /// 调用方拿 [`Self::running_browser`] 决定。
    pub fn prepare_profile<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        spec: &ProfileSpec<'_>,
    ) -> Result<PreparedProfile, BrowserError> {
        let (executable, root) = resolve_executable_and_root(app)?;
        let dir = profile::profile_dir(&root, spec);
        create_private_dir(&dir)?;
        Ok(PreparedProfile { executable, dir })
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

    /// 让这个环境里已在运行的浏览器新开一个窗口打开 `target_url`。
    ///
    /// 做法是带上 `--new-window` 在同一个 user-data-dir 上再起一次 Chromium：它发现目录
    /// 已经有主人，就把命令行转交过去然后自己退出。转交用的命令行和正式启动一模一样
    /// （代理、沙箱开关一个不少）——万一在检查之后那一瞬间原来的进程恰好退出，这次
    /// 启动会自己当上浏览器，那样至少代理不会丢；它随后会被 [`wait_for_hand_off`] 收走，
    /// 不会留下一个不归我们管、也没有采集的浏览器。
    ///
    /// 返回转交进程，调用方把它交给 [`wait_for_hand_off`]。
    pub fn hand_off<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        profile: &PreparedProfile,
        local_proxy: Option<&str>,
        target_url: &str,
        disable_sandbox: bool,
    ) -> Result<Child, BrowserError> {
        if !self.inner.accepting_launches.load(Ordering::Acquire) {
            return Err(BrowserError::ShuttingDown);
        }
        if self.running_browser(&profile.dir).is_none() {
            return Err(BrowserError::NotRunning);
        }
        let arguments = hand_off_arguments(
            &profile.dir,
            local_proxy,
            target_url,
            primary_window_geometry(app),
            disable_sandbox,
        );
        chromium_command(&profile.executable, arguments)
            .spawn()
            .map_err(|error| BrowserError::Spawn(error.to_string()))
    }

    /// Start one Chromium process on a persistent profile.
    ///
    /// `on_ready` fires once the DevTools endpoint is readable, `on_exit` once
    /// the process is gone. Both run on this session's monitor thread, so a slow
    /// callback delays only that session's own bookkeeping.
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
        self.launch_process(
            session_id,
            &profile.executable,
            profile.dir,
            local_proxy,
            target_url,
            window,
            disable_sandbox,
            on_ready,
            on_exit,
        )
    }

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
                profile_dir,
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
            local_proxy,
            target_url,
            window,
            disable_sandbox,
        } = request;
        // 先认自己的：本实例已经开着这个环境时，调用方本该走 open_window。这一步必须
        // 排在 prepare_for_launch 前面——后者会清掉端口文件，那是我们自己那个进程的。
        if self.running_browser(&profile_dir).is_some() {
            return Err(BrowserError::AlreadyRunning);
        }
        profile::prepare_for_launch(&profile_dir).map_err(|_| BrowserError::ProfileBusy)?;
        let arguments = chromium_arguments(
            &profile_dir,
            local_proxy,
            target_url,
            window,
            disable_sandbox,
        );

        let mut command = chromium_command(executable, arguments);

        let endpoint: EndpointSlot = Arc::new(Mutex::new(None));
        let launched_at = SystemTime::now();
        // Spawning and publishing a process is one critical section with
        // shutdown. Therefore shutdown either drains this exact child or makes
        // the launch reject before any process exists.
        //
        // 任何失败路径都不删 profile：那是用户在这个平台上的登录态。
        let process = {
            let mut sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
            if !self.inner.accepting_launches.load(Ordering::Acquire) {
                return Err(BrowserError::ShuttingDown);
            }
            if live_session_on(&sessions, &profile_dir).is_some() {
                return Err(BrowserError::AlreadyRunning);
            }
            on_launch_lock();
            let child = command
                .spawn()
                .map_err(|error| BrowserError::Spawn(error.to_string()))?;

            let process = Arc::new(Mutex::new(Some(child)));
            sessions.insert(
                session_id,
                ManagedBrowser {
                    process: Arc::clone(&process),
                    profile_dir: profile_dir.clone(),
                    endpoint: Arc::clone(&endpoint),
                },
            );
            process
        };

        let manager = self.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("vestus-browser-{session_id}"))
            .spawn({
                let profile_dir = profile_dir.clone();
                let process = Arc::clone(&process);
                move || {
                    // 端口先读：Chromium 启动几百毫秒内就会写出这个文件，而
                    // `wait_for_process_exit` 本来也是轮询，晚一点开始无影响。
                    // 读不到就只是没有采集，浏览器本身照常使用。
                    if let Some(ready) =
                        read_devtools_endpoint(&profile_dir, &process, launched_at)
                    {
                        *endpoint.lock().expect("调试端点锁已中毒") = Some(ready.clone());
                        on_ready(ready);
                    }
                    wait_for_process_exit(&process);
                    manager.remove_finished(session_id);
                    on_exit();
                }
            })
        {
            let session = self
                .inner
                .sessions
                .lock()
                .expect("浏览器会话锁已中毒")
                .remove(&session_id);
            if let Some(session) = session {
                stop_process(&session.process);
            }
            return Err(BrowserError::Spawn(format!(
                "无法创建浏览器监控线程：{error}"
            )));
        }

        Ok(session_id)
    }

    /// Close every Chromium process owned by the current desktop session.
    ///
    /// 先请每个浏览器正常退出，统一等到 [`GRACEFUL_CLOSE_TIMEOUT`]，还活着的强杀。
    /// 返回时这些进程都已经不在了，于是调用方可以放心地删它们的 profile，或者在同一个
    /// 环境上立刻再起一个进程。
    pub async fn close_all(&self) -> usize {
        let sessions = self.take_sessions(false);
        let count = sessions.len();
        close_gracefully(sessions).await;
        count
    }

    /// Permanently reject new launches and close every owned process. Used by
    /// the Tauri exit path to close the small launch-vs-exit race window.
    ///
    /// 它跑在 Tauri 主线程的退出回调里，不在任何 Tokio 运行时之内，所以可以就地
    /// `block_on` 等正常退出走完：各浏览器并行地等，总共最多 [`GRACEFUL_CLOSE_TIMEOUT`]。
    pub fn shutdown(&self) -> usize {
        let sessions = self.take_sessions(true);
        let count = sessions.len();
        if tokio::runtime::Handle::try_current().is_ok() {
            // 在运行时里 block_on 会直接 panic。只有调用方写错了才会走到这里：退回
            // 强杀，至少不留下进程。
            for (process, _) in &sessions {
                stop_process(process);
            }
        } else if count > 0 {
            rt::runtime().block_on(close_gracefully(sessions));
        }
        count
    }

    /// 把全部会话从表里摘下来，连同它们此刻已知的调试端点。`stop_accepting` 为真时
    /// 在同一个临界区里永久拒绝新的启动，见 [`Self::launch_process_with_hook`]。
    fn take_sessions(&self, stop_accepting: bool) -> Vec<BrowserCloseEntry> {
        let mut sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
        if stop_accepting {
            self.inner
                .accepting_launches
                .store(false, Ordering::Release);
        }
        sessions
            .drain()
            .map(|(_, session)| {
                let endpoint = session.endpoint.lock().expect("调试端点锁已中毒").clone();
                (session.process, endpoint)
            })
            .collect()
    }

    #[cfg(test)]
    fn active_count(&self) -> usize {
        self.inner
            .sessions
            .lock()
            .expect("浏览器会话锁已中毒")
            .len()
    }

    fn remove_finished(&self, session_id: u64) {
        self.inner
            .sessions
            .lock()
            .expect("浏览器会话锁已中毒")
            .remove(&session_id);
    }
}

/// 表里开着这个环境、而且进程还活着的那个会话。
///
/// 进程已经退出、只是监视线程还没来得及摘掉的会话不算：否则用户关掉浏览器后马上再点，
/// 会被当成「已经在运行」挡回去。
fn live_session_on(sessions: &HashMap<u64, ManagedBrowser>, profile_dir: &Path) -> Option<u64> {
    sessions
        .iter()
        .find(|(_, session)| {
            session.profile_dir == profile_dir && !process_has_exited(&session.process)
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
    let modified = std::fs::metadata(port_file).and_then(|meta| meta.modified()).ok()?;
    if modified < not_before {
        return None;
    }
    parse_devtools_active_port(&std::fs::read_to_string(port_file).ok()?)
}

/// 请每个浏览器正常退出，并行等到 [`GRACEFUL_CLOSE_TIMEOUT`]，还活着的强杀。
async fn close_gracefully(sessions: Vec<BrowserCloseEntry>) {
    if sessions.is_empty() {
        return;
    }
    let deadline = tokio::time::Instant::now() + GRACEFUL_CLOSE_TIMEOUT;
    let closing: Vec<_> = sessions
        .into_iter()
        .map(|(process, endpoint)| rt::runtime().spawn(close_one(process, endpoint, deadline)))
        .collect();
    for task in closing {
        let _ = task.await;
    }
}

async fn close_one(
    process: ProcessSlot,
    endpoint: Option<DevToolsEndpoint>,
    deadline: tokio::time::Instant,
) {
    // 首选 Browser.close：它不理会 beforeunload，走 Chromium 完整的退出流程。没有调试
    // 端点（进程刚起，或者端口一直没读到）时退而求其次，发一个同样会触发正常退出的
    // 系统信号或窗口关闭消息。
    let asked = match &endpoint {
        Some(endpoint) => cdp::request_exit(endpoint).await.is_ok(),
        None => false,
    };
    if !asked {
        request_polite_exit(&process);
    }
    while !process_has_exited(&process) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(CLOSE_POLL_INTERVAL).await;
    }
    // 已经退出时这是空操作；到点还活着就是卡住了，只能强杀。
    stop_process(&process);
}

/// 请子进程自己正常退出：POSIX 发 SIGTERM（Chromium 收到后走和关窗口一样的退出流程），
/// Windows 用不带 `/F` 的 taskkill 给它的窗口发 WM_CLOSE。
///
/// 拿着进程锁发：监视线程回收子进程也要这把锁，于是发出去的那一刻这个 pid 一定还
/// 属于我们的子进程（最多是还没回收的僵尸），不会误伤一个复用了同一 pid 的陌生进程。
fn request_polite_exit(process: &ProcessSlot) {
    let guard = process.lock().expect("浏览器进程锁已中毒");
    let Some(child) = guard.as_ref() else {
        return;
    };
    let pid = child.id().to_string();

    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &pid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;

        let _ = Command::new(profile::system_tool("taskkill.exe"))
            .args(["/PID", &pid, "/T"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(profile::CREATE_NO_WINDOW)
            .status();
    }
}

/// 等转交用的那次启动把命令行交出去、自己退出。
///
/// 不看退出码：Chromium 转交成功后的退出码在各版本、各平台上并不一致，而这里只关心
/// 「它走了」。到点还没走，就是原来那个浏览器没有接住——它要么卡住了，要么恰好在检查
/// 之后退出、这个进程于是自己当上了浏览器。后一种它不归我们管、也没有采集，不能留着。
pub async fn wait_for_hand_off(child: Child) -> Result<(), BrowserError> {
    wait_for_hand_off_within(child, HAND_OFF_TIMEOUT).await
}

async fn wait_for_hand_off_within(mut child: Child, limit: Duration) -> Result<(), BrowserError> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(HAND_OFF_POLL_INTERVAL).await;
            }
            _ => {
                terminate_child(child);
                return Err(BrowserError::OpenWindow(
                    "浏览器没有响应，请稍后再试".to_string(),
                ));
            }
        }
    }
}

/// Spawn configuration shared by real launches and hand-offs: no stdio, and run
/// from the browser's own directory.
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

/// Whether the child is already gone, without consuming the exit status.
fn process_has_exited(process: &ProcessSlot) -> bool {
    let mut guard = process.lock().expect("浏览器进程锁已中毒");
    match guard.as_mut() {
        Some(child) => !matches!(child.try_wait(), Ok(None)),
        None => true,
    }
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
    loop {
        thread::sleep(PROCESS_POLL_INTERVAL);
        let finished = {
            let mut guard = process.lock().expect("浏览器进程锁已中毒");
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => {
                        guard.take();
                        true
                    }
                    Ok(None) => false,
                    Err(_) => {
                        if let Some(child) = guard.take() {
                            terminate_child(child);
                        }
                        true
                    }
                },
                None => true,
            }
        };
        if finished {
            return;
        }
    }
}

fn stop_process(process: &ProcessSlot) {
    let mut guard = process.lock().expect("浏览器进程锁已中毒");
    if let Some(mut child) = guard.take() {
        match child.try_wait() {
            Ok(Some(_)) => {}
            _ => terminate_child(child),
        }
    }
}

fn terminate_child(mut child: Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;

        // Chromium is a process tree. `taskkill /T` closes renderers and popup
        // children as well as the browser process; fall back to Child::kill if
        // the system command is unavailable or rejects the request. The absolute
        // path keeps a planted taskkill.exe in the install directory out.
        let status = Command::new(profile::system_tool("taskkill.exe"))
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(profile::CREATE_NO_WINDOW)
            .status();
        if !status.is_ok_and(|status| status.success()) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
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
        OsString::from("--no-first-run"),
        OsString::from("--no-default-browser-check"),
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

/// 转交用的那次启动：参数和正式启动完全一样，只在起始网址前多一个 `--new-window`，
/// 让已在运行的浏览器开一个新窗口，而不是在它当前的窗口里塞一个标签页。
fn hand_off_arguments(
    profile_dir: &Path,
    local_proxy: Option<&str>,
    target_url: &str,
    window: Option<WindowGeometry>,
    disable_sandbox: bool,
) -> Vec<OsString> {
    let mut args = chromium_arguments(
        profile_dir,
        local_proxy,
        target_url,
        window,
        disable_sandbox,
    );
    // 起始网址必须留在最后一个。
    let url = args.pop();
    args.push(OsString::from("--new-window"));
    args.extend(url);
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
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
            assert_eq!(std::fs::read(profile.join("Cookies")).unwrap(), b"logged-in");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    /// 主动关闭必须先请浏览器自己退出（这样 Cookie 才会落盘），而不是上来就强杀。
    /// 假浏览器在收到 SIGTERM 时留下记号——强杀是收不到信号的。
    #[cfg(unix)]
    #[test]
    fn closing_asks_the_browser_to_exit_before_killing_it() {
        let root = scratch_dir("graceful");
        let marker = root.join("exited-gracefully");
        let executable = fake_chromium(
            &root,
            &format!(
                "#!/bin/sh\ntrap 'echo graceful > \"{}\"; exit 0' TERM\nwhile :; do sleep 0.05; done\n",
                marker.display()
            ),
        );
        let profile = root.join("profile");
        std::fs::create_dir(&profile).unwrap();
        let manager = BrowserSessionManager::default();
        launch_fake(&manager, 1, &executable, &profile).unwrap();
        // 给 sh 一点时间装好 trap。
        thread::sleep(Duration::from_millis(200));

        let started = std::time::Instant::now();
        assert_eq!(rt::runtime().block_on(manager.close_all()), 1);
        assert!(started.elapsed() < GRACEFUL_CLOSE_TIMEOUT);
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap().trim(),
            "graceful"
        );
        assert!(profile.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    /// 不肯退出的浏览器到点必须被强杀，关闭流程不能跟着卡住。
    #[cfg(unix)]
    #[test]
    fn a_browser_that_ignores_the_request_is_killed_at_the_deadline() {
        let root = scratch_dir("stubborn");
        let executable = fake_chromium(
            &root,
            "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 0.05; done\n",
        );
        let profile = root.join("profile");
        std::fs::create_dir(&profile).unwrap();
        let manager = BrowserSessionManager::default();
        launch_fake(&manager, 1, &executable, &profile).unwrap();
        thread::sleep(Duration::from_millis(200));

        let started = std::time::Instant::now();
        assert_eq!(manager.shutdown(), 1);
        let elapsed = started.elapsed();
        assert!(elapsed >= GRACEFUL_CLOSE_TIMEOUT);
        assert!(elapsed < GRACEFUL_CLOSE_TIMEOUT + Duration::from_secs(3));
        assert_eq!(manager.active_count(), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    /// 同一个环境只能有一个进程：本实例已经开着它时，再启动必须被拒绝（调用方改走
    /// open_window），而且不能碰那个进程的端口文件。
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

    /// 转交用的启动必须和正式启动带同一套参数（代理一个字都不能差），只多一个
    /// `--new-window`，起始网址仍然在最后。
    #[test]
    fn hand_off_arguments_are_a_launch_plus_new_window() {
        let profile = Path::new("/tmp/vestus-profile-test");
        let launch = chromium_arguments(
            profile,
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            None,
            true,
        );
        let hand_off = hand_off_arguments(
            profile,
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            None,
            true,
        );
        assert_eq!(hand_off.len(), launch.len() + 1);
        assert_eq!(hand_off.last(), launch.last());
        assert_eq!(hand_off[hand_off.len() - 2], OsString::from("--new-window"));
        assert_eq!(hand_off[..launch.len() - 1], launch[..launch.len() - 1]);
    }

    /// A hand-off process that passes its command line on and exits is a success;
    /// its exit code does not matter.
    #[cfg(unix)]
    #[test]
    fn a_hand_off_that_exits_is_a_success() {
        let child = Command::new("/bin/sh").args(["-c", "exit 3"]).spawn().unwrap();
        assert!(rt::runtime()
            .block_on(wait_for_hand_off_within(child, Duration::from_secs(5)))
            .is_ok());
    }

    /// A hand-off process that lingers past the deadline must be reaped: it may
    /// have become a browser of its own that we neither manage nor observe.
    #[cfg(unix)]
    #[test]
    fn a_hand_off_that_lingers_is_killed() {
        let child = Command::new("/bin/sh")
            .args(["-c", "sleep 30; :"])
            .spawn()
            .unwrap();
        let pid = child.id().to_string();
        let started = std::time::Instant::now();
        assert!(matches!(
            rt::runtime().block_on(wait_for_hand_off_within(child, Duration::from_millis(300))),
            Err(BrowserError::OpenWindow(_))
        ));
        assert!(started.elapsed() < Duration::from_secs(5));
        let still_alive = Command::new("/bin/kill")
            .args(["-0", &pid])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        assert!(!still_alive);
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
