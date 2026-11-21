//! URL-only Chrome DevTools Protocol collector.
//!
//! Browser-level `Target.setAutoAttach` covers initial tabs, new tabs and popups.
//! Each page enables `Page` and gets one initial `Page.getFrameTree` seed; main-frame
//! `Page.frameNavigated` and `Page.navigatedWithinDocument` report subsequent visits.
//! A navigation observed while the initial tree is in flight wins over that reply.
//! New reports contain only normalized URL, existing sanitized query parameters and
//! one visit. No activity script, Runtime subscription, bindings, interactions,
//! dwell time or form values are collected. Legacy fields remain for queued data.
//!
//! Managed sessions alone install the fixed login guard before resuming targets.
//! The guard's input/change handlers are safety controls, not telemetry. Every
//! attached target, including workers, is resumed before a non-page detach.
//!
//! # 唯一的控制命令
//!
//! 采集通道只读（边界见 `desktop/scripts/check-surface-boundaries.mjs`）。唯一的例外
//! 是 [`request_exit`]：持久 profile 必须让浏览器按正常流程退出才能把 Cookie 落盘，
//! 而 `Browser.close` 做的正是这件事——它的能力比我们本来就在用的强杀进程还小，
//! 也碰不到任何页面。它走一条用完就断的短连接，不碰采集那一条。

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::timeout;
use tokio_tungstenite::client_async_with_config;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use url::Url;

use crate::browser::DevToolsEndpoint;

/// CDP 消息上限。只订阅 Target/Page 的少量事件，正常都在 1 KiB 量级。
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// 连接 DevTools 端点的超时。端口是从 `DevToolsActivePort` 读出来的，连不上说明
/// 浏览器已经不在了，等下去没有意义。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 一次性控制命令从连接到收到回执的总上限。都在本机回环上，正常几毫秒就完；
/// 调用方（关浏览器、开窗口）还在后面等着，不能被一个卡住的端点拖太久。
const CONTROL_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);

/// 控制连接上唯一一条命令的 id。连接只发这一条，用完即断。
const CONTROL_COMMAND_ID: i64 = 1;

/// 剥掉 query 之后仍然超长的 URL 直接不记：截断会产出一个并不存在的地址，
/// 而完整保留会让内存和数据库列被一条病态路径占住。
const MAX_URL_BYTES: usize = 500;

/// 经过脱敏后的 query 最大字节数，给单页聚合键和上报体留出硬上限。
const MAX_URL_PARAMS_BYTES: usize = 4096;
const MAX_URL_PARAM_PAIRS: usize = 200;

/// Legacy queued form snapshots remain readable; new collection never creates them.
pub type FormSnapshot = BTreeMap<String, Vec<String>>;

/// 一个页面的一次上报。聚合发生在 [`crate::activity`]，这里只负责翻译。
///
/// New reports have `visits = 1`; all legacy interaction/dwell/snapshot fields
/// remain empty. Those fields are retained only to read already queued records.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageReport {
    /// 已经剥掉 query 和 fragment 的地址。
    pub url: String,
    /// 已在浏览器侧脱敏的 query（不含 `?`）。
    pub url_params: Option<String>,
    pub visits: u32,
    pub clicks: u32,
    pub inputs: u32,
    pub submits: u32,
    pub scrolls: u32,
    /// 自上一次上报以来的停留毫秒数（增量，不含页面在后台的时间）。因为是增量，
    /// 聚合时直接相加即可，同一个地址被访问两次也不会互相覆盖。
    pub dwell_ms: u64,
    /// 自上次 flush 后最新的一份 input/change 表单快照。
    pub input_snapshot: Option<FormSnapshot>,
    /// 由聚合器赋值的 input 快照接收时间；页面侧永远传 0。
    pub input_snapshot_at_ms: u64,
    /// 自上次 flush 后最新的一份 submit 表单快照。
    pub submit_snapshot: Option<FormSnapshot>,
    /// 由聚合器赋值的 submit 快照接收时间；页面侧永远传 0。
    pub submit_snapshot_at_ms: u64,
}

impl PageReport {
    fn visit_parts(url: String, url_params: Option<String>) -> Self {
        Self {
            url,
            url_params,
            visits: 1,
            ..Self::default()
        }
    }
}

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum CdpError {
    #[error("连接调试端点失败：{0}")]
    Connect(String),
    #[error("调试端点握手失败：{0}")]
    Handshake(String),
    #[error("调试通道中断：{0}")]
    Transport(String),
    #[error("浏览器拒绝了调试命令：{0}")]
    Command(String),
    #[error("浏览器中没有已打开的平台页面")]
    NoMatchingPage,
    #[error("等待浏览器回执超时")]
    Timeout,
}

/// 连上一个 browser 级端点。
async fn connect(endpoint: &DevToolsEndpoint) -> Result<WebSocketStream<TcpStream>, CdpError> {
    let stream = timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect(("127.0.0.1", endpoint.port)),
    )
    .await
    .map_err(|_| CdpError::Connect("等待连接超时".to_string()))?
    .map_err(|error| CdpError::Connect(error.to_string()))?;
    let _ = stream.set_nodelay(true);

    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES));
    // 不带 Origin 头：Chromium 会拒掉带 Origin 的 DevTools 请求，除非启动时给了
    // --remote-allow-origins，而我们故意没给。tungstenite 本身不加这个头。
    let (socket, _) = client_async_with_config(endpoint.websocket_url(), stream, Some(config))
        .await
        .map_err(|error| CdpError::Handshake(error.to_string()))?;
    Ok(socket)
}

/// 托管监控器通过采集连接发出的信号。
#[derive(Debug, Clone, Copy)]
pub(crate) enum ManagedSignal {
    /// 平台登出，或登录页停留超过观察窗：按凭据过期流程处理。
    Expired,
    /// 采集调试连接断开：本地防护故障，关闭浏览器但不动凭据。
    ConnectionLost,
    /// An unprotected additional page was removed; other pages remain monitored.
    PageClosed { reason: &'static str },
}

/// 托管会话在采集连接上的采集注入物：第二层固定登录脚本（初始页）+ 事件监控器 + 信号出口。
///
/// 登录页交互锁的主防线是随包 MV3 扩展（document_start 注入，托管启动时由
/// `managed_cdp::write_login_guard_extension` 写入 profile 并以 `--load-extension`
/// 加载）。采集连接不再暂停任何 target：暂停会把 noopener 弹窗的防护回执拖成
/// 回执循环（实测 Chrome/157）。事件流同时喂给活动采集与登录/登出检测。
pub(crate) struct ManagedWatch {
    pub(crate) login_guard_script: String,
    pub(crate) monitor: crate::managed_cdp::ManagedSessionMonitor,
    pub(crate) signals: tokio::sync::mpsc::UnboundedSender<ManagedSignal>,
    /// watcher 只读复核的判定阶段；与 monitor 共享同一原子值。
    pub(crate) status: crate::managed_cdp::LoginGuardStatusView,
    /// guard 安装完成的就绪闩；命令层据此决定何时 Page.navigate。
    pub(crate) guard_installed: crate::managed_cdp::GuardInstalled,
}

struct ManagedCollectorState {
    login_guard_script: String,
    signals: tokio::sync::mpsc::UnboundedSender<ManagedSignal>,
    monitor: crate::managed_cdp::ManagedSessionMonitor,
    guard_installed: crate::managed_cdp::GuardInstalled,
}

/// 把一个 Chromium 进程的活动采集到 `sink`，直到调试通道关闭（通常就是浏览器退出）。
///
/// 返回 `Ok(())` 表示通道正常结束。任何错误都不该冒到用户面前：浏览器本身不依赖
/// 这条通道，采集失败只意味着这次会话没有日志。托管模式下连接结束（无论正常还是
/// 传输错误）都会发出 [`ManagedSignal::ConnectionLost`]，由消费方判断浏览器是否
/// 仍在运行再决定是否按防护故障处理。
pub async fn collect(
    endpoint: DevToolsEndpoint,
    sink: UnboundedSender<PageReport>,
    managed: Option<ManagedWatch>,
) -> Result<(), CdpError> {
    let status = managed.as_ref().map(|watch| watch.status.clone());
    let signals = managed.as_ref().map(|watch| watch.signals.clone());
    let result = collect_events(endpoint, sink, managed).await;
    // 撤销旧 Expired 后再通知，排队的失效信号不能掩盖断连。
    if let Some(status) = status {
        status.mark_monitor_gone();
    }
    if let Some(signals) = signals {
        let _ = signals.send(ManagedSignal::ConnectionLost);
    }
    result
}

async fn collect_events(
    endpoint: DevToolsEndpoint,
    sink: UnboundedSender<PageReport>,
    managed: Option<ManagedWatch>,
) -> Result<(), CdpError> {
    let socket = connect(&endpoint).await?;
    let managed_state = managed.map(|watch| ManagedCollectorState {
        login_guard_script: watch.login_guard_script,
        signals: watch.signals,
        monitor: watch.monitor,
        guard_installed: watch.guard_installed,
    });

    let (mut writer, mut reader) = socket.split();
    let mut collector = Collector {
        managed: managed_state,
        ..Collector::default()
    };
    for command in collector.opening_commands() {
        timeout(
            crate::managed_cdp::GUARD_INSTALL_TIMEOUT,
            writer.send(Message::Text(command.into())),
        )
        .await
        .map_err(|_| CdpError::Transport("collector write timed out".into()))?
        .map_err(|error| CdpError::Transport(error.to_string()))?;
    }

    loop {
        let expired = collector.expire_setup();
        if expired.guard_failed {
            return Err(CdpError::Command(
                "managed page initialization timed out".into(),
            ));
        }
        for command in expired.commands {
            timeout(
                crate::managed_cdp::GUARD_INSTALL_TIMEOUT,
                writer.send(Message::Text(command.into())),
            )
            .await
            .map_err(|_| CdpError::Transport("collector write timed out".into()))?
            .map_err(|error| CdpError::Transport(error.to_string()))?;
        }
        let setup_deadline = collector.setup_deadline();
        let deadline = collector
            .managed
            .as_ref()
            .and_then(|state| state.monitor.login_deadline());
        let frame = tokio::select! {
            // Process ready navigation/close before an overdue timer when the
            // collector resumes after a delayed scheduler wakeup.
            biased;
            frame = reader.next() => frame,
            _ = async {
                if let Some(deadline) = setup_deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => continue,
            _ = async {
                if let Some(deadline) = deadline {
                    tokio::time::sleep_until(deadline).await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                // Let queued Page.frameStartedLoading / lifecycle events clear a
                // superseded login deadline before publishing Expired. The
                // downstream watcher has a separate status recheck, but the
                // collector must also avoid emitting a stale raw signal.
                tokio::time::sleep(crate::managed_cdp::LOGIN_EXPIRY_CONFIRM_GRACE).await;
                if let Some(state) = collector.managed.as_mut() {
                    if state.monitor.expire_due() {
                        let _ = state.signals.send(ManagedSignal::Expired);
                    }
                }
                continue;
            }
        };
        let Some(frame) = frame else { break };
        let message = frame.map_err(|error| CdpError::Transport(error.to_string()))?;
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            // Ping/Pong 由 tungstenite 自动应答，二进制帧 CDP 不会发。
            _ => continue,
        };
        let handled = collector.handle(&text);
        if handled.guard_failed {
            return Err(CdpError::Command(
                "managed guard installation failed".into(),
            ));
        }
        for report in handled.reports {
            // 接收端没了说明这次会话已经收尾，继续采集没有意义。
            if sink.send(report).is_err() {
                return Ok(());
            }
        }
        for command in &handled.commands {
            timeout(
                crate::managed_cdp::GUARD_INSTALL_TIMEOUT,
                writer.send(Message::Text(command.clone().into())),
            )
            .await
            .map_err(|_| CdpError::Transport("collector write timed out".into()))?
            .map_err(|error| CdpError::Transport(error.to_string()))?;
        }
    }
    Ok(())
}

/// 请浏览器正常退出。
///
/// Chromium 对 `Browser.close` 的实现是忽略 beforeunload 的正常退出：页面的「确定要
/// 离开吗」拦不住它，走的是和用户退出一样的完整流程，Cookie 与站点存储都会落盘。
/// 它可能来不及回执就断开连接，那本身就说明它已经在退出了。
pub async fn request_exit(endpoint: &DevToolsEndpoint) -> Result<(), CdpError> {
    match control_command(endpoint, "Browser.close", json!({})).await {
        Ok(_) | Err(CdpError::Transport(_)) => Ok(()),
        Err(error) => Err(error),
    }
}

/// 在一条独立的短连接上发一条 browser 级命令，等到它的回执为止。
///
/// 不借用采集连接：那条连接跑在活动上报的后台任务里，没有往里递命令的通道，命令 id
/// 也归 [`Collector`] 管。Chromium 允许同时挂多条 DevTools 连接，另起一条最简单，
/// 采集那边完全不受影响。
async fn control_command(
    endpoint: &DevToolsEndpoint,
    method: &str,
    params: Value,
) -> Result<Value, CdpError> {
    let exchange = async {
        let socket = connect(endpoint).await?;
        let (mut writer, mut reader) = socket.split();
        writer
            .send(Message::Text(
                control_command_message(method, params).into(),
            ))
            .await
            .map_err(|error| CdpError::Transport(error.to_string()))?;
        while let Some(frame) = reader.next().await {
            let text = match frame.map_err(|error| CdpError::Transport(error.to_string()))? {
                Message::Text(text) => text,
                Message::Close(_) => break,
                _ => continue,
            };
            // 回执之前可能先到几条事件，跳过就是。
            if let Some(outcome) = control_command_outcome(&text) {
                return outcome;
            }
        }
        Err(CdpError::Transport("调试通道在回执之前关闭".to_string()))
    };
    match timeout(CONTROL_COMMAND_TIMEOUT, exchange).await {
        Ok(outcome) => outcome,
        Err(_) => Err(CdpError::Timeout),
    }
}

fn control_command_message(method: &str, params: Value) -> String {
    json!({ "id": CONTROL_COMMAND_ID, "method": method, "params": params }).to_string()
}

/// 认出控制命令的回执：成功给 `result`，协议错误给错误信息，别的消息一律 `None`。
fn control_command_outcome(text: &str) -> Option<Result<Value, CdpError>> {
    let message: Value = serde_json::from_str(text).ok()?;
    if message.get("id").and_then(Value::as_i64) != Some(CONTROL_COMMAND_ID) {
        return None;
    }
    if let Some(error) = message.get("error") {
        let detail = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        return Some(Err(CdpError::Command(detail.to_string())));
    }
    Some(Ok(message.get("result").cloned().unwrap_or(Value::Null)))
}

/// 在已运行的浏览器里打开一个平台地址的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageOutcome {
    /// 已有该平台的标签页，把它切到了最前（页面内容原样保留）。
    Activated,
}

/// 在已运行的浏览器里激活 `platform_url` 对应的已存在页面。
///
/// 「同域名」看的是 host 相等——平台入口页和它域名下的业务页都算同一平台的标签；
/// `chrome://`、`about:blank` 这类没有 host 的页面永远不匹配。切回用的是
/// `Target.activateTarget`，与用户手动点那个标签等效，不读也不改页面内容。没有匹配
/// 页面时返回错误，绝不创建新标签。
pub async fn open_or_activate_page(
    endpoint: &DevToolsEndpoint,
    platform_url: &str,
) -> Result<PageOutcome, CdpError> {
    let platform = url::Url::parse(platform_url)
        .map_err(|error| CdpError::Command(format!("平台地址无法解析：{error}")))?;
    let targets = page_targets(endpoint).await?;
    if let Some(target_id) = matching_page_target(&targets, &platform) {
        let activate = control_command(
            endpoint,
            "Target.activateTarget",
            json!({ "targetId": target_id }),
        )
        .await;
        if activate.is_ok() {
            return Ok(PageOutcome::Activated);
        }
        // 标签在列举和切换之间被用户关掉了：当作没有，返回失败。
    }
    Err(CdpError::NoMatchingPage)
}

/// 当前浏览器里全部页面级标签页的 `(targetId, url)`。
async fn page_targets(endpoint: &DevToolsEndpoint) -> Result<Vec<(String, String)>, CdpError> {
    let result = control_command(endpoint, "Target.getTargets", json!({})).await?;
    Ok(page_targets_from_result(&result))
}

/// 从 `Target.getTargets` 的回执里挑出页面级标签。独立成纯函数便于测试。
fn page_targets_from_result(result: &Value) -> Vec<(String, String)> {
    result
        .get("targetInfos")
        .and_then(Value::as_array)
        .map(|infos| {
            infos
                .iter()
                .filter_map(|info| {
                    if info.get("type").and_then(Value::as_str) != Some("page") {
                        return None;
                    }
                    let id = info.get("targetId").and_then(Value::as_str)?.to_string();
                    let url = info.get("url").and_then(Value::as_str)?.to_string();
                    Some((id, url))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 标签页地址与平台入口是否属于同一个站点：host 相等即算，query 无关。
fn page_url_matches(page_url: &str, platform: &url::Url) -> bool {
    url::Url::parse(page_url)
        .ok()
        .zip(platform.host_str())
        .is_some_and(|(page, platform_host)| page.host_str() == Some(platform_host))
}

fn matching_page_target(targets: &[(String, String)], platform: &url::Url) -> Option<String> {
    targets
        .iter()
        .find(|(_, page_url)| page_url_matches(page_url, platform))
        .map(|(target_id, _)| target_id.clone())
}

/// 只留 scheme + host + port + path，别的一概不要。
///
/// `url` 只保留 scheme + host + port + path；query 单独脱敏后写入 `url_params`，
/// fragment 与凭据一起丢弃。非 http(s) 的地址（`about:blank`、`chrome://`、
/// `devtools://`）不是「访问了一个页面」，直接丢。
#[allow(dead_code)]
pub fn normalize_url(raw: &str) -> Option<String> {
    normalize_page_url(raw).map(|(url, _)| url)
}

/// 规范化地址并在剥离 URL 前单独保留安全的 query。
fn normalize_page_url(raw: &str) -> Option<(String, Option<String>)> {
    let mut url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let url_params = url
        .query()
        .filter(|query| !query.is_empty())
        .and_then(redact_query);
    url.set_query(None);
    url.set_fragment(None);
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    let normalized: String = url.into();
    // 剥完还超长的只能是病态路径：截断会造出一个并不存在的地址，所以宁可不记。
    Some((normalized, url_params)).filter(|(url, _)| url.len() <= MAX_URL_BYTES)
}

fn redact_query(query: &str) -> Option<String> {
    let mut rendered = String::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()).take(MAX_URL_PARAM_PAIRS) {
        let value = if is_sensitive_key(&key) {
            "[REDACTED]"
        } else {
            value.as_ref()
        };
        let pair = backend_urlencode_pair(&key, value);
        let extra_bytes = pair.len() + usize::from(!rendered.is_empty());
        // A pair is all-or-nothing: never truncate in the middle of `%HH` or a
        // UTF-8 sequence, and retain the canonical form the server will parse.
        if rendered.len().saturating_add(extra_bytes) > MAX_URL_PARAMS_BYTES {
            continue;
        }
        if !rendered.is_empty() {
            rendered.push('&');
        }
        rendered.push_str(&pair);
    }
    (!rendered.is_empty()).then_some(rendered)
}

/// Match Python's ``urllib.parse.urlencode`` byte-for-byte. The WHATWG form
/// serializer used by `url` disagrees specifically on `*` and `~`; letting the
/// server re-encode those near the limit could turn a valid 4096-byte value into
/// a rejected one.
fn backend_urlencode_pair(key: &str, value: &str) -> String {
    let mut encoded = backend_quote_plus(key);
    encoded.push('=');
    encoded.push_str(&backend_quote_plus(value));
    encoded
}

fn backend_quote_plus(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(char::from(byte))
            }
            b' ' => encoded.push('+'),
            _ => {
                encoded.push('%');
                encoded.push(char::from(HEX[usize::from(byte >> 4)]));
                encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
            }
        }
    }
    encoded
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key
        .to_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    [
        "password",
        "passwd",
        "pwd",
        "token",
        "secret",
        "authorization",
        "cookie",
        "session",
        "otp",
        "captcha",
        "cvv",
        "cvc",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

/// 一条消息处理完之后要做的两件事。
#[derive(Debug, Default, PartialEq, Eq)]
struct Handled {
    commands: Vec<String>,
    reports: Vec<PageReport>,
    /// 本批处理包含一次托管 page 的完整 install+放行，guard 已就位。
    guard_installed: bool,
    guard_failed: bool,
}

/// 协议状态机。刻意不碰 IO，于是整套分支都能在没有浏览器的情况下测。
struct Collector {
    /// 托管会话的登录/登出检测与登录页交互锁脚本；普通会话为 None。
    managed: Option<ManagedCollectorState>,
    next_id: i64,
    /// `Target.getTargets` 的请求 id，用来认出那一条回执。
    get_targets_id: i64,
    /// 已经装好采集的 page 级 session → 它所在的 targetId。
    ///
    /// 键用于确认事件来自我们自己装过的 session；值用于**按 target 去重**。
    ///
    /// 必须按 target 去重，不能只按 session 去重：同一个页面会从两条路各附一次
    /// （`setAutoAttach` 一次、`getTargets` 后的显式 `attachToTarget` 又一次），
    /// 两次拿到的是**两个不同的 sessionId**，只看 sessionId 认不出这是同一个页面。
    /// 装两遍的后果是这个页面的每个事件都被算两遍：`Page.frameNavigated` 双份，于是管理台看到的访问数虚高。
    sessions: HashMap<String, PageSession>,
    /// Exactly one initial frame-tree request per installed target.
    frame_tree_requests: HashMap<i64, String>,
    guard_requests: HashMap<i64, GuardRequest>,
    closing_targets: HashMap<String, ClosingTarget>,
    close_requests: HashMap<i64, CloseRequest>,
}

struct ClosingTarget {
    reason: &'static str,
    deadline: tokio::time::Instant,
    retry_at: Option<tokio::time::Instant>,
    initial: bool,
    notify: bool,
}

#[derive(Clone)]
enum CloseRequest {
    Close(String),
    Verify(String),
    Detached(String),
}

#[derive(Clone)]
enum GuardRequest {
    /// 初始托管页的完整安装回执（扩展防护之外的第二层 + 就绪闩）。
    Install(String),
    /// 后续页面的采集订阅回执（enable / tree / lifecycle）。
    Monitor(String),
    AutoAttach,
}

#[derive(Default)]
struct PageSession {
    target_id: String,
    initial: bool,
    deadline: Option<tokio::time::Instant>,
    main_frame_id: Option<String>,
    navigation_seen: bool,
    /// Only suppress the initial event for the document already seeded by its tree.
    seeded_document: Option<(String, String, Option<String>)>,
    /// Only while the initial frame id is unknown; normalized before retention.
    /// Keep at most 64 ordered events. Overflow drops oldest and warns once.
    pending_spa: VecDeque<(String, Option<PageReport>, bool)>,
    pending_spa_overflow: bool,
}

impl Default for Collector {
    fn default() -> Self {
        Self {
            managed: None,
            next_id: 0,
            get_targets_id: 0,
            sessions: HashMap::new(),
            frame_tree_requests: HashMap::new(),
            guard_requests: HashMap::new(),
            closing_targets: HashMap::new(),
            close_requests: HashMap::new(),
        }
    }
}

impl Collector {
    /// 连上之后立刻发的两条命令。
    ///
    /// `setAutoAttach` 覆盖之后新建的标签页和弹窗；`getTargets` 是为了补上连接建立
    /// 之前就存在的那一个初始标签页——它不会再触发 `attachedToTarget`。
    fn opening_commands(&mut self) -> Vec<String> {
        // 托管防护由随包扩展在 document_start 注入。暂停新 target 会和扩展路径
        // 形成回执循环（实测 noopener 弹窗的防护安装回执要等 resume 才返回），
        // 所以托管不再暂停；普通采集保留暂停+立即放行的原有模型。
        let wait_for_debugger = self.managed.is_none();
        let auto_attach = self.command(
            None,
            "Target.setAutoAttach",
            json!({
                "autoAttach": true,
                "waitForDebuggerOnStart": wait_for_debugger,
                // flatten 把子 session 复用同一条 WebSocket，靠 sessionId 区分。
                "flatten": true,
            }),
        );
        if self.managed.is_some() {
            self.guard_requests
                .insert(self.next_id, GuardRequest::AutoAttach);
        }
        let get_targets = self.command(None, "Target.getTargets", json!({}));
        self.get_targets_id = self.next_id;
        vec![auto_attach, get_targets]
    }

    fn command(&mut self, session: Option<&str>, method: &str, params: Value) -> String {
        self.next_id += 1;
        let mut message = json!({ "id": self.next_id, "method": method, "params": params });
        if let Some(session_id) = session {
            message["sessionId"] = Value::String(session_id.to_string());
        }
        message.to_string()
    }

    /// 初始托管页在扩展防护之外再装一层固定 guard 并等全部回执就绪；后续页只装
    /// 采集订阅。都不暂停：页面立即运行，登录锁定由扩展的 document_start 保证。
    fn install(&mut self, session_id: &str) -> Vec<String> {
        let managed = self.managed.is_some();
        let initial = self
            .sessions
            .get(session_id)
            .is_some_and(|page| page.initial);
        let tracked = |collector: &mut Self, kind: fn(String) -> GuardRequest| {
            collector
                .guard_requests
                .insert(collector.next_id, kind(session_id.to_string()));
        };
        let mut commands = Vec::new();
        if let Some(state) = self.managed.as_ref() {
            if initial {
                commands.push(self.command(
                    Some(session_id),
                    "Page.addScriptToEvaluateOnNewDocument",
                    json!({"source": state.login_guard_script.clone(), "runImmediately": true}),
                ));
                tracked(self, GuardRequest::Install);
            }
        }
        commands.push(self.command(Some(session_id), "Page.enable", json!({})));
        if managed {
            tracked(
                self,
                if initial {
                    GuardRequest::Install
                } else {
                    GuardRequest::Monitor
                },
            );
        }
        commands.push(self.command(Some(session_id), "Page.getFrameTree", json!({})));
        self.frame_tree_requests
            .insert(self.next_id, session_id.to_string());
        if managed {
            tracked(
                self,
                if initial {
                    GuardRequest::Install
                } else {
                    GuardRequest::Monitor
                },
            );
            commands.push(self.command(
                Some(session_id),
                "Page.setLifecycleEventsEnabled",
                json!({"enabled": true}),
            ));
            tracked(
                self,
                if initial {
                    GuardRequest::Install
                } else {
                    GuardRequest::Monitor
                },
            );
            // Chromium 在 flatten autoAttach 下会把新建 target 挂起，直到收到
            // runIfWaitingForDebugger（与 waitFor 取值无关，实测 157）。扩展模式下
            // resume 是解除挂起的必需命令，绝不能等任何回执才发；它的回执只参与
            // 初始就绪闩/后续页预算，不构成防护门禁——登录锁定由随包扩展保证。
            commands.push(self.resume_page(session_id));
            tracked(
                self,
                if initial {
                    GuardRequest::Install
                } else {
                    GuardRequest::Monitor
                },
            );
        } else {
            commands.push(self.resume_page(session_id));
        }
        commands
    }

    fn resume_page(&mut self, session_id: &str) -> String {
        // 普通 target 被 waitForDebuggerOnStart 暂停需要放行；托管的 target 在
        // flatten autoAttach 下同样被挂起，必须收到它才会开始运行。
        self.command(
            Some(session_id),
            "Runtime.runIfWaitingForDebugger",
            json!({}),
        )
    }

    fn acknowledge_guard(&mut self, id: i64, message: &Value, out: &mut Handled) {
        let Some(request) = self.guard_requests.get(&id).cloned() else {
            return;
        };
        let session = match &request {
            GuardRequest::Install(session) | GuardRequest::Monitor(session) => {
                Some(session.as_str())
            }
            GuardRequest::AutoAttach => None,
        };
        if message.get("sessionId").and_then(Value::as_str) != session {
            return;
        }
        let accepted = message.get("error").is_none()
            && message.get("result").is_some_and(Value::is_object)
            && (!self.frame_tree_requests.contains_key(&id)
                || message
                    .pointer("/result/frameTree/frame/id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty()));
        if !accepted {
            let reason = match request {
                GuardRequest::Install(_) => "guard_install_failed",
                GuardRequest::Monitor(_) => "monitor_install_failed",
                GuardRequest::AutoAttach => {
                    out.guard_failed = true;
                    return;
                }
            };
            if let Some(session) = session {
                self.fail_page(session, reason, out);
            }
            return;
        }
        self.guard_requests.remove(&id);
        match request {
            GuardRequest::Install(session) => {
                // 扩展模式下没有暂停，也就没有 resume：全部安装回执完成即就绪。
                let pending = self.guard_requests.values().any(
                    |request| matches!(request, GuardRequest::Install(other) if other == &session),
                );
                if !pending {
                    if let Some(page) = self.sessions.get_mut(&session) {
                        page.deadline = None;
                        if let Some(state) = self.managed.as_ref() {
                            state.guard_installed.mark_for(&page.target_id);
                        }
                        out.guard_installed = true;
                    }
                }
            }
            GuardRequest::Monitor(session) => {
                self.finish_popup_setup(&session);
            }
            GuardRequest::AutoAttach => {}
        }
    }

    fn forget_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
        self.frame_tree_requests
            .retain(|_, session| session != session_id);
        self.guard_requests.retain(|_, request| {
            !matches!(request, GuardRequest::Install(session) | GuardRequest::Monitor(session)
                if session == session_id)
        });
        if let Some(state) = self.managed.as_mut() {
            state.monitor.observe(
                &json!({"method":"Target.detachedFromTarget","params":{"sessionId":session_id}}),
            );
        }
    }

    fn fail_page(&mut self, session_id: &str, reason: &'static str, out: &mut Handled) {
        let Some(page) = self.sessions.get(session_id) else {
            return;
        };
        if page.initial {
            out.guard_failed = true;
            return;
        }
        let target = page.target_id.clone();
        if target.is_empty() {
            out.guard_failed = true;
            return;
        }
        let sessions: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, page)| page.target_id == target)
            .map(|(session, _)| session.clone())
            .collect();
        for session in sessions {
            self.forget_session(&session);
        }
        self.closing_targets.insert(
            target.clone(),
            ClosingTarget {
                reason,
                deadline: tokio::time::Instant::now() + crate::managed_cdp::GUARD_INSTALL_TIMEOUT,
                retry_at: None,
                initial: false,
                notify: true,
            },
        );
        out.commands
            .push(self.command(None, "Target.closeTarget", json!({"targetId": target})));
        self.close_requests
            .insert(self.next_id, CloseRequest::Close(target));
    }

    fn on_detached(&mut self, session_id: &str, out: &mut Handled) {
        let target = self
            .sessions
            .get(session_id)
            .map(|page| (page.target_id.clone(), page.initial));
        self.forget_session(session_id);
        if self.managed.is_none() {
            return;
        }
        let Some((target, initial)) = target else {
            return;
        };
        if target.is_empty() {
            out.guard_failed = true;
            return;
        }
        self.closing_targets.insert(
            target.clone(),
            ClosingTarget {
                reason: "monitor_install_failed",
                deadline: tokio::time::Instant::now() + crate::managed_cdp::GUARD_INSTALL_TIMEOUT,
                retry_at: None,
                initial,
                notify: false,
            },
        );
        out.commands
            .push(self.command(None, "Target.getTargets", json!({})));
        self.close_requests
            .insert(self.next_id, CloseRequest::Detached(target));
    }

    fn acknowledge_close(&mut self, id: i64, message: &Value, out: &mut Handled) {
        let Some(request) = self.close_requests.get(&id).cloned() else {
            return;
        };
        if message.get("sessionId").is_some() {
            return;
        }
        let detached = matches!(&request, CloseRequest::Detached(_));
        self.close_requests.remove(&id);
        match request {
            CloseRequest::Close(target) => {
                // A rejected close may mean the user already closed the tab.
                // Verify absence rather than treating a session detach as destruction.
                out.commands
                    .push(self.command(None, "Target.getTargets", json!({})));
                self.close_requests
                    .insert(self.next_id, CloseRequest::Verify(target));
            }
            CloseRequest::Verify(target) | CloseRequest::Detached(target) => {
                let Some(targets) = message
                    .pointer("/result/targetInfos")
                    .and_then(Value::as_array)
                    .filter(|targets| {
                        message.get("error").is_none()
                            && targets.iter().all(|info| {
                                info.get("targetId")
                                    .and_then(Value::as_str)
                                    .is_some_and(|id| !id.is_empty())
                            })
                    })
                else {
                    out.guard_failed = true;
                    return;
                };
                if targets
                    .iter()
                    .any(|info| info.get("targetId").and_then(Value::as_str) == Some(&target))
                {
                    if detached {
                        let Some(closing) = self.closing_targets.get_mut(&target) else {
                            return;
                        };
                        if closing.initial {
                            out.guard_failed = true;
                            return;
                        }
                        closing.notify = true;
                        out.commands.push(self.command(
                            None,
                            "Target.closeTarget",
                            json!({"targetId":target}),
                        ));
                        self.close_requests
                            .insert(self.next_id, CloseRequest::Close(target));
                    } else if let Some(closing) = self.closing_targets.get_mut(&target) {
                        closing.retry_at =
                            Some(tokio::time::Instant::now() + Duration::from_millis(100));
                    }
                    return;
                }
                if let Some(closed) = self
                    .closing_targets
                    .remove(&target)
                    .filter(|closed| closed.notify)
                {
                    if let Some(state) = self.managed.as_ref() {
                        let _ = state.signals.send(ManagedSignal::PageClosed {
                            reason: closed.reason,
                        });
                    }
                }
            }
        }
    }

    fn setup_deadline(&self) -> Option<tokio::time::Instant> {
        self.sessions
            .values()
            .filter_map(|page| page.deadline)
            .chain(self.closing_targets.values().flat_map(|closing| {
                [Some(closing.deadline), closing.retry_at]
                    .into_iter()
                    .flatten()
            }))
            .min()
    }

    fn expire_setup(&mut self) -> Handled {
        let now = tokio::time::Instant::now();
        let mut out = Handled::default();
        if self
            .closing_targets
            .values()
            .any(|closing| closing.deadline <= now)
        {
            out.guard_failed = true;
            return out;
        }
        let expired: Vec<(String, &'static str)> = self
            .sessions
            .iter()
            .filter(|(_, page)| page.deadline.is_some_and(|deadline| deadline <= now))
            .map(|(session, page)| {
                let reason = if page.initial {
                    "guard_install_timeout"
                } else {
                    "monitor_install_timeout"
                };
                (session.clone(), reason)
            })
            .collect();
        for (session, reason) in expired {
            self.fail_page(&session, reason, &mut out);
        }
        let retry: Vec<String> = self
            .closing_targets
            .iter()
            .filter(|(_, closing)| closing.retry_at.is_some_and(|deadline| deadline <= now))
            .map(|(target, _)| target.clone())
            .collect();
        for target in retry {
            self.closing_targets.get_mut(&target).unwrap().retry_at = None;
            out.commands
                .push(self.command(None, "Target.getTargets", json!({})));
            self.close_requests
                .insert(self.next_id, CloseRequest::Verify(target));
        }
        out
    }

    fn finish_popup_setup(&mut self, session_id: &str) {
        let pending = self.guard_requests.values().any(
            |request| matches!(request, GuardRequest::Monitor(session) if session == session_id),
        );
        if !pending {
            if let Some(page) = self.sessions.get_mut(session_id) {
                page.deadline = None;
                self.frame_tree_requests
                    .retain(|_, session| session != session_id);
            }
        }
    }

    /// 放行一个我们不采集的 target，然后断开它。
    ///
    /// 普通（非托管）采集的 browser 级 autoAttach 会把 Service Worker、Shared
    /// Worker 和各种 `other` target 全部停在第一行脚本之前
    /// （`waitForDebuggerOnStart`）。Chromium 不会因为我们不理它就自动放行，光
    /// detach 也不行——被暂停的 target 不会随 session 断开而恢复。所以普通模式下
    /// 每一个附上来的 target 都得先放行再断开。
    ///
    /// 漏掉这一步的代价不是「少采一点数据」：
    ///
    /// * 被暂停的 Service Worker 接管不了导航请求，二次进入这个站点时页面会停在
    ///   空白帧上直到 SW 启动超时（表现为内容区灰屏、刷新才恢复）；
    /// * 关闭浏览器时 Chromium 会等这些暂停的进程恢复，于是关不掉，只能被
    ///   [`crate::browser`] 强杀，profile 也就删不干净。
    ///
    /// 托管模式同样需要 resume：flatten autoAttach 会把新建 target 挂起（与
    /// waitFor 取值无关，实测 Chrome/157），install 批次里的 resume 就是解除挂起
    /// 的必需命令；对 worker 这类不暂停 target 它是无害的空操作。
    fn resume_and_detach(&mut self, session_id: &str) -> Vec<String> {
        vec![
            self.command(
                Some(session_id),
                "Runtime.runIfWaitingForDebugger",
                json!({}),
            ),
            self.command(
                None,
                "Target.detachFromTarget",
                json!({ "sessionId": session_id }),
            ),
        ]
    }

    /// 处理一条来自浏览器的消息。无法解析或不关心的消息一律安静丢掉。
    fn handle(&mut self, text: &str) -> Handled {
        let mut out = Handled::default();
        let Ok(message) = serde_json::from_str::<Value>(text) else {
            return out;
        };
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            if let Some(id) = message.get("id").and_then(Value::as_i64) {
                self.acknowledge_close(id, &message, &mut out);
                if out.guard_failed {
                    return out;
                }
                self.acknowledge_guard(id, &message, &mut out);
                if out.guard_failed {
                    return out;
                }
                if id == self.get_targets_id {
                    out.commands = self.attach_existing_pages(&message);
                } else if let Some(session) = self.frame_tree_requests.get(&id).cloned() {
                    // A reply must belong to its requested, still-installed session.
                    if message.get("sessionId").and_then(Value::as_str) == Some(session.as_str()) {
                        self.frame_tree_requests.remove(&id);
                        if message.get("error").is_none() {
                            if let Some(frame) = message.pointer("/result/frameTree/frame") {
                                self.seed_frame_tree(&session, frame, &mut out);
                            }
                        }
                    }
                }
            }
            return out;
        };
        let params = message.get("params").unwrap_or(&Value::Null);
        // 顶层 sessionId 是这条事件所属的 session；attachedToTarget 里新 session 的
        // id 在 params 里，不要混。
        let session_id = message.get("sessionId").and_then(Value::as_str);

        match method {
            "Target.attachedToTarget" => self.on_attached(params, &mut out),
            "Target.detachedFromTarget" => {
                if let Some(gone) = params.get("sessionId").and_then(Value::as_str) {
                    self.on_detached(gone, &mut out);
                }
            }
            // 整文档跳转。只认主框架：iframe 的导航不是「用户访问了一个页面」。
            //
            // 也只认自己装过的 session。Chromium 把 Page 事件发给该 target 上**每一条**
            // 附着的 session，所以不认 session 就等于「同一个页面附了几条就记几次」。
            "Page.frameNavigated" if self.is_installed_session(session_id) => {
                let frame = params.get("frame").unwrap_or(&Value::Null);
                if frame.get("parentId").is_none() {
                    if self.managed.is_some()
                        && (frame
                            .get("unreachableUrl")
                            .and_then(Value::as_str)
                            .is_some_and(|url| !url.is_empty())
                            || frame
                                .get("url")
                                .and_then(Value::as_str)
                                .is_some_and(|url| url.starts_with("chrome-error://")))
                    {
                        self.fail_page(session_id.unwrap(), "monitor_install_failed", &mut out);
                        return out;
                    }
                    self.main_frame_navigation(session_id.unwrap(), frame, &mut out);
                }
            }
            "Page.navigatedWithinDocument" if self.is_installed_session(session_id) => {
                let pending_tree = self
                    .frame_tree_requests
                    .values()
                    .any(|id| Some(id.as_str()) == session_id);
                let session = self.sessions.get_mut(session_id.unwrap()).unwrap();
                if session.main_frame_id.is_none() && pending_tree {
                    if let Some(frame_id) = params
                        .get("frameId")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty() && id.len() <= 256)
                    {
                        if session.pending_spa.len() == 64 {
                            session.pending_spa.pop_front();
                            if !session.pending_spa_overflow {
                                eprintln!("CDP initial SPA buffer exceeded 64 events; oldest pending visits dropped");
                                session.pending_spa_overflow = true;
                            }
                        }
                        let raw = params.get("url").and_then(Value::as_str);
                        let guard_eligible =
                            raw.and_then(|url| Url::parse(url).ok()).is_some_and(|url| {
                                url.username().is_empty() && url.password().is_none()
                            });
                        let report = raw
                            .and_then(normalize_page_url)
                            .map(|(url, params)| PageReport::visit_parts(url, params));
                        session.pending_spa.push_back((
                            frame_id.to_string(),
                            report,
                            guard_eligible,
                        ));
                    }
                }
                if session
                    .main_frame_id
                    .as_deref()
                    .is_some_and(|id| params.get("frameId").and_then(Value::as_str) == Some(id))
                {
                    session.navigation_seen = true;
                    session.seeded_document = None;
                    if let Some(url) = params.get("url").and_then(Value::as_str) {
                        out.reports.extend(
                            normalize_page_url(url)
                                .map(|(url, params)| PageReport::visit_parts(url, params)),
                        );
                    }
                }
            }
            _ => {}
        }
        let monitor_event = match method {
            "Target.attachedToTarget" => {
                self.is_installed_session(params.get("sessionId").and_then(Value::as_str))
            }
            "Target.detachedFromTarget" => true,
            "Page.frameNavigated"
            | "Page.navigatedWithinDocument"
            | "Page.lifecycleEvent"
            | "Page.frameStartedLoading" => self.is_installed_session(session_id),
            _ => false,
        };
        if monitor_event {
            if let Some(state) = self.managed.as_mut() {
                if state.monitor.observe(&message) {
                    let _ = state.signals.send(ManagedSignal::Expired);
                }
            }
        }
        out
    }

    fn seed_frame_tree(&mut self, session_id: &str, frame: &Value, out: &mut Handled) {
        let Some(session) = self.sessions.get_mut(session_id) else {
            return;
        };
        // A navigation that arrived while getFrameTree was in flight wins, even if
        // the old reply contains another main-frame id or a login route.
        if session.navigation_seen || frame.get("parentId").is_some() {
            return;
        }
        let Some(id) = frame
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return;
        };
        session.main_frame_id = Some(id.to_string());
        let pending: Vec<(Option<PageReport>, bool)> = session
            .pending_spa
            .drain(..)
            .filter_map(|(frame_id, report, eligible)| {
                (frame_id == id).then_some((report, eligible))
            })
            .collect();
        if let Some((last, eligible)) = pending.last() {
            session.navigation_seen = true;
            // Preserve every buffered main-frame visit; the guard uses only its
            // current route so a superseded login cannot start a stale deadline.
            if let Some(state) = self.managed.as_mut() {
                if state.monitor.observe(&json!({"method":"Page.frameNavigated", "sessionId":session_id,
                    "params":{"frame":{"id":id,"url":last.as_ref().filter(|_| *eligible).map(|r| r.url.as_str()).unwrap_or("about:blank")}}})) {
                    let _ = state.signals.send(ManagedSignal::Expired);
                }
            }
            out.reports
                .extend(pending.into_iter().filter_map(|(report, _)| report));
            return;
        }
        if let Some((url, params)) = frame
            .get("url")
            .and_then(Value::as_str)
            .and_then(normalize_page_url)
        {
            session.seeded_document = Some((
                frame
                    .get("loaderId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                url.clone(),
                params.clone(),
            ));
            out.reports.push(PageReport::visit_parts(url, params));
        }
        if let Some(state) = self.managed.as_mut() {
            if state.monitor.observe(
                &json!({"method":"Page.frameNavigated", "sessionId":session_id,
                "params":{"frame":frame}}),
            ) {
                let _ = state.signals.send(ManagedSignal::Expired);
            }
        }
    }

    fn main_frame_navigation(&mut self, session_id: &str, frame: &Value, out: &mut Handled) {
        let Some(id) = frame
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return;
        };
        let session = self.sessions.get_mut(session_id).unwrap();
        session.main_frame_id = Some(id.to_string());
        session.navigation_seen = true;
        // The full navigation identifies the main frame even before its initial
        // tree reply. Keep its earlier SPA visits and discard only iframe routes.
        out.reports.extend(
            session
                .pending_spa
                .drain(..)
                .filter_map(|(frame_id, report, _)| (frame_id == id).then_some(report).flatten()),
        );
        let normalized = frame
            .get("url")
            .and_then(Value::as_str)
            .and_then(normalize_page_url);
        let seeded = session.seeded_document.take();
        if let Some((url, params)) = normalized {
            let loader = frame.get("loaderId").and_then(Value::as_str).unwrap_or("");
            if seeded
                .as_ref()
                .is_some_and(|(seed_loader, seed_url, seed_params)| {
                    seed_loader == loader && seed_url == &url && seed_params == &params
                })
            {
                return;
            }
            out.reports.push(PageReport::visit_parts(url, params));
        }
    }

    fn on_attached(&mut self, params: &Value, out: &mut Handled) {
        let target = params.get("targetInfo").unwrap_or(&Value::Null);
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let session_id = session_id.to_string();
        if target.get("type").and_then(Value::as_str) != Some("page") {
            // 不采集它，但一定要放行——否则整个浏览器会被一个暂停的 target 拖住。
            out.commands.extend(self.resume_and_detach(&session_id));
            return;
        }
        // 同一条 session 被重复播报：什么都不做。这个 session 已经装好了，放行过了，
        // 断开它反而会把正在采集的页面弄丢。
        if self.sessions.contains_key(&session_id) {
            return;
        }
        let target_id = target.get("targetId").and_then(Value::as_str).unwrap_or("");
        if self.closing_targets.contains_key(target_id) {
            out.commands.push(self.command(
                None,
                "Target.detachFromTarget",
                json!({"sessionId":session_id}),
            ));
            return;
        }
        // 同 target 的第二条 session 会把每个事件算两遍。托管模式下不暂停，
        // 第二条 session 直接断开即可；普通模式保持先放行再断开。
        if self.is_installed_target(target_id) {
            if self.managed.is_some() {
                out.commands.push(self.command(
                    None,
                    "Target.detachFromTarget",
                    json!({"sessionId":session_id}),
                ));
            } else {
                out.commands.extend(self.resume_and_detach(&session_id));
            }
            return;
        }
        self.sessions.insert(
            session_id.clone(),
            PageSession {
                target_id: target_id.to_string(),
                initial: self
                    .managed
                    .as_ref()
                    .is_some_and(|state| state.guard_installed.is_initial_target(target_id)),
                deadline: self.managed.as_ref().map(|_| {
                    tokio::time::Instant::now() + crate::managed_cdp::GUARD_INSTALL_TIMEOUT
                }),
                ..PageSession::default()
            },
        );
        // targetInfo.url is not a navigation; the initial frame tree seeds it once.
        out.commands.extend(self.install(&session_id));
    }

    /// 这条事件是否来自我们自己装过采集的 page session。
    fn is_installed_session(&self, session_id: Option<&str>) -> bool {
        session_id.is_some_and(|id| self.sessions.contains_key(id))
    }

    /// 这个 target 上是否已经有一条装好的 session。
    ///
    /// 空 targetId 一律当作「没装过」：宁可漏掉一次去重，也不能让两个都缺 targetId
    /// 的页面因为空字符串相等而被认成同一个。
    fn is_installed_target(&self, target_id: &str) -> bool {
        !target_id.is_empty()
            && self
                .sessions
                .values()
                .any(|known| known.target_id == target_id)
    }

    /// 连接建立之前就存在的 page target，逐个显式附上。
    fn attach_existing_pages(&mut self, message: &Value) -> Vec<String> {
        let targets = message
            .get("result")
            .and_then(|result| result.get("targetInfos"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        targets
            .iter()
            .filter(|target| target.get("type").and_then(Value::as_str) == Some("page"))
            .filter_map(|target| target.get("targetId").and_then(Value::as_str))
            .map(|target_id| target_id.to_string())
            .collect::<Vec<_>>()
            .into_iter()
            .map(|target_id| {
                self.command(
                    None,
                    "Target.attachToTarget",
                    json!({ "targetId": target_id, "flatten": true }),
                )
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "cdp/stream_tests.rs"]
mod stream_tests;

#[cfg(test)]
#[path = "cdp/control_tests.rs"]
mod control_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_target_parsing_keeps_only_page_entries() {
        let result = json!({
            "targetInfos": [
                {"targetId": "T1", "type": "page", "url": "https://shop.example.test/a"},
                {"targetId": "T2", "type": "iframe", "url": "https://shop.example.test/frame"},
                {"targetId": "T3", "type": "page", "url": "chrome://newtab/"},
                {"targetId": "T4", "type": "service_worker", "url": "https://shop.example.test/sw.js"}
            ]
        });
        let targets = page_targets_from_result(&result);
        assert_eq!(
            targets,
            vec![
                ("T1".to_string(), "https://shop.example.test/a".to_string()),
                ("T3".to_string(), "chrome://newtab/".to_string())
            ]
        );
    }

    #[test]
    fn page_urls_match_by_host_regardless_of_query() {
        let platform = url::Url::parse("https://localads.example.cn/lamp/pc/home").unwrap();
        assert!(page_url_matches(
            "https://localads.example.cn/lamp/pc/cdp/promote?advid=1",
            &platform
        ));
        // 同一平台导航后的任何路径都算
        assert!(page_url_matches("https://localads.example.cn/", &platform));
        // 别的域名、chrome 内部页、无效地址都不算
        assert!(!page_url_matches("https://other.example.cn/", &platform));
        assert!(!page_url_matches("chrome://newtab/", &platform));
        assert!(!page_url_matches("not a url", &platform));
    }

    #[test]
    fn matching_page_target_returns_none_instead_of_creating_a_target() {
        let platform = url::Url::parse("https://agent.example.test/").unwrap();
        let targets = vec![(
            "T1".to_string(),
            "https://other.example.test/workbench".to_string(),
        )];
        assert_eq!(matching_page_target(&targets, &platform), None);
    }

    fn method_of(command: &str) -> String {
        serde_json::from_str::<Value>(command).unwrap()["method"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn attached(session_id: &str, target_type: &str, url: &str) -> String {
        json!({
            "method": "Target.attachedToTarget",
            "params": {
                "sessionId": session_id,
                "targetInfo": {
                    "targetId": "T1",
                    "type": target_type,
                    "url": url,
                    "attached": true,
                },
                "waitingForDebugger": true,
            }
        })
        .to_string()
    }

    /// 已经装好一条 page session（`S1` / `T1`）的采集器。
    ///
    /// 导航事件只认自己装过的 session，所以凡是直接喂导航事件的用例都得先走一遍附着。
    fn collector_with_page() -> Collector {
        let mut collector = Collector::default();
        collector.opening_commands();
        // about:blank 不算一次访问，用例可以直接断言自己那一条
        assert!(collector
            .handle(&attached("S1", "page", "about:blank"))
            .reports
            .is_empty());
        collector
    }

    /// 必须是 browser 级的 autoAttach，且必须 `flatten` + 停在调试器上：前者让
    /// 后开的标签页也走同一条连接，后者保证注入脚本装在页面脚本之前。
    #[test]
    fn opening_commands_auto_attach_flattened_and_paused() {
        let mut collector = Collector::default();
        let commands = collector.opening_commands();

        let first: Value = serde_json::from_str(&commands[0]).unwrap();
        assert_eq!(first["method"], "Target.setAutoAttach");
        assert_eq!(first["params"]["autoAttach"], true);
        assert_eq!(first["params"]["flatten"], true);
        assert_eq!(first["params"]["waitForDebuggerOnStart"], true);
        // browser 级命令不能带 sessionId
        assert!(first.get("sessionId").is_none());
        assert_eq!(method_of(&commands[1]), "Target.getTargets");
    }

    #[test]
    fn managed_collector_installs_subscriptions_and_resumes_within_the_install_batch() {
        let (signals, mut signal_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut collector = Collector {
            managed: Some(ManagedCollectorState {
                login_guard_script: "(() => {})();".into(),
                signals,
                monitor: crate::managed_cdp::ManagedSessionMonitor::for_session(
                    "https://agent.oceanengine.com/",
                )
                .unwrap(),
                guard_installed: crate::managed_cdp::GuardInstalled::for_target("T1".into()),
            }),
            ..Collector::default()
        };
        let opening = collector.opening_commands();
        let auto: Value = serde_json::from_str(&opening[0]).unwrap();
        assert_eq!(
            auto["params"]["waitForDebuggerOnStart"], false,
            "托管仍不设置 waitFor 标记；但 flatten autoAttach 会挂起新 target，\
             所以 resume 无条件随安装批次发出，绝不等回执"
        );

        let handled = collector.handle(&attached(
            "S1",
            "page",
            "https://agent.oceanengine.com/workbench",
        ));
        let methods: Vec<String> = handled
            .commands
            .iter()
            .map(|command| method_of(command))
            .collect();
        assert_eq!(
            methods,
            vec![
                "Page.addScriptToEvaluateOnNewDocument",
                "Page.enable",
                "Page.getFrameTree",
                "Page.setLifecycleEventsEnabled",
                "Runtime.runIfWaitingForDebugger",
            ],
            "初始托管页安装第二层 guard、采集订阅，并在同一批内无条件放行",
        );
        let scripts: Vec<String> = handled
            .commands
            .iter()
            .filter(|c| method_of(c) == "Page.addScriptToEvaluateOnNewDocument")
            .map(|c| {
                serde_json::from_str::<Value>(c).unwrap()["params"]["source"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(scripts, vec!["(() => {})();"], "only fixed login guard");
        assert_eq!(
            handled
                .commands
                .iter()
                .filter(|command| method_of(command) == "Runtime.runIfWaitingForDebugger")
                .count(),
            1,
            "exactly one resume, sent unconditionally inside the install batch"
        );
        for command in &handled.commands {
            let command: Value = serde_json::from_str(command).unwrap();
            let result = if command["method"] == "Page.getFrameTree" {
                json!({"frameTree":{"frame":{"id":"main","loaderId":"L0","url":"about:blank"}}})
            } else {
                json!({})
            };
            let ack = collector
                .handle(&json!({"id":command["id"],"sessionId":"S1","result":result}).to_string());
            assert!(
                ack.commands.is_empty(),
                "install ACKs (including the resume ACK) emit no further commands"
            );
            assert!(ack.reports.is_empty());
        }
        assert!(
            collector
                .managed
                .as_ref()
                .unwrap()
                .guard_installed
                .is_ready(),
            "all five install ACKs, including the resume ACK, complete the latch"
        );
        assert!(signal_rx.try_recv().is_err());

        // 后续弹窗装采集订阅并在同一批内放行：无固定防护脚本（独立 targetId，
        // 不是已有页面的重复会话）。
        let popup = collector.handle(&json!({"method": "Target.attachedToTarget", "params": {
            "sessionId": "S2",
            "targetInfo": {"targetId": "T2", "type": "page", "url": "about:blank", "attached": true},
        }}).to_string());
        let methods: Vec<String> = popup.commands.iter().map(|c| method_of(c)).collect();
        assert_eq!(
            methods,
            vec![
                "Page.enable",
                "Page.getFrameTree",
                "Page.setLifecycleEventsEnabled",
                "Runtime.runIfWaitingForDebugger",
            ],
            "additional pages install monitors plus the unconditional batch resume",
        );
        assert!(popup
            .commands
            .iter()
            .all(|command| method_of(command) != "Page.addScriptToEvaluateOnNewDocument"));
        for command in &popup.commands {
            let command: Value = serde_json::from_str(command).unwrap();
            let result = if command["method"] == "Page.getFrameTree" {
                json!({"frameTree":{"frame":{"id":"main","loaderId":"L0","url":"about:blank"}}})
            } else {
                json!({})
            };
            let ack = collector
                .handle(&json!({"id":command["id"],"sessionId":"S2","result":result}).to_string());
            assert!(ack.commands.is_empty());
        }
        assert!(signal_rx.try_recv().is_err());

        // 同 target 的第二条 session：浏览器级直接断开，绝不放行，避免双份计数。
        let duplicate = collector.handle(&attached("S9", "page", "https://x.test/other"));
        let methods: Vec<String> = duplicate.commands.iter().map(|c| method_of(c)).collect();
        assert_eq!(methods, vec!["Target.detachFromTarget"]);
        let detach: Value = serde_json::from_str(&duplicate.commands[0]).unwrap();
        assert!(detach.get("sessionId").is_none());
        assert_eq!(detach["params"]["sessionId"], "S9");
        assert!(duplicate.reports.is_empty());
        assert_eq!(collector.sessions.len(), 2);

        // 非 page target：先放行再断开。
        let worker = collector.handle(&attached("S3", "service_worker", "https://x.test/sw.js"));
        let methods: Vec<String> = worker.commands.iter().map(|c| method_of(c)).collect();
        assert_eq!(
            methods,
            vec!["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"]
        );
    }

    #[test]
    fn managed_collector_reports_logout_immediately() {
        let (signals, mut signal_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut collector = Collector {
            managed: Some(ManagedCollectorState {
                login_guard_script: "(() => {})();".into(),
                signals,
                monitor: crate::managed_cdp::ManagedSessionMonitor::for_session(
                    "https://agent.oceanengine.com/",
                )
                .unwrap(),
                guard_installed: crate::managed_cdp::GuardInstalled::default(),
            }),
            ..Collector::default()
        };
        collector.opening_commands();
        collector.handle(&attached(
            "S1",
            "page",
            "https://agent.oceanengine.com/workbench",
        ));

        // 明确登出：立即产生 Expired 信号，且监控器每个会话只报一次。
        collector.handle(&json!({"method": "Page.frameNavigated", "sessionId": "S1",
                "params": {"frame": {"id": "main", "url": "https://sso.oceanengine.com/account/page/service/sso_logout"}}}).to_string());
        assert!(matches!(
            signal_rx.try_recv().unwrap(),
            ManagedSignal::Expired
        ));
        assert!(signal_rx.try_recv().is_err());
    }

    #[test]
    fn managed_collector_reports_login_settle_expiry() {
        let (signals, mut signal_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut collector = Collector {
            managed: Some(ManagedCollectorState {
                login_guard_script: "(() => {})();".into(),
                signals,
                monitor: crate::managed_cdp::ManagedSessionMonitor::for_session(
                    "https://agent.oceanengine.com/",
                )
                .unwrap(),
                guard_installed: crate::managed_cdp::GuardInstalled::default(),
            }),
            ..Collector::default()
        };
        collector.opening_commands();
        collector.handle(&attached(
            "S1",
            "page",
            "https://agent.oceanengine.com/workbench",
        ));

        // 登录页停留：加载完成才开始观察窗，窗口内不报；到期后产生 Expired 信号。
        collector.handle(
            &json!({"method": "Page.frameNavigated", "sessionId": "S1",
                "params": {"frame": {"id": "main", "loaderId":"L1", "url": "https://agent.oceanengine.com/login"}}})
            .to_string(),
        );
        assert!(signal_rx.try_recv().is_err(), "仅导航提交不开始计时");
        std::thread::sleep(crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(50));
        assert!(
            !collector.managed.as_mut().unwrap().monitor.expire_due(),
            "没有加载完成事件时即使过了时长也不判失效"
        );
        // load 之后才开始 4 秒窗口：load 后立即不报。
        collector.handle(
            &json!({"method": "Page.lifecycleEvent", "sessionId": "S1",
                "params": {"frameId": "main", "loaderId":"L1", "name":"load"}})
            .to_string(),
        );
        assert!(
            !collector.managed.as_mut().unwrap().monitor.expire_due(),
            "load 后仍在观察窗内"
        );
        std::thread::sleep(crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(50));
        let state = collector.managed.as_mut().unwrap();
        assert!(state.monitor.expire_due(), "加载完成且稳定停留超窗才判失效");
        let _ = state.signals.send(ManagedSignal::Expired);
        assert!(matches!(
            signal_rx.try_recv().unwrap(),
            ManagedSignal::Expired
        ));
        assert!(!state.monitor.expire_due(), "每个会话只通知一次");
    }

    /// Page subscription and the initial frame-tree request precede resume.
    #[test]
    fn attaching_a_page_installs_the_collector_before_resuming() {
        let mut collector = Collector::default();
        collector.opening_commands();

        let handled = collector.handle(&attached("S1", "page", "about:blank"));
        let methods: Vec<String> = handled.commands.iter().map(|c| method_of(c)).collect();
        assert_eq!(
            methods,
            vec![
                "Page.enable",
                "Page.getFrameTree",
                "Runtime.runIfWaitingForDebugger",
            ]
        );
        for command in &handled.commands {
            let value: Value = serde_json::from_str(command).unwrap();
            assert_eq!(value["sessionId"], "S1");
        }
        // about:blank 不是一次访问
        assert!(handled.reports.is_empty());
    }

    /// Attachment metadata never counts as a visit; only the initial tree seeds it.
    #[test]
    fn attaching_an_existing_page_waits_for_its_frame_tree() {
        let mut collector = Collector::default();
        collector.opening_commands();
        let handled = collector.handle(&attached("S1", "page", "https://shop.example.test/orders"));
        assert!(handled.reports.is_empty());
        let tree: Value = handled
            .commands
            .iter()
            .map(|c| serde_json::from_str::<Value>(c).unwrap())
            .find(|c| c["method"] == "Page.getFrameTree")
            .unwrap();
        let result = collector.handle(
            &json!({"id":tree["id"],"sessionId":"S1","result":{"frameTree":{
                "frame":{"id":"main","url":"https://shop.example.test/orders"}
            }}})
            .to_string(),
        );
        assert_eq!(
            result.reports,
            vec![PageReport::visit_parts(
                "https://shop.example.test/orders".into(),
                None
            )]
        );
    }

    /// 同一个 session 重复附上（getTargets 的显式 attach 和 autoAttach 撞车）
    /// 不能装两遍，否则每个事件都会被数两次。
    #[test]
    fn attaching_the_same_session_twice_installs_once() {
        let mut collector = Collector::default();
        collector.opening_commands();

        assert!(!collector
            .handle(&attached("S1", "page", "about:blank"))
            .commands
            .is_empty());
        assert_eq!(
            collector.handle(&attached("S1", "page", "about:blank")),
            Handled::default()
        );
    }

    /// Service Worker 之类的 target 不装采集，但**必须**放行再断开：
    /// `waitForDebuggerOnStart` 把它们也停在了第一行脚本之前，放着不管会让页面
    /// 停在空白帧上（灰屏、刷新才恢复），关浏览器时还会关不掉。
    #[test]
    fn non_page_targets_are_resumed_and_then_detached() {
        let mut collector = Collector::default();
        collector.opening_commands();

        let handled =
            collector.handle(&attached("S2", "service_worker", "https://a.example/sw.js"));

        // 顺序不能反：先放行，再断开。
        let methods: Vec<String> = handled.commands.iter().map(|c| method_of(c)).collect();
        assert_eq!(
            methods,
            vec!["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"]
        );
        let resume: Value = serde_json::from_str(&handled.commands[0]).unwrap();
        assert_eq!(resume["sessionId"], "S2");
        // detach 是 browser 级命令：目标 session 在 params 里，不能当成 sessionId 发
        let detach: Value = serde_json::from_str(&handled.commands[1]).unwrap();
        assert!(detach.get("sessionId").is_none());
        assert_eq!(detach["params"]["sessionId"], "S2");

        // 不采集它：既不入 session 表，也不产出访问记录
        assert!(handled.reports.is_empty());
        assert!(collector.sessions.is_empty());
    }

    /// 放行之后这个 session 的上报仍然不算数——它从来没被装上采集。
    #[test]
    fn a_resumed_non_page_session_still_cannot_report() {
        let mut collector = Collector::default();
        collector.opening_commands();
        collector.handle(&attached("S2", "other", "https://a.example/x"));

        let call = json!({
            "sessionId": "S2",
            "method": "Runtime.bindingCalled",
            "params": {
                "name": "__vestusReportActivity",
                "payload": json!({ "url": "https://a.example/x", "counts": { "click": 1 } })
                    .to_string(),
            }
        })
        .to_string();
        assert!(collector.handle(&call).reports.is_empty());
    }

    /// 同一个页面会被附两次：`setAutoAttach` 一次，`getTargets` 之后的显式
    /// `attachToTarget` 又一次——两次拿到的是**两个不同的 sessionId**，只看 sessionId
    /// 认不出这是同一个页面。第二条必须放行再断开，否则这个页面的每个事件都被算两遍，
    /// 管理台看到的点击数和访问数直接翻倍。
    #[test]
    fn a_second_session_on_the_same_page_is_dropped_instead_of_double_counted() {
        let mut collector = collector_with_page();

        // 同一个 target（T1），另一条 session
        let handled = collector.handle(&attached("S9", "page", "https://shop.example.test/cart"));

        let methods: Vec<String> = handled.commands.iter().map(|c| method_of(c)).collect();
        assert_eq!(
            methods,
            vec!["Runtime.runIfWaitingForDebugger", "Target.detachFromTarget"]
        );
        // 既不重复记一次访问，也不进 session 表
        assert!(handled.reports.is_empty());
        assert_eq!(collector.sessions.len(), 1);
    }

    /// 页面级事件会发给该 target 上**每一条**附着的 session，所以不认 session 就等于
    /// 「同一个页面附了几条就记几次」。这是翻倍的另一半。
    #[test]
    fn events_from_a_session_we_never_installed_are_ignored() {
        let mut collector = collector_with_page();

        let navigated = |session: &str| {
            json!({
                "sessionId": session,
                "method": "Page.frameNavigated",
                "params": { "frame": { "id": "F1", "url": "https://shop.example.test/cart" } }
            })
            .to_string()
        };

        assert_eq!(collector.handle(&navigated("S1")).reports.len(), 1);
        assert!(collector.handle(&navigated("S9")).reports.is_empty());
    }

    /// 主框架跳转算一次访问，iframe 的跳转不算——一个页面里十个广告位不是十次访问。
    #[test]
    fn only_the_main_frame_navigation_counts_as_a_visit() {
        let mut collector = collector_with_page();

        let main = json!({
            "sessionId": "S1",
            "method": "Page.frameNavigated",
            "params": { "frame": { "id": "F1", "url": "https://shop.example.test/cart" } }
        })
        .to_string();
        assert_eq!(
            collector.handle(&main).reports,
            vec![PageReport::visit_parts(
                "https://shop.example.test/cart".into(),
                None,
            )]
        );

        let iframe = json!({
            "sessionId": "S1",
            "method": "Page.frameNavigated",
            "params": {
                "frame": { "id": "F2", "parentId": "F1", "url": "https://ads.example.test/x" }
            }
        })
        .to_string();
        assert!(collector.handle(&iframe).reports.is_empty());
    }

    /// SPA 的 pushState 不建新文档，注入脚本不会重跑，所以只有这个事件看得见。
    #[test]
    fn in_document_navigation_counts_as_a_visit() {
        let mut collector = collector_with_page();
        collector.handle(
            &json!({"sessionId":"S1", "method":"Page.frameNavigated",
            "params":{"frame":{"id":"F1", "url":"about:blank"}}})
            .to_string(),
        );
        let event = json!({
            "sessionId": "S1",
            "method": "Page.navigatedWithinDocument",
            "params": { "frameId": "F1", "url": "https://shop.example.test/orders/1" }
        })
        .to_string();

        assert_eq!(
            collector.handle(&event).reports,
            vec![PageReport::visit_parts(
                "https://shop.example.test/orders/1".into(),
                None,
            )]
        );
    }

    #[test]
    fn navigation_visits_keep_the_redacted_query_parameters() {
        let mut collector = collector_with_page();
        let event = json!({
            "sessionId": "S1",
            "method": "Page.frameNavigated",
            "params": { "frame": {
                "id": "F1",
                "url": "https://shop.example.test/orders?order=42&sessionId=private"
            }}
        })
        .to_string();

        let reports = collector.handle(&event).reports;
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].url, "https://shop.example.test/orders");
        assert_eq!(
            reports[0].url_params.as_deref(),
            Some("order=42&sessionId=%5BREDACTED%5D")
        );
    }

    /// Legacy bindings are ignored even on our installed session.
    #[test]
    fn legacy_binding_calls_are_never_accepted() {
        let mut collector = collector_with_page();
        for session in ["S1", "S9"] {
            assert!(collector.handle(&json!({"sessionId":session,"method":"Runtime.bindingCalled","params":{
                "name":"__vestusReportActivity","payload":"{\"url\":\"https://shop.example.test/\"}"
            }}).to_string()).reports.is_empty());
        }
    }

    /// 页面关掉后它的 session 要从表里删掉，否则回收不了、还会接受它的上报。
    #[test]
    fn detaching_forgets_the_session() {
        let mut collector = Collector::default();
        collector.opening_commands();
        collector.handle(&attached("S1", "page", "about:blank"));

        let detached = json!({
            "method": "Target.detachedFromTarget",
            "params": { "sessionId": "S1" }
        })
        .to_string();
        collector.handle(&detached);
        assert!(collector.sessions.is_empty());
        // 删干净之后同一个 id 可以重新装一遍
        assert!(!collector
            .handle(&attached("S1", "page", "about:blank"))
            .commands
            .is_empty());
    }

    /// 只有 getTargets 那一条回执会被当成结果读。
    #[test]
    fn existing_pages_are_attached_from_the_get_targets_result() {
        let mut collector = Collector::default();
        collector.opening_commands();
        let response = json!({
            "id": collector.get_targets_id,
            "result": { "targetInfos": [
                { "targetId": "T1", "type": "page", "url": "https://a.example.test/" },
                { "targetId": "T2", "type": "browser", "url": "" },
            ]}
        })
        .to_string();

        let handled = collector.handle(&response);
        assert_eq!(handled.commands.len(), 1);
        let command: Value = serde_json::from_str(&handled.commands[0]).unwrap();
        assert_eq!(command["method"], "Target.attachToTarget");
        assert_eq!(command["params"]["targetId"], "T1");
        assert_eq!(command["params"]["flatten"], true);
    }

    /// 命令报错的回执、以及看不懂的消息，都不能让状态机出声。
    #[test]
    fn unknown_and_failed_messages_are_dropped() {
        let mut collector = Collector::default();
        collector.opening_commands();

        assert_eq!(collector.handle("not json at all"), Handled::default());
        assert_eq!(
            collector.handle(&json!({ "id": 99, "error": { "code": -32000 } }).to_string()),
            Handled::default()
        );
        assert_eq!(
            collector.handle(&json!({ "method": "Network.requestWillBeSent" }).to_string()),
            Handled::default()
        );
    }

    /// query 和 fragment 是采集边界：它们经常带 token、session id 和搜索词，
    /// 必须在进内存之前就没了。
    #[test]
    fn normalize_url_strips_the_query_and_fragment() {
        assert_eq!(
            normalize_url("https://shop.example.test/orders?token=abc123&q=%E9%9E%8B#top"),
            Some("https://shop.example.test/orders".to_string())
        );
        // path 要留全，包括结尾斜杠——那是两个不同的页面
        assert_eq!(
            normalize_url("https://shop.example.test/a/b/"),
            Some("https://shop.example.test/a/b/".to_string())
        );
        // 非默认端口是地址的一部分
        assert_eq!(
            normalize_url("http://127.0.0.1:8080/admin"),
            Some("http://127.0.0.1:8080/admin".to_string())
        );
    }

    /// URL 里的用户名密码同样不能进日志。
    #[test]
    fn normalize_url_drops_embedded_credentials() {
        let normalized = normalize_url("https://alice:hunter2@shop.example.test/orders").unwrap();
        assert_eq!(normalized, "https://shop.example.test/orders");
        assert!(!normalized.contains("hunter2"));
    }

    /// 这些都不是「用户访问了一个页面」。
    #[test]
    fn normalize_url_rejects_non_web_schemes() {
        for raw in [
            "about:blank",
            "chrome://settings",
            "devtools://devtools/bundled/inspector.html",
            "file:///Users/someone/secret.txt",
            "data:text/html,<h1>x</h1>",
            "",
            "/relative/path",
        ] {
            assert!(normalize_url(raw).is_none(), "{raw}");
        }
    }

    /// 剥完 query 还超长的只能是病态路径，宁可不记也不截断成一个不存在的地址。
    #[test]
    fn normalize_url_rejects_an_overlong_address() {
        let long = format!("https://a.example.test/{}", "x".repeat(MAX_URL_BYTES));
        assert!(normalize_url(&long).is_none());
        let long_query = format!("https://a.example.test/p?q={}", "x".repeat(MAX_URL_BYTES));
        // 长度是剥掉 query 之后才算的
        assert_eq!(
            normalize_url(&long_query),
            Some("https://a.example.test/p".to_string())
        );
    }

    #[test]
    fn urls_split_and_redact_query_parameters_before_aggregation() {
        let (url, params) = normalize_page_url(
            "https://shop.example.test/cart?order=42&TOKEN=fixture&empty=&order=43#top",
        )
        .unwrap();
        assert_eq!(url, "https://shop.example.test/cart");
        assert_eq!(
            params.as_deref(),
            Some("order=42&TOKEN=%5BREDACTED%5D&empty=&order=43")
        );
    }

    #[test]
    fn sensitive_keys_ignore_case_and_non_alphanumerics_in_every_spelling() {
        for key in [
            "pass-word",
            "api_token",
            "sess-ion",
            "OTP code",
            "Cvv.Number",
        ] {
            assert!(is_sensitive_key(key), "{key}");
        }
        assert!(!is_sensitive_key("customer-email"));
    }

    #[test]
    fn query_redaction_keeps_only_complete_canonical_pairs_within_the_cap() {
        let huge_pair = "%E7%95%8C".repeat(2_000);
        let (_url, params) = normalize_page_url(&format!(
            "https://shop.example.test/p?emoji=%F0%9F%9A%80&huge={huge_pair}&tail=ok"
        ))
        .unwrap();
        let params = params.unwrap();
        assert!(params.len() <= MAX_URL_PARAMS_BYTES);

        let reparsed = url::form_urlencoded::parse(params.as_bytes()).collect::<Vec<_>>();
        assert_eq!(
            reparsed,
            vec![("emoji".into(), "🚀".into()), ("tail".into(), "ok".into())]
        );
        let mut canonical = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in &reparsed {
            canonical.append_pair(key, value);
        }
        assert_eq!(params, canonical.finish());
    }

    #[test]
    fn query_encoding_matches_the_backend_python_urlencode_contract() {
        let (_url, params) =
            normalize_page_url("https://shop.example.test/p?star=*&tilde=~&space=hello%20world")
                .unwrap();

        assert_eq!(
            params.as_deref(),
            Some("star=%2A&tilde=~&space=hello+world")
        );
    }

    #[test]
    fn query_redaction_limits_the_number_of_complete_pairs() {
        let query = (0..201)
            .map(|index| format!("p{index}=v{index}"))
            .collect::<Vec<_>>()
            .join("&");
        let (_url, params) =
            normalize_page_url(&format!("https://shop.example.test/p?{query}")).unwrap();
        let params = params.unwrap();
        let pairs = url::form_urlencoded::parse(params.as_bytes()).collect::<Vec<_>>();
        assert_eq!(pairs.len(), 200);
        assert_eq!(pairs.first(), Some(&("p0".into(), "v0".into())));
        assert_eq!(pairs.last(), Some(&("p199".into(), "v199".into())));
    }

    /// 控制命令是 browser 级的：带固定 id、不带 sessionId。
    #[test]
    fn control_commands_are_browser_level_requests() {
        let message: Value =
            serde_json::from_str(&control_command_message("Browser.close", json!({}))).unwrap();
        assert_eq!(message["id"], CONTROL_COMMAND_ID);
        assert_eq!(message["method"], "Browser.close");
        assert!(message.get("sessionId").is_none());
    }

    /// 回执之前到的事件、别的 id 的回执都不是它；协议错误要原样带出来。
    #[test]
    fn control_command_outcome_matches_only_its_own_reply() {
        assert!(control_command_outcome(
            &json!({ "method": "Target.targetDestroyed", "params": {} }).to_string()
        )
        .is_none());
        assert!(control_command_outcome(
            &json!({ "id": CONTROL_COMMAND_ID + 1, "result": {} }).to_string()
        )
        .is_none());
        assert!(control_command_outcome("not json").is_none());

        let closed =
            control_command_outcome(&json!({ "id": CONTROL_COMMAND_ID, "result": {} }).to_string())
                .unwrap()
                .unwrap();
        assert!(closed.as_object().unwrap().is_empty());

        let refused = control_command_outcome(
            &json!({ "id": CONTROL_COMMAND_ID, "error": { "code": -32000, "message": "Browser is closing" } })
                .to_string(),
        )
        .unwrap();
        assert!(
            matches!(refused, Err(CdpError::Command(detail)) if detail == "Browser is closing")
        );
    }

    /// 端点已经没了（浏览器不在了）时，控制命令必须很快失败，调用方才能马上改发信号，
    /// 而不是卡在这里。
    #[tokio::test]
    async fn control_commands_fail_fast_when_nobody_listens() {
        // 先占一个端口再放掉：短时间内这个端口上没有监听者。
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let endpoint = DevToolsEndpoint {
            port,
            browser_path: "/devtools/browser/gone".to_string(),
        };
        let started = std::time::Instant::now();
        assert!(matches!(
            request_exit(&endpoint).await,
            Err(CdpError::Connect(_))
        ));
        assert!(started.elapsed() < CONTROL_COMMAND_TIMEOUT);
    }
}
