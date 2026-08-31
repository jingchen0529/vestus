//! 外置 Chromium 多会话管理。
//!
//! OA 的浏览器语义是「每次点击都创建一个新的、临时的 Chromium 环境」。
//! 这里保留 Tauri 作为登录壳，只把业务网站交给随应用发布的 Chromium。
//!
//! 起始网址作为命令行最后一个参数交给 Chromium 直接打开；本模块不与浏览器
//! 建立任何控制通道，也不开调试端点。
//!
//! 「临时环境」由每次新建的 `--user-data-dir` 加退出时的 [`cleanup_profile`]
//! 保证，不依赖 `--incognito`：profile 本来就用完即焚，隐身模式换不来额外的
//! 隐私，却会限制站点的 localStorage/IndexedDB，还让目标站点能直接识别出
//! 隐身特征。同理也不传 `--new-window`——每个会话都是独立 user-data-dir 上
//! 的全新进程，本来就只会开出一个新窗口。
//!
//! 窗口几何显式下发而不用 `--start-maximized`：后者要等窗口建好再最大化，
//! 这次 resize 和渲染器首帧存在竞态，在远程桌面/无独显的机器上会停在空白
//! 帧上（表现为内容区灰屏、刷新才恢复）。

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, Runtime};

#[cfg(any(debug_assertions, test))]
const CHROMIUM_PATH_ENV: &str = "VESTUS_CHROMIUM_PATH";
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// 低于这个边长的工作区当作读数异常，退回让 Chromium 自己决定窗口大小。
const MIN_WINDOW_EDGE: u32 = 320;
type ProcessSlot = Arc<Mutex<Option<Child>>>;
type BrowserCloseEntry = (ProcessSlot, PathBuf);

#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("无法定位应用资源目录：{0}")]
    ResourceDirectory(String),
    #[cfg(any(debug_assertions, test))]
    #[error("{CHROMIUM_PATH_ENV} 必须指向一个绝对的 Chromium 可执行文件路径")]
    InvalidOverride,
    #[error("未找到可用的 Chromium。请确认安装包包含浏览器资源")]
    ChromiumMissing,
    #[error("无法创建临时浏览器环境：{0}")]
    ProfileDirectory(String),
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

struct LaunchProcessRequest<'a> {
    session_id: u64,
    executable: &'a Path,
    profile_dir: PathBuf,
    local_proxy: Option<&'a str>,
    target_url: &'a str,
    window: Option<WindowGeometry>,
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
    /// Start one independent Chromium process with a fresh profile.
    ///
    pub fn launch<R, F>(
        &self,
        app: &AppHandle<R>,
        session_id: u64,
        local_proxy: Option<&str>,
        target_url: &str,
        on_exit: F,
    ) -> Result<u64, BrowserError>
    where
        R: Runtime,
        F: FnOnce() + Send + 'static,
    {
        if !self.inner.accepting_launches.load(Ordering::Acquire) {
            return Err(BrowserError::ShuttingDown);
        }
        let executable = resolve_chromium_executable(app)?;
        let profile_dir = create_profile_dir(app, session_id)?;
        let window = primary_window_geometry(app);
        self.launch_process(
            session_id,
            &executable,
            profile_dir,
            local_proxy,
            target_url,
            window,
            on_exit,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn launch_process<F>(
        &self,
        session_id: u64,
        executable: &Path,
        profile_dir: PathBuf,
        local_proxy: Option<&str>,
        target_url: &str,
        window: Option<WindowGeometry>,
        on_exit: F,
    ) -> Result<u64, BrowserError>
    where
        F: FnOnce() + Send + 'static,
    {
        self.launch_process_with_hook(
            LaunchProcessRequest {
                session_id,
                executable,
                profile_dir,
                local_proxy,
                target_url,
                window,
            },
            on_exit,
            || {},
        )
    }

    fn launch_process_with_hook<F, H>(
        &self,
        request: LaunchProcessRequest<'_>,
        on_exit: F,
        on_launch_lock: H,
    ) -> Result<u64, BrowserError>
    where
        F: FnOnce() + Send + 'static,
        H: FnOnce(),
    {
        let LaunchProcessRequest {
            session_id,
            executable,
            profile_dir,
            local_proxy,
            target_url,
            window,
        } = request;
        let arguments = chromium_arguments(&profile_dir, local_proxy, target_url, window);

        let mut command = Command::new(executable);
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(directory) = executable.parent() {
            command.current_dir(directory);
        }

        // Spawning and publishing a process is one critical section with
        // shutdown. Therefore shutdown either drains this exact child or makes
        // the launch reject before any process exists.
        let process = {
            let mut sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
            if !self.inner.accepting_launches.load(Ordering::Acquire) {
                let _ = std::fs::remove_dir_all(&profile_dir);
                return Err(BrowserError::ShuttingDown);
            }
            on_launch_lock();
            let child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    let _ = std::fs::remove_dir_all(&profile_dir);
                    return Err(BrowserError::Spawn(error.to_string()));
                }
            };

            let process = Arc::new(Mutex::new(Some(child)));
            sessions.insert(
                session_id,
                ManagedBrowser {
                    process: Arc::clone(&process),
                    profile_dir: profile_dir.clone(),
                },
            );
            process
        };

        let manager = self.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("vestus-browser-{session_id}"))
            .spawn(move || {
                wait_for_process_exit(&process);
                manager.remove_finished(session_id);
                cleanup_profile(&profile_dir);
                on_exit();
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
                cleanup_profile(&session.profile_dir);
            }
            return Err(BrowserError::Spawn(format!(
                "无法创建浏览器监控线程：{error}"
            )));
        }

        Ok(session_id)
    }

    /// Close every Chromium process owned by the current desktop session.
    pub fn close_all(&self) -> usize {
        let sessions: Vec<BrowserCloseEntry> = self
            .inner
            .sessions
            .lock()
            .expect("浏览器会话锁已中毒")
            .drain()
            .map(|(_, session)| (session.process, session.profile_dir))
            .collect();

        for (process, profile_dir) in &sessions {
            stop_process(process);
            cleanup_profile(profile_dir);
        }
        sessions.len()
    }

    /// Permanently reject new launches and close every owned process. Used by
    /// the Tauri exit path to close the small launch-vs-exit race window.
    pub fn shutdown(&self) -> usize {
        let sessions: Vec<BrowserCloseEntry> = {
            let mut sessions = self.inner.sessions.lock().expect("浏览器会话锁已中毒");
            self.inner
                .accepting_launches
                .store(false, Ordering::Release);
            sessions
                .drain()
                .map(|(_, session)| (session.process, session.profile_dir))
                .collect()
        };

        for (process, profile_dir) in &sessions {
            stop_process(process);
            cleanup_profile(profile_dir);
        }
        sessions.len()
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
        // Chromium is a process tree. `taskkill /T` closes renderers and popup
        // children as well as the browser process; fall back to Child::kill if
        // the system command is unavailable or rejects the request.
        let status = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
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

fn cleanup_profile(profile_dir: &Path) {
    // Chromium 的辅助进程在主进程退出后可能短暂持有文件。只重试当前
    // 会话的精确目录，绝不扩大删除范围。
    for _ in 0..5 {
        match std::fs::remove_dir_all(profile_dir) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn create_profile_dir<R: Runtime>(
    app: &AppHandle<R>,
    session_id: u64,
) -> Result<PathBuf, BrowserError> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|error| BrowserError::ProfileDirectory(error.to_string()))?
        .join("browser-sessions");
    std::fs::create_dir_all(&root)
        .map_err(|error| BrowserError::ProfileDirectory(error.to_string()))?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let profile_dir = root.join(format!(
        "session-{}-{timestamp}-{session_id}",
        std::process::id()
    ));
    std::fs::create_dir(&profile_dir)
        .map_err(|error| BrowserError::ProfileDirectory(error.to_string()))?;
    Ok(profile_dir)
}

fn resolve_chromium_executable<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, BrowserError> {
    #[cfg(any(debug_assertions, test))]
    {
        if let Some(raw) = std::env::var_os(CHROMIUM_PATH_ENV) {
            let path = PathBuf::from(raw);
            if !path.is_absolute() || !path.is_file() {
                return Err(BrowserError::InvalidOverride);
            }
            return Ok(path);
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

    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or(BrowserError::ChromiumMissing)
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

/// 主显示器的工作区几何，拿不到就返回 None 让 Chromium 自己决定。
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
/// Chromium 的默认行为。
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
) -> Vec<OsString> {
    let mut args = vec![OsString::from(format!(
        "--user-data-dir={}",
        profile_dir.display()
    ))];
    if let Some(proxy) = local_proxy {
        args.push(OsString::from(format!("--proxy-server={proxy}")));
        args.push(OsString::from("--proxy-bypass-list=<-loopback>"));
    } else {
        args.push(OsString::from("--no-proxy-server"));
    }
    args.extend(vec![
        OsString::from("--disable-quic"),
        OsString::from("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
        OsString::from("--disable-background-mode"),
        OsString::from("--no-first-run"),
        OsString::from("--no-default-browser-check"),
    ]);
    match window {
        Some(geometry) => {
            args.push(OsString::from(format!(
                "--window-position={},{}",
                geometry.x, geometry.y
            )));
            args.push(OsString::from(format!(
                "--window-size={},{}",
                geometry.width, geometry.height
            )));
        }
        None => args.push(OsString::from("--start-maximized")),
    }
    args.push(OsString::from(target_url));
    args
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::mpsc;

    #[test]
    fn chromium_arguments_use_only_loopback_proxy_and_fresh_profile() {
        let profile = Path::new("/tmp/vestus-profile-test");
        let arguments = chromium_arguments(
            profile,
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            None,
        );
        let rendered: Vec<String> = arguments
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();

        assert!(rendered
            .iter()
            .any(|argument| argument.starts_with("--user-data-dir=")
                && argument.contains("vestus-profile-test")));
        assert!(rendered.contains(&"--proxy-server=http://127.0.0.1:51234".into()));
        assert!(rendered.contains(&"--proxy-bypass-list=<-loopback>".into()));
        // 不再开调试端点：没有页面自动化，也就没有本地控制通道
        assert!(!rendered
            .iter()
            .any(|argument| argument.starts_with("--remote-debugging-port")));
        assert!(rendered.contains(&"--disable-quic".into()));
        assert_eq!(rendered.last().unwrap(), "https://platform.example.test/");
        assert!(!rendered.join(" ").contains("proxy-password"));
    }

    /// 临时环境靠 user-data-dir 加退出清理保证。隐身模式不增加隐私、又会被站点
    /// 识别，`--new-window` 在独立 profile 上也是多余的，两个都不能再出现。
    #[test]
    fn chromium_arguments_omit_incognito_and_new_window() {
        let rendered: Vec<String> = chromium_arguments(
            Path::new("/tmp/vestus-profile-test"),
            Some("http://127.0.0.1:51234"),
            "https://platform.example.test/",
            None,
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

    /// 读不到可信的显示器几何时退回 Chromium 自己最大化，不能两个都不给。
    #[test]
    fn chromium_arguments_fall_back_to_start_maximized_without_geometry() {
        let rendered: Vec<String> = chromium_arguments(
            Path::new("/tmp/vestus-profile-test"),
            None,
            "https://platform.example.test/",
            None,
        )
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();

        assert!(rendered.contains(&"--start-maximized".into()));
        assert!(!rendered.iter().any(|arg| arg.starts_with("--window-size")));
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
        let arguments = chromium_arguments(profile, None, "https://platform.example.test/", None);
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
        assert_eq!(manager.close_all(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn manager_tracks_multiple_processes_and_cleans_each_profile() {
        use std::os::unix::fs::PermissionsExt as _;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "vestus-browser-manager-test-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join("fake-chromium.sh");
        std::fs::write(&executable, "#!/bin/sh\nexec sleep 30\n").unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions).unwrap();

        let first_profile = root.join("profile-one");
        let second_profile = root.join("profile-two");
        std::fs::create_dir(&first_profile).unwrap();
        std::fs::create_dir(&second_profile).unwrap();
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
                    move || {
                        callbacks.fetch_add(1, Ordering::SeqCst);
                    },
                )
                .unwrap();
        }

        assert_eq!(manager.active_count(), 2);
        assert_eq!(manager.close_all(), 2);
        assert_eq!(manager.active_count(), 0);

        for _ in 0..40 {
            if callbacks.load(Ordering::SeqCst) == 2 {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(callbacks.load(Ordering::SeqCst), 2);
        assert!(!first_profile.exists());
        assert!(!second_profile.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_cannot_miss_a_launch_holding_the_session_lock() {
        use std::os::unix::fs::PermissionsExt as _;

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "vestus-browser-shutdown-test-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir(&root).unwrap();
        let executable = root.join("fake-chromium.sh");
        std::fs::write(&executable, "#!/bin/sh\nexec sleep 30\n").unwrap();
        let mut permissions = std::fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&executable, permissions).unwrap();
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
                },
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
        assert!(!profile.exists());
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
                || {},
            ),
            Err(BrowserError::ShuttingDown)
        ));
        assert!(!rejected_profile.exists());
        let _ = std::fs::remove_dir_all(root);
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
