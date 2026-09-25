//! 持久浏览器环境（Chromium 的 user-data-dir）：放在哪、归谁、有没有被占着、怎么清。
//!
//! # 为什么要持久
//!
//! 平台按「浏览器环境」而不是按登录账号签发设备标识——巨量的 ttwid 就是这样，切号
//! 前后标识里的身份段不变（`js_reverse_cache/ttwid-investigation/findings-20260924.md`）。
//! 用完即焚的临时 profile 让平台每打开一次就看到一台新设备，登录态也留不住。所以同一
//! 台电脑上、同一个账号、同一个平台，每次打开都回到同一个 profile。
//!
//! # 一个环境由什么决定
//!
//! * **服务器**（API 基址）：同一台电脑可能先后连测试和正式两套服务器，两边的
//!   `user-7` 不是同一个人；
//! * **Vestus 账号**（服务端下发的 `profileKey`）：单电脑多账号时，一个账号的平台
//!   Cookie 绝不能出现在另一个账号的浏览器里；
//! * **平台**：一个 Chromium 进程只归属一个平台的活动采集（[`crate::activity`]），
//!   多个平台共用一个进程会让管理台里的归属错乱；
//! * **代理 / 直连**：同一个设备身份时而走代理出口、时而走本机真实出口，等于替平台
//!   把两个 IP 关联起来，而这种关联发生了就收不回来。
//!
//! 「哪台电脑」不用写进键：目录本来就在这台电脑的应用数据目录里。单账号多电脑时每台
//! 电脑各有一份、互不同步——同步反而会让两台真实机器冒充同一台设备，而 Canvas、字体
//! 这些跟硬件走的特征又对不上。
//!
//! 服务端下发的字符串从不直接进路径：账号那一层是摘要，平台那一层只用已经校验为
//! 正整数的平台 ID。
//!
//! # 目录布局
//!
//! ```text
//! <app_local_data_dir>/browser-profiles/[ext-<可执行文件摘要>/]<账号摘要>/p<平台 ID>-<proxy|direct>/
//! ```
//!
//! 用 `app_local_data_dir` 而不是 `app_cache_dir`：缓存目录（macOS 的 `~/Library/Caches`）
//! 会被系统和清理工具随手清掉；Windows 上它落在 `%LOCALAPPDATA%`，不随漫游配置文件
//! 同步——Chromium 的 profile 本来就不能漫游。
//!
//! `ext-…` 那一层只在开发期用了非随包浏览器（系统 Chrome、`VESTUS_CHROMIUM_PATH`）时
//! 出现：不同品牌的 Chromium 用不同的钥匙串条目加密 Cookie，版本也可能更高，和随包
//! 浏览器混用同一个 profile 会让后者读不回登录态，甚至拒绝打开。
//!
//! # 占用
//!
//! Chromium 一个 user-data-dir 同时只允许一个进程。第二个进程启动时会把自己的命令行
//! 转交给已在运行的那个然后退出，自己带的 `--proxy-server` 等开关全部作废。本实例
//! 自己的进程由 [`crate::browser::BrowserSessionManager`] 认领复用；这里只负责认出
//! **别人**：另一个登录了同一账号的 Vestus 实例，或者上次异常退出后残留的浏览器。
//! 见 [`in_use_by_other_process`]。
//!
//! # 残余风险
//!
//! 账号之间的隔离只在 Vestus 这一层成立：同一个操作系统用户下的其他进程读得到这些
//! 目录，Cookie 的加密密钥也按操作系统用户而不是按 Vestus 账号发放（macOS 钥匙串、
//! Windows DPAPI）。账号之间要硬隔离，只能用不同的系统用户登录电脑。

use std::path::{Path, PathBuf};
#[cfg(not(target_os = "linux"))]
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use sha2::{Digest, Sha256};

/// 持久环境的根目录名，挂在 `app_local_data_dir` 下。
const PROFILES_DIR: &str = "browser-profiles";

/// 旧版本临时 profile 的目录名，挂在 `app_cache_dir` 下。见 [`sweep_legacy_sessions`]。
const LEGACY_SESSIONS_DIR: &str = "browser-sessions";

/// 账号摘要保留的十六进制位数。64 位足够让一台电脑上的几个账号不撞；再长只会挤占
/// Windows 260 字符路径上限的余量——Chromium 自己在 profile 里的目录就很深。
const ACCOUNT_DIGEST_CHARS: usize = 16;

/// 非随包浏览器那一层的摘要位数，只用来区分开发机上的几个可执行文件。
const EXECUTABLE_DIGEST_CHARS: usize = 8;

/// Chromium 写调试端口的文件。持久 profile 里会留着上一次运行的那份。
pub(crate) const DEVTOOLS_PORT_FILE: &str = "DevToolsActivePort";

/// POSIX 上 Chromium 的进程单例：`SingletonLock` 指向 `<主机名>-<pid>`，另外两个指向
/// 临时目录里的套接字与随机 cookie。
#[cfg(unix)]
const SINGLETON_LINKS: [&str; 3] = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

/// Windows 上 Chromium 的进程单例文件。Chromium 以「只许别人读、关句柄即删除」的方式
/// 打开它，所以它还在、又没法以写方式打开，就说明有一个活着的 Chromium 占着。
#[cfg(windows)]
const WINDOWS_LOCK_FILE: &str = "lockfile";

/// 删目录时的重试。Chromium 的辅助进程（crashpad 等）在主进程退出后还会短暂持有
/// 文件，Windows 上这会让删除失败。
const REMOVE_ATTEMPTS: u32 = 20;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(100);

/// 一个持久环境的身份。字段都来自已校验的服务端下发值与本机偏好。
#[derive(Debug, Clone, Copy)]
pub struct ProfileSpec<'a> {
    /// 归一化后的 API 基址。
    pub api_base: &'a str,
    /// 服务端为当前账号下发的 `profileKey`。
    pub profile_key: &'a str,
    pub platform_id: i64,
    pub direct_mode: bool,
}

/// 全部持久环境的根目录。`bundled` 为假表示这次用的不是随包浏览器，见模块文档。
pub(crate) fn profiles_root(local_data_dir: &Path, executable: &Path, bundled: bool) -> PathBuf {
    let root = local_data_dir.join(PROFILES_DIR);
    if bundled {
        return root;
    }
    let digest = Sha256::digest(executable.to_string_lossy().as_bytes());
    root.join(format!("ext-{}", hex_prefix(&digest, EXECUTABLE_DIGEST_CHARS)))
}

/// 一个账号在本机的全部环境所在的目录。重置就是删它。
pub(crate) fn account_dir(root: &Path, api_base: &str, profile_key: &str) -> PathBuf {
    root.join(account_dir_name(api_base, profile_key))
}

/// 一个环境的 user-data-dir。
pub(crate) fn profile_dir(root: &Path, spec: &ProfileSpec<'_>) -> PathBuf {
    account_dir(root, spec.api_base, spec.profile_key)
        .join(environment_dir_name(spec.platform_id, spec.direct_mode))
}

fn account_dir_name(api_base: &str, profile_key: &str) -> String {
    let mut hasher = Sha256::new();
    // 版本前缀留给以后换派生方式。字段之间用 NUL 隔开：两者都不可能含 NUL（基址是解析
    // 过的 URL，profileKey 过了 validate_label 的控制字符检查），于是不同的两组输入
    // 拼不出同一串字节。
    hasher.update(b"vestus-browser-profile/v1\0");
    hasher.update(api_base.as_bytes());
    hasher.update(b"\0");
    hasher.update(profile_key.as_bytes());
    hex_prefix(&hasher.finalize(), ACCOUNT_DIGEST_CHARS)
}

fn environment_dir_name(platform_id: i64, direct_mode: bool) -> String {
    let mode = if direct_mode { "direct" } else { "proxy" };
    format!("p{platform_id}-{mode}")
}

fn hex_prefix(bytes: &[u8], chars: usize) -> String {
    let mut hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    hex.truncate(chars);
    hex
}

/// 启动 Chromium 时指向这个 profile 的参数。占用检测按它去认进程，所以
/// [`crate::browser`] 拼命令行时也必须用这个函数，两边一个字都不能差。
pub(crate) fn user_data_dir_argument(profile_dir: &Path) -> String {
    format!("--user-data-dir={}", profile_dir.display())
}

/// 这个环境正被别的进程占着。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ProfileBusy;

/// 启动前的准备：确认没有别的进程占着，再清掉上一次运行留下的残迹。
///
/// 只有确认空闲之后才动文件：占用者还活着时删它的单例锁或端口文件，等于把一个正在
/// 运行的浏览器弄坏。
pub(crate) fn prepare_for_launch(profile_dir: &Path) -> Result<(), ProfileBusy> {
    if in_use_by_other_process(profile_dir) {
        return Err(ProfileBusy);
    }
    clear_stale_singleton(profile_dir);
    // 上一次运行留下的端口文件指向一个已经关掉的端口，不删的话，新进程写出自己的那份
    // 之前轮询会先读到它。删不掉也不致命：读取方还会核对文件的修改时间。
    let _ = std::fs::remove_file(profile_dir.join(DEVTOOLS_PORT_FILE));
    Ok(())
}

/// 这个 profile 此刻是否被**别的**进程占着。本实例自己托管的进程由调用方先行排除。
///
/// 只有确认「有一个活着的进程正开着这个目录」才回 `true`。检测手段本身失灵（`ps` 起
/// 不来之类）时回 `false`，交给 Chromium 自己的单例逻辑兜底：宁可偶尔让一个窗口开到
/// 别的浏览器里，也不能因为检测失灵把用户永远挡在门外。
#[cfg(unix)]
pub(crate) fn in_use_by_other_process(profile_dir: &Path) -> bool {
    singleton_owner(profile_dir).is_some_and(|pid| process_uses_profile(pid, profile_dir))
}

/// 见 unix 版本的说明。Windows 上认的是 Chromium 独占着的 `lockfile`。
#[cfg(windows)]
pub(crate) fn in_use_by_other_process(profile_dir: &Path) -> bool {
    windows_lock_held(profile_dir)
}

/// `SingletonLock` 里记着的 pid。锁不在或读不懂都返回 `None`。
#[cfg(unix)]
fn singleton_owner(profile_dir: &Path) -> Option<u32> {
    let target = std::fs::read_link(profile_dir.join("SingletonLock")).ok()?;
    // 形如 `<主机名>-<pid>`。主机名里本身可能有 `-`，所以从右边切。
    let (_, pid) = target.to_str()?.rsplit_once('-')?;
    pid.parse().ok()
}

/// 这个 pid 是不是一个开着 `profile_dir` 的进程。
///
/// 只看 pid 活没活不够：崩溃留下的锁里的 pid 可能已经被一个毫不相干的进程复用了，
/// 那样会把用户永远挡在门外。所以要核对它的命令行里确实有这个目录。
#[cfg(target_os = "linux")]
fn process_uses_profile(pid: u32, profile_dir: &Path) -> bool {
    let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return false;
    };
    let wanted = user_data_dir_argument(profile_dir);
    cmdline
        .split(|byte| *byte == 0)
        .any(|argument| argument == wanted.as_bytes())
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_uses_profile(pid: u32, profile_dir: &Path) -> bool {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    match output {
        // 退出码非零就是没有这个进程。
        Ok(output) if output.status.success() => command_line_has_argument(
            &String::from_utf8_lossy(&output.stdout),
            &user_data_dir_argument(profile_dir),
        ),
        _ => false,
    }
}

/// `ps` 把参数用空格拼成一行，而 profile 路径里本身就有空格（macOS 的
/// `Application Support`），所以不能按空格切，只能找整段参数，并要求它后面紧跟空格
/// 或行尾——否则 `…/p1-proxy` 会误认 `…/p1-proxy-old` 这样的目录。
#[cfg(any(test, all(unix, not(target_os = "linux"))))]
fn command_line_has_argument(command_line: &str, argument: &str) -> bool {
    let command_line = command_line.trim_end();
    command_line.match_indices(argument).any(|(start, _)| {
        let rest = &command_line[start + argument.len()..];
        rest.is_empty() || rest.starts_with(' ')
    })
}

#[cfg(windows)]
fn windows_lock_held(profile_dir: &Path) -> bool {
    /// ERROR_SHARING_VIOLATION：Chromium 正以只许别人读的方式开着它。
    const SHARING_VIOLATION: i32 = 32;
    match std::fs::OpenOptions::new()
        .write(true)
        .open(profile_dir.join(WINDOWS_LOCK_FILE))
    {
        Err(error) => error.raw_os_error() == Some(SHARING_VIOLATION),
        // 能以写方式打开就是没人占着：Chromium 关句柄时它本该随之删除，这是残留。
        Ok(_) => false,
    }
}

/// 清掉已经没人持有的单例锁。
///
/// 同一台机器上 Chromium 自己也会清，但它先比对锁里的主机名，而 macOS 没手动设过
/// HostName 时主机名会随网络变；对不上时它会弹「profile 正被另一台电脑使用」并拒绝
/// 启动。调用前已经确认没有本机进程开着这个目录，而这个目录只在本机磁盘上，所以此时
/// 的锁一定是残留。
fn clear_stale_singleton(profile_dir: &Path) {
    #[cfg(unix)]
    for name in SINGLETON_LINKS {
        let path = profile_dir.join(name);
        // 只删符号链接本身；它们指向的临时目录归 Chromium 管。
        if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            let _ = std::fs::remove_file(&path);
        }
    }
    #[cfg(windows)]
    {
        let _ = std::fs::remove_file(profile_dir.join(WINDOWS_LOCK_FILE));
    }
}

/// 清掉旧版本留下的临时 profile：`<app_cache_dir>/browser-sessions/session-<pid>-<纳秒>-<会话号>`。
///
/// 旧版本在浏览器退出时自己删，只有崩溃或被强杀才会留下（审计报告 F-13）。目录名里的
/// pid 是创建它的那个 Vestus 进程：它还活着就不碰——可能是一个还没重启到新版本的实例
/// 正在用。判断不了死活时同样不碰。返回删掉的个数。
pub(crate) fn sweep_legacy_sessions(cache_dir: &Path) -> usize {
    let root = cache_dir.join(LEGACY_SESSIONS_DIR);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return 0;
    };
    let own_pid = std::process::id();
    let mut removed = 0;
    for entry in entries.flatten() {
        // DirEntry::file_type 不跟随符号链接：指向别处的链接一律不碰。
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(pid) = legacy_session_pid(&entry.file_name().to_string_lossy()) else {
            continue;
        };
        if pid == own_pid || process_may_be_alive(pid) {
            continue;
        }
        if remove_dir_with_retries(&entry.path()) {
            removed += 1;
        }
    }
    // 只有空目录删得掉，正好：还有活着的旧实例在用时它会留下。
    let _ = std::fs::remove_dir(&root);
    removed
}

fn legacy_session_pid(name: &str) -> Option<u32> {
    let (pid, _) = name.strip_prefix("session-")?.split_once('-')?;
    pid.parse().ok()
}

#[cfg(target_os = "linux")]
fn process_may_be_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_may_be_alive(pid: u32) -> bool {
    // `kill -0` 不发任何信号，只回答这个进程在不在。别的用户的进程会回失败，这没关系：
    // 旧目录在当前用户的缓存目录里，建它的 Vestus 只可能是当前用户的进程。
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_or(true, |status| status.success())
}

#[cfg(windows)]
fn process_may_be_alive(pid: u32) -> bool {
    use std::os::windows::process::CommandExt as _;

    // 按 CSV 输出时每个字段都带引号，查不到时的那行提示则是本地化的纯文本，所以只认
    // `"<pid>"` 这个形状，不去解析提示文字。
    Command::new(system_tool("tasklist.exe"))
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_or(true, |output| {
            !output.status.success()
                || String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
        })
}

/// 不要让系统工具闪出一个控制台窗口。
#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// System32 下系统工具的绝对路径。
///
/// 不能用裸文件名：CreateProcess 的搜索顺序把**当前进程所在目录**排在系统目录前面，
/// 而 currentUser 安装模式下那个目录普通用户可写，放一个同名 exe 就能劫持这次调用。
#[cfg(windows)]
pub(crate) fn system_tool(name: &str) -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join(name)
}

/// 重置失败的原因。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ResetError {
    /// 有环境正被别的进程占着，一个都没删。
    Busy,
    /// 删到一半失败了，已经删掉的不会恢复。
    Io(String),
}

/// 删掉一个账号在本机的全部环境。先确认一个都没被占着再动手，免得删一半。
///
/// 调用方必须先关掉本实例自己开着的浏览器：这里只认得出别的进程。
pub(crate) fn remove_account(account_dir: &Path) -> Result<usize, ResetError> {
    let entries = match std::fs::read_dir(account_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(ResetError::Io(error.to_string())),
    };
    let environments: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    if environments.iter().any(|dir| in_use_by_other_process(dir)) {
        return Err(ResetError::Busy);
    }
    for dir in &environments {
        if !remove_dir_with_retries(dir) {
            return Err(ResetError::Io(format!("删不掉 {}", dir.display())));
        }
    }
    if !remove_dir_with_retries(account_dir) {
        return Err(ResetError::Io(format!("删不掉 {}", account_dir.display())));
    }
    Ok(environments.len())
}

fn remove_dir_with_retries(path: &Path) -> bool {
    for attempt in 1..=REMOVE_ATTEMPTS {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) if attempt < REMOVE_ATTEMPTS => thread::sleep(REMOVE_RETRY_DELAY),
            Err(_) => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    const API: &str = "https://api.example.test/vestus";

    fn scratch(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "vestus-profile-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spec(profile_key: &str, platform_id: i64, direct_mode: bool) -> ProfileSpec<'_> {
        ProfileSpec {
            api_base: API,
            profile_key,
            platform_id,
            direct_mode,
        }
    }

    /// 同一台电脑、同一个账号、同一个平台，每次都必须落回同一个目录——这就是「持久」。
    #[test]
    fn the_same_environment_always_maps_to_the_same_directory() {
        let root = Path::new("/data/browser-profiles");
        assert_eq!(
            profile_dir(root, &spec("user-7", 3, false)),
            profile_dir(root, &spec("user-7", 3, false))
        );
    }

    /// 单电脑多账号、多套服务器、多个平台、代理与直连：任何一维不同都必须是不同的环境。
    #[test]
    fn every_isolation_dimension_yields_a_distinct_directory() {
        let root = Path::new("/data/browser-profiles");
        let base = profile_dir(root, &spec("user-7", 3, false));
        let other_user = profile_dir(root, &spec("user-8", 3, false));
        let other_platform = profile_dir(root, &spec("user-7", 4, false));
        let direct = profile_dir(root, &spec("user-7", 3, true));
        let other_server = profile_dir(
            root,
            &ProfileSpec {
                api_base: "https://staging.example.test/vestus",
                ..spec("user-7", 3, false)
            },
        );
        let all = [&base, &other_user, &other_platform, &direct, &other_server];
        for (index, left) in all.iter().enumerate() {
            for right in &all[index + 1..] {
                assert_ne!(left, right);
            }
        }
        // 同一账号的各个环境都在同一个账号目录下，重置才能一次删干净。
        let account = account_dir(root, API, "user-7");
        assert!(base.starts_with(&account));
        assert!(other_platform.starts_with(&account));
        assert!(direct.starts_with(&account));
        assert!(!other_user.starts_with(&account));
    }

    /// 字段边界不能靠拼接：("a", "bc") 与 ("ab", "c") 必须是两个账号。
    #[test]
    fn account_digest_keeps_field_boundaries() {
        assert_ne!(account_dir_name("a", "bc"), account_dir_name("ab", "c"));
    }

    /// 服务端下发的 profileKey 是不可信字符串，它绝不能决定目录层级。
    #[test]
    fn hostile_profile_keys_never_leave_the_account_layer() {
        let root = Path::new("/data/browser-profiles");
        for key in ["../../etc", "/abs/path", r"..\..\Windows", "CON", "a/b", "用户 7"] {
            let dir = profile_dir(root, &spec(key, 1, false));
            let relative = dir.strip_prefix(root).unwrap();
            let components: Vec<_> = relative.components().collect();
            assert_eq!(components.len(), 2, "{key} 产出了额外的目录层级");
            let name = components[0].as_os_str().to_str().unwrap();
            assert_eq!(name.len(), ACCOUNT_DIGEST_CHARS);
            assert!(name.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn environment_names_encode_platform_and_mode_only() {
        assert_eq!(environment_dir_name(12, false), "p12-proxy");
        assert_eq!(environment_dir_name(12, true), "p12-direct");
    }

    /// 随包浏览器直接用根目录；开发期换了可执行文件要落进各自的子目录，免得不同的
    /// Chromium 互相读写对方的 profile。
    #[test]
    fn non_bundled_browsers_get_their_own_root() {
        let data = Path::new("/data");
        let bundled = profiles_root(data, Path::new("/opt/vestus/chromium/chrome"), true);
        assert_eq!(bundled, data.join(PROFILES_DIR));
        let system = profiles_root(
            data,
            Path::new("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            false,
        );
        let other = profiles_root(data, Path::new("/opt/chromium/chrome"), false);
        assert!(system.starts_with(&bundled));
        assert_ne!(system, bundled);
        assert_ne!(system, other);
    }

    #[test]
    fn user_data_dir_argument_is_the_single_source_of_the_flag() {
        assert_eq!(
            user_data_dir_argument(Path::new("/tmp/p1-proxy")),
            "--user-data-dir=/tmp/p1-proxy"
        );
    }

    /// 参数必须整段匹配：路径里的空格不能切断它，相邻目录名也不能被误认。
    #[test]
    fn command_line_matching_requires_the_whole_argument() {
        let argument = "--user-data-dir=/Users/a/Library/Application Support/x/p1-proxy";
        assert!(command_line_has_argument(
            "/chrome --user-data-dir=/Users/a/Library/Application Support/x/p1-proxy --no-first-run",
            argument
        ));
        assert!(command_line_has_argument(
            "/chrome --user-data-dir=/Users/a/Library/Application Support/x/p1-proxy\n",
            argument
        ));
        assert!(!command_line_has_argument(
            "/chrome --user-data-dir=/Users/a/Library/Application Support/x/p1-proxy-old",
            argument
        ));
        assert!(!command_line_has_argument("/chrome --no-first-run", argument));
    }

    #[test]
    fn legacy_session_names_yield_their_creator_pid() {
        assert_eq!(
            legacy_session_pid("session-4242-1790221492000000000-3"),
            Some(4242)
        );
        assert_eq!(legacy_session_pid("session-x-1-2"), None);
        assert_eq!(legacy_session_pid("p1-proxy"), None);
        assert_eq!(legacy_session_pid("session-"), None);
    }

    /// 旧临时目录：建它的进程死了才删，还活着（包括我们自己）的一律不碰。
    #[test]
    fn legacy_sweep_removes_only_directories_of_dead_processes() {
        let cache = scratch("sweep");
        let sessions = cache.join(LEGACY_SESSIONS_DIR);
        // 一个刚刚退出的进程的 pid：短时间内不会被复用。
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .args(if cfg!(windows) { &["/C", "exit"][..] } else { &[][..] })
            .spawn()
            .unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        let dead = sessions.join(format!("session-{dead_pid}-1-1"));
        let alive = sessions.join(format!("session-{}-1-2", std::process::id()));
        let foreign = sessions.join("not-a-session");
        for dir in [&dead, &alive, &foreign] {
            std::fs::create_dir_all(dir.join("Default")).unwrap();
        }

        assert_eq!(sweep_legacy_sessions(&cache), 1);
        assert!(!dead.exists());
        assert!(alive.exists());
        assert!(foreign.exists());
        let _ = std::fs::remove_dir_all(cache);
    }

    #[test]
    fn legacy_sweep_without_the_old_directory_is_a_no_op() {
        let cache = scratch("sweep-empty");
        assert_eq!(sweep_legacy_sessions(&cache), 0);
        let _ = std::fs::remove_dir_all(cache);
    }

    /// 上一次运行留下的端口文件和（已经没人持有的）单例锁都要在启动前清掉。
    #[test]
    fn prepare_clears_leftovers_of_the_previous_run() {
        let dir = scratch("prepare");
        std::fs::write(dir.join(DEVTOOLS_PORT_FILE), "51234\n/devtools/browser/old\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("testhost-999999999", dir.join("SingletonLock")).unwrap();
        std::fs::write(dir.join("Cookies"), b"keep me").unwrap();

        assert_eq!(prepare_for_launch(&dir), Ok(()));
        assert!(!dir.join(DEVTOOLS_PORT_FILE).exists());
        assert!(std::fs::symlink_metadata(dir.join("SingletonLock")).is_err());
        // 真正的环境数据一个字节都不能动。
        assert_eq!(std::fs::read(dir.join("Cookies")).unwrap(), b"keep me");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 单例锁指向一个真的开着这个目录的进程：必须认出来，而且不能碰它的任何文件。
    #[cfg(unix)]
    #[test]
    fn a_live_owner_of_the_profile_is_detected_and_left_alone() {
        let dir = scratch("owner");
        // 多一条 `:` 让 sh 不把 sleep 直接 exec 掉，命令行里于是一直带着这个参数。
        let mut owner = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30; :", "vestus-test"])
            .arg(user_data_dir_argument(&dir))
            .spawn()
            .unwrap();
        std::os::unix::fs::symlink(
            format!("testhost-{}", owner.id()),
            dir.join("SingletonLock"),
        )
        .unwrap();
        std::fs::write(dir.join(DEVTOOLS_PORT_FILE), "51234\n/devtools/browser/live\n").unwrap();

        assert!(in_use_by_other_process(&dir));
        assert_eq!(prepare_for_launch(&dir), Err(ProfileBusy));
        assert!(dir.join(DEVTOOLS_PORT_FILE).exists());
        assert!(std::fs::symlink_metadata(dir.join("SingletonLock")).is_ok());

        owner.kill().unwrap();
        owner.wait().unwrap();
        assert!(!in_use_by_other_process(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 锁里的 pid 活着、却不是开着这个目录的进程（pid 被复用了）：这是残留，不能把
    /// 用户挡在门外。用测试进程自己的 pid 模拟。
    #[cfg(unix)]
    #[test]
    fn a_reused_pid_in_a_stale_lock_is_not_an_owner() {
        let dir = scratch("reused");
        std::os::unix::fs::symlink(
            format!("testhost-{}", std::process::id()),
            dir.join("SingletonLock"),
        )
        .unwrap();
        assert!(!in_use_by_other_process(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Windows 上占用的标志是 Chromium 以只读共享方式开着的 lockfile。
    #[cfg(windows)]
    #[test]
    fn a_held_windows_lockfile_means_in_use() {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_SHARE_READ: u32 = 0x1;

        let dir = scratch("lockfile");
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(FILE_SHARE_READ)
            .open(dir.join(WINDOWS_LOCK_FILE))
            .unwrap();
        assert!(in_use_by_other_process(&dir));
        drop(held);
        assert!(!in_use_by_other_process(&dir));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reset_removes_every_environment_of_one_account_only() {
        let root = scratch("reset");
        let mine = account_dir(&root, API, "user-7");
        let theirs = account_dir(&root, API, "user-8");
        for dir in [
            profile_dir(&root, &spec("user-7", 1, false)),
            profile_dir(&root, &spec("user-7", 1, true)),
            profile_dir(&root, &spec("user-7", 2, false)),
            profile_dir(&root, &spec("user-8", 1, false)),
        ] {
            std::fs::create_dir_all(dir.join("Default")).unwrap();
            std::fs::write(dir.join("Default").join("Cookies"), b"x").unwrap();
        }

        assert_eq!(remove_account(&mine), Ok(3));
        assert!(!mine.exists());
        assert!(theirs.exists());
        // 再删一次：已经没有了，不算错。
        assert_eq!(remove_account(&mine), Ok(0));
        let _ = std::fs::remove_dir_all(root);
    }

    /// 只要有一个环境正被别的进程开着，就一个都不删。
    #[cfg(unix)]
    #[test]
    fn reset_refuses_while_another_process_holds_an_environment() {
        let root = scratch("reset-busy");
        let busy = profile_dir(&root, &spec("user-7", 1, false));
        let idle = profile_dir(&root, &spec("user-7", 2, false));
        std::fs::create_dir_all(&busy).unwrap();
        std::fs::create_dir_all(&idle).unwrap();
        let mut owner = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30; :", "vestus-test"])
            .arg(user_data_dir_argument(&busy))
            .spawn()
            .unwrap();
        std::os::unix::fs::symlink(
            format!("testhost-{}", owner.id()),
            busy.join("SingletonLock"),
        )
        .unwrap();

        assert_eq!(
            remove_account(&account_dir(&root, API, "user-7")),
            Err(ResetError::Busy)
        );
        assert!(busy.exists());
        assert!(idle.exists());

        owner.kill().unwrap();
        owner.wait().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }
}
