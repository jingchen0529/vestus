//! 采集用的最小 Chrome DevTools Protocol 客户端。
//!
//! 只做一件事：把一个 Chromium 进程里「访问了哪个页面、在页面上操作了多少次」
//! 变成一串 [`PageReport`]。为此只用到协议的三个角落：
//!
//! - `Target.setAutoAttach`：在 **browser 级**连接上打开，于是用户后开的标签页
//!   和站点弹窗都会自动附上来；page 级连接只看得到建立连接时的那一个页面。
//! - `Runtime.runIfWaitingForDebugger`：放行被 `waitForDebuggerOnStart` 暂停的
//!   target。**每一个**附上来的 target 都必须被放行，包括我们不采集的那些——
//!   见 [`Collector::resume_and_detach`]。
//! - `Page.addScriptToEvaluateOnNewDocument`：把采集脚本装在每个新文档最前面。
//! - `Runtime.addBinding` / `Runtime.bindingCalled`：页面把计数交回来的通道。
//!   用 binding 而不是本地 HTTP 端点，是为了不再多开一个监听端口。
//!
//! 页面地址由 CDP 侧负责（`Page.frameNavigated` 与 `Page.navigatedWithinDocument`
//! 一起覆盖整文档跳转和 SPA 路由），操作次数与停留时长由注入脚本负责。两侧不重
//! 叠，所以一次访问只会被记一次。
//!
//! # 采集边界
//!
//! 只上报「规范化后的 URL + 各类操作次数 + 停留时长」。不采页面标题、不采点了哪
//! 个元素、不采按了哪个键；query 会在进内存前逐项脱敏后单独保存，fragment 与凭据
//! 仍会丢弃。
//!
//! # 与页面脚本的隔离
//!
//! 注入脚本在文档最前面运行，拿到 binding 的函数引用后立刻 `delete` 掉那个全局
//! 属性。于是页面自己的脚本既看不见这个通道，也没法伪造上报。

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedSender;
use tokio::time::timeout;
use tokio_tungstenite::client_async_with_config;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::browser::DevToolsEndpoint;

/// 页面把计数交回宿主的全局函数名。注入脚本会立刻把它从 `window` 上删掉。
const BINDING_NAME: &str = "__vestusReportActivity";

/// CDP 消息上限。只订阅 Target/Runtime/Page 的少量事件，正常都在 1 KiB 量级。
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// 连接 DevTools 端点的超时。端口是从 `DevToolsActivePort` 读出来的，连不上说明
/// 浏览器已经不在了，等下去没有意义。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 剥掉 query 之后仍然超长的 URL 直接不记：截断会产出一个并不存在的地址，
/// 而完整保留会让内存和数据库列被一条病态路径占住。
const MAX_URL_BYTES: usize = 500;

/// 经过脱敏后的 query 最大字节数，给单页聚合键和上报体留出硬上限。
const MAX_URL_PARAMS_BYTES: usize = 4096;
const MAX_URL_PARAM_PAIRS: usize = 200;

/// 页面提交的快照在进入聚合前的第二道边界。
const MAX_SNAPSHOT_FIELDS: usize = 50;
const MAX_SNAPSHOT_KEY_BYTES: usize = 128;
const MAX_SNAPSHOT_VALUES_PER_FIELD: usize = 20;
const MAX_SNAPSHOT_VALUE_BYTES: usize = 512;
const MAX_SNAPSHOT_TOTAL_BYTES: usize = 32 * 1024;

/// 一次表单交互中允许上报的、已过滤的字段快照。
pub type FormSnapshot = BTreeMap<String, Vec<String>>;

/// 注入到每个新文档最前面的采集脚本。
///
/// 只采经字段类型和敏感键过滤、再受严格大小限制的表单值；不采页面标题、点击元素、
/// 按键、Cookie 或文件内容。滚动按 500ms 合并，否则一次拖动就是几十条。
///
/// 每次上报的 `dwellMs` 是**自上次上报以来**的增量，不是累计值：于是宿主侧只需要
/// 相加，同一个地址被访问两次也能算对。页面转到后台时先结账再停表，所以隐藏期间
/// 的时间不计入停留时长。60 秒的心跳兜住「开着不动」的页面——浏览器被强杀时
/// `pagehide` 不一定跑得到，心跳把损失封在一分钟内。
const COLLECTOR_SCRIPT: &str = r#"(() => {
  'use strict';
  if (window.top !== window) return;
  const report = window.__vestusReportActivity;
  if (typeof report !== 'function') return;
  try { delete window.__vestusReportActivity; } catch (error) {}

  const FLUSH_DELAY = 1000;
  const SCROLL_COALESCE = 500;
  const HEARTBEAT = 60000;
  const MAX_SNAPSHOT_FIELDS = 50;
  const MAX_SNAPSHOT_KEY_BYTES = 128;
  const MAX_SNAPSHOT_VALUES_PER_FIELD = 20;
  const MAX_SNAPSHOT_VALUE_BYTES = 512;
  const MAX_SNAPSHOT_TOTAL_BYTES = 32 * 1024;
  const textEncoder = new TextEncoder();
  let pending = null;
  let timer = 0;
  let lastScroll = -SCROLL_COALESCE;
  let dwellBase = performance.now();
  const isSensitiveKey = (key) => {
    const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    return /password|passwd|pwd|token|secret|authorization|cookie|session|otp|captcha|cvv|cvc/.test(normalized);
  };
  const jsonBytes = (value) => textEncoder.encode(JSON.stringify(value)).length;
  const snapshotFor = (target) => {
    const form = target instanceof Element ? target.closest('form') : null;
    const scope = form || document;
    const snapshot = Object.create(null);
    let fieldCount = 0;
    // `{}` itself occupies two bytes. Maintain the exact JSON byte count so an
    // untrusted page cannot make this binding payload grow before Rust trims it.
    let snapshotBytes = 2;
    for (const field of scope.querySelectorAll('input, textarea, select')) {
      if (field.disabled) continue;
      const key = field.getAttribute('name') || field.id || field.getAttribute('aria-label');
      if (!key || isSensitiveKey(key)) continue;
      if (textEncoder.encode(key).length > MAX_SNAPSHOT_KEY_BYTES) continue;
      const type = field instanceof HTMLInputElement ? field.type.toLowerCase() : '';
      if (type === 'password' || type === 'hidden' || type === 'file') continue;
      let values;
      if (type === 'checkbox' || type === 'radio') values = [String(field.checked)];
      else if (field instanceof HTMLSelectElement && field.multiple) {
        values = Array.from(field.selectedOptions, option => option.value);
      } else values = [field.value];
      const hasField = () => Object.prototype.hasOwnProperty.call(snapshot, key);
      if (!hasField() && fieldCount >= MAX_SNAPSHOT_FIELDS) return snapshot;
      for (const value of values) {
        if ((hasField() ? snapshot[key] : []).length >= MAX_SNAPSHOT_VALUES_PER_FIELD) break;
        if (textEncoder.encode(value).length > MAX_SNAPSHOT_VALUE_BYTES) continue;
        const isNewField = !hasField();
        const addedBytes = jsonBytes(value)
          + (isNewField ? jsonBytes(key) + 3 + (fieldCount ? 1 : 0) : (snapshot[key].length ? 1 : 0));
        if (snapshotBytes + addedBytes > MAX_SNAPSHOT_TOTAL_BYTES) return snapshot;
        if (isNewField) { snapshot[key] = []; fieldCount += 1; }
        snapshot[key].push(value);
        snapshotBytes += addedBytes;
      }
    }
    return snapshot;
  };
  let pendingInputSnapshot = null;
  let pendingSubmitSnapshot = null;

  const send = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    const counts = pending;
    pending = null;
    const inputSnapshot = pendingInputSnapshot;
    pendingInputSnapshot = null;
    const submitSnapshot = pendingSubmitSnapshot;
    pendingSubmitSnapshot = null;
    const now = performance.now();
    const elapsed = Math.round(now - dwellBase);
    dwellBase = now;
    try {
      report(JSON.stringify({
        url: location.href,
        dwellMs: elapsed,
        counts: counts || {},
        inputSnapshot,
        submitSnapshot,
      }));
    } catch (error) {}
  };
  const bump = (kind) => {
    if (!pending) pending = {};
    pending[kind] = (pending[kind] || 0) + 1;
    if (!timer) timer = setTimeout(send, FLUSH_DELAY);
  };

  addEventListener('click', () => bump('click'), true);
  addEventListener('submit', (event) => {
    pendingSubmitSnapshot = snapshotFor(event.target);
    bump('submit');
  }, true);
  addEventListener('input', (event) => {
    pendingInputSnapshot = snapshotFor(event.target);
    bump('input');
  }, true);
  addEventListener('change', (event) => {
    pendingInputSnapshot = snapshotFor(event.target);
    bump('input');
  }, true);
  addEventListener('scroll', () => {
    const now = performance.now();
    if (now - lastScroll < SCROLL_COALESCE) return;
    lastScroll = now;
    bump('scroll');
  }, true);
  addEventListener('pagehide', send, true);
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') send();
    else dwellBase = performance.now();
  }, true);
  setInterval(() => {
    if (document.visibilityState === 'visible') send();
  }, HEARTBEAT);
})();
"#;

/// 一个页面的一次上报。聚合发生在 [`crate::activity`]，这里只负责翻译。
///
/// `visits` 为 1 的报告来自 CDP 的导航事件，其余字段全为 0；带计数和 `dwell_ms`
/// 的报告来自注入脚本，`visits` 为 0。两种来源不重叠。
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

#[derive(Debug, thiserror::Error)]
pub enum CdpError {
    #[error("连接调试端点失败：{0}")]
    Connect(String),
    #[error("调试端点握手失败：{0}")]
    Handshake(String),
    #[error("调试通道中断：{0}")]
    Transport(String),
}

/// 把一个 Chromium 进程的活动采集到 `sink`，直到调试通道关闭（通常就是浏览器退出）。
///
/// 返回 `Ok(())` 表示通道正常结束。任何错误都不该冒到用户面前：浏览器本身不依赖
/// 这条通道，采集失败只意味着这次会话没有日志。
pub async fn collect(
    endpoint: DevToolsEndpoint,
    sink: UnboundedSender<PageReport>,
) -> Result<(), CdpError> {
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

    let (mut writer, mut reader) = socket.split();
    let mut collector = Collector::default();
    for command in collector.opening_commands() {
        writer
            .send(Message::Text(command.into()))
            .await
            .map_err(|error| CdpError::Transport(error.to_string()))?;
    }

    while let Some(frame) = reader.next().await {
        let message = frame.map_err(|error| CdpError::Transport(error.to_string()))?;
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            // Ping/Pong 由 tungstenite 自动应答，二进制帧 CDP 不会发。
            _ => continue,
        };
        let handled = collector.handle(&text);
        for report in handled.reports {
            // 接收端没了说明这次会话已经收尾，继续采集没有意义。
            if sink.send(report).is_err() {
                return Ok(());
            }
        }
        for command in handled.commands {
            writer
                .send(Message::Text(command.into()))
                .await
                .map_err(|error| CdpError::Transport(error.to_string()))?;
        }
    }
    Ok(())
}

/// 注入脚本一次批量上报能有的最大计数。脚本按 1 秒批量，真人操作差着几个数量级；
/// 之所以还要夹一下，是因为这串 JSON 终究是页面进程递过来的。
const MAX_COUNT_PER_REPORT: u64 = 10_000;

/// 单个上报的停留时长上限（7 天）。`performance.now()` 是页面自己给的。
const MAX_DWELL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// 把注入脚本回传的 JSON 翻成一条报告。
pub(crate) fn parse_payload(payload: &str) -> Option<PageReport> {
    let value: Value = serde_json::from_str(payload).ok()?;
    let (url, url_params) = normalize_page_url(value.get("url").and_then(Value::as_str)?)?;
    let counts = value.get("counts").unwrap_or(&Value::Null);
    let count = |kind: &str| -> u32 {
        counts
            .get(kind)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(MAX_COUNT_PER_REPORT) as u32
    };
    Some(PageReport {
        url,
        url_params,
        visits: 0,
        clicks: count("click"),
        inputs: count("input"),
        submits: count("submit"),
        scrolls: count("scroll"),
        dwell_ms: value
            .get("dwellMs")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(MAX_DWELL_MS),
        input_snapshot: sanitize_snapshot(value.get("inputSnapshot")),
        input_snapshot_at_ms: 0,
        submit_snapshot: sanitize_snapshot(value.get("submitSnapshot")),
        submit_snapshot_at_ms: 0,
    })
}

fn sanitize_snapshot(value: Option<&Value>) -> Option<FormSnapshot> {
    let fields = value?.as_object()?;
    let mut snapshot = FormSnapshot::new();
    // Do not make the retained prefix depend on serde_json's optional
    // preserve_order feature or on the order a hostile page chose for keys.
    let mut ordered_fields = fields.iter().collect::<Vec<_>>();
    ordered_fields.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
    for (key, values) in ordered_fields {
        if !snapshot.contains_key(key) && snapshot.len() >= MAX_SNAPSHOT_FIELDS {
            break;
        }
        if key.len() > MAX_SNAPSHOT_KEY_BYTES || is_sensitive_key(key) {
            continue;
        }
        let Some(values) = values.as_array() else {
            continue;
        };
        for value in values.iter().filter_map(Value::as_str) {
            if value.len() > MAX_SNAPSHOT_VALUE_BYTES {
                continue;
            }
            if snapshot
                .get(key)
                .is_some_and(|existing| existing.len() >= MAX_SNAPSHOT_VALUES_PER_FIELD)
            {
                break;
            }
            let mut candidate = snapshot.clone();
            candidate
                .entry(key.clone())
                .or_default()
                .push(value.to_string());
            // Measure the actual wire value, including JSON escaping and punctuation.
            // The source map is ordered, so stopping at this boundary is deterministic.
            if serde_json::to_vec(&candidate)
                .map_or(true, |encoded| encoded.len() > MAX_SNAPSHOT_TOTAL_BYTES)
            {
                return (!snapshot.is_empty()).then_some(snapshot);
            }
            snapshot = candidate;
        }
    }
    (!snapshot.is_empty()).then_some(snapshot)
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
}

/// 协议状态机。刻意不碰 IO，于是整套分支都能在没有浏览器的情况下测。
#[derive(Debug, Default)]
struct Collector {
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
    /// 装两遍的后果是这个页面的每个事件都被算两遍：`Runtime.bindingCalled` 双份，
    /// `Page.frameNavigated` 双份，于是管理台看到的点击数和访问数都是虚高的。
    sessions: HashMap<String, String>,
}

impl Collector {
    /// 连上之后立刻发的两条命令。
    ///
    /// `setAutoAttach` 覆盖之后新建的标签页和弹窗；`getTargets` 是为了补上连接建立
    /// 之前就存在的那一个初始标签页——它不会再触发 `attachedToTarget`。
    fn opening_commands(&mut self) -> Vec<String> {
        let auto_attach = self.command(
            None,
            "Target.setAutoAttach",
            json!({
                "autoAttach": true,
                // 让新 target 停在第一行脚本之前，于是注入脚本一定装在页面
                // 自己的脚本前面。放行由 Runtime.runIfWaitingForDebugger 负责。
                "waitForDebuggerOnStart": true,
                // flatten 把子 session 复用同一条 WebSocket，靠 sessionId 区分。
                "flatten": true,
            }),
        );
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

    /// 给一个刚附上的 page session 装采集，并放行它。
    fn install(&mut self, session_id: &str) -> Vec<String> {
        vec![
            self.command(Some(session_id), "Page.enable", json!({})),
            self.command(Some(session_id), "Runtime.enable", json!({})),
            self.command(
                Some(session_id),
                "Runtime.addBinding",
                json!({ "name": BINDING_NAME }),
            ),
            self.command(
                Some(session_id),
                "Page.addScriptToEvaluateOnNewDocument",
                json!({ "source": COLLECTOR_SCRIPT }),
            ),
            // 必须最后发：放行之前所有订阅都得就位，否则首个文档会漏采。
            self.command(
                Some(session_id),
                "Runtime.runIfWaitingForDebugger",
                json!({}),
            ),
        ]
    }

    /// 放行一个我们不采集的 target，然后断开它。
    ///
    /// browser 级 autoAttach 送上来的不只有页面：Service Worker、Shared Worker
    /// 以及各种 `other` target 都会附上来，而 `waitForDebuggerOnStart` 把它们**全
    /// 部**停在第一行脚本之前。Chromium 不会因为我们不理它就自动放行，光 detach
    /// 也不行——被暂停的 target 不会随 session 断开而恢复。所以每一个附上来的
    /// target 都得显式放行，而且必须先放行再断开。
    ///
    /// 漏掉这一步的代价不是「少采一点数据」：
    ///
    /// * 被暂停的 Service Worker 接管不了导航请求，二次进入这个站点时页面会停在
    ///   空白帧上直到 SW 启动超时（表现为内容区灰屏、刷新才恢复）；
    /// * 关闭浏览器时 Chromium 会等这些暂停的进程恢复，于是关不掉，只能被
    ///   [`crate::browser`] 强杀，profile 也就删不干净。
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
            // 命令回执。只有 getTargets 的结果有用：把连接建立之前就存在的页面
            // 补附上来。其余回执（包括各种 error）忽略——采集失败不该影响浏览。
            if message.get("id").and_then(Value::as_i64) == Some(self.get_targets_id) {
                out.commands = self.attach_existing_pages(&message);
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
                    self.sessions.remove(gone);
                }
            }
            // 整文档跳转。只认主框架：iframe 的导航不是「用户访问了一个页面」。
            //
            // 也只认自己装过的 session。Chromium 把 Page 事件发给该 target 上**每一条**
            // 附着的 session，所以不认 session 就等于「同一个页面附了几条就记几次」。
            "Page.frameNavigated" if self.is_installed_session(session_id) => {
                let frame = params.get("frame").unwrap_or(&Value::Null);
                if frame.get("parentId").is_none() {
                    if let Some(url) = frame.get("url").and_then(Value::as_str) {
                        out.reports.extend(
                            normalize_page_url(url)
                                .map(|(url, url_params)| PageReport::visit_parts(url, url_params)),
                        );
                    }
                }
            }
            // pushState/replaceState。没有新文档，注入脚本不会重跑，所以 SPA 的
            // 路由切换只有这个事件能看见。
            "Page.navigatedWithinDocument" if self.is_installed_session(session_id) => {
                if let Some(url) = params.get("url").and_then(Value::as_str) {
                    out.reports.extend(
                        normalize_page_url(url)
                            .map(|(url, url_params)| PageReport::visit_parts(url, url_params)),
                    );
                }
            }
            "Runtime.bindingCalled" => {
                let is_ours = params.get("name").and_then(Value::as_str) == Some(BINDING_NAME)
                    && self.is_installed_session(session_id);
                if is_ours {
                    let payload = params.get("payload").and_then(Value::as_str).unwrap_or("");
                    out.reports.extend(parse_payload(payload));
                }
            }
            _ => {}
        }
        out
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
        // 这个页面已经有一条装好的 session 了，这是第二条通往同一个 target 的路。
        // 放行并断开它：留着会让这个页面的每个事件都被算两遍。
        if self.is_installed_target(target_id) {
            out.commands.extend(self.resume_and_detach(&session_id));
            return;
        }
        self.sessions
            .insert(session_id.clone(), target_id.to_string());
        // 已经附上的页面不会再补一条 frameNavigated，所以它当前的地址只能从这里
        // 拿。新建的 target 这里通常是 about:blank，被 normalize_url 过滤掉。
        if let Some(url) = target.get("url").and_then(Value::as_str) {
            out.reports.extend(
                normalize_page_url(url)
                    .map(|(url, url_params)| PageReport::visit_parts(url, url_params)),
            );
        }
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
        !target_id.is_empty() && self.sessions.values().any(|known| known == target_id)
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
mod tests {
    use super::*;

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

    /// 放行必须是最后一条：`runIfWaitingForDebugger` 之前 addBinding 和注入脚本
    /// 都得就位，否则首个文档就漏采了。
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
                "Runtime.enable",
                "Runtime.addBinding",
                "Page.addScriptToEvaluateOnNewDocument",
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

    /// 连接建立之前就存在的初始标签页不会再触发 attachedToTarget，它当前的地址
    /// 只能从 targetInfo 里拿——否则用户点开浏览器看到的第一个页面永远不入库。
    #[test]
    fn attaching_an_existing_page_records_the_url_it_already_has() {
        let mut collector = Collector::default();
        collector.opening_commands();

        let handled = collector.handle(&attached("S1", "page", "https://shop.example.test/orders"));
        assert_eq!(
            handled.reports,
            vec![PageReport::visit_parts(
                "https://shop.example.test/orders".into(),
                None,
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
                "name": BINDING_NAME,
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

    /// 计数只认自己附过的 session 和自己注册的 binding 名字。
    #[test]
    fn binding_calls_are_accepted_only_from_an_installed_session() {
        let mut collector = Collector::default();
        collector.opening_commands();
        collector.handle(&attached("S1", "page", "about:blank"));

        let call = |session: &str, name: &str| {
            json!({
                "sessionId": session,
                "method": "Runtime.bindingCalled",
                "params": {
                    "name": name,
                    "payload": json!({
                        "url": "https://shop.example.test/cart?token=secret",
                        "dwellMs": 4200,
                        "counts": { "click": 3, "input": 2, "submit": 1, "scroll": 7 },
                    })
                    .to_string(),
                }
            })
            .to_string()
        };

        assert_eq!(
            collector.handle(&call("S1", BINDING_NAME)).reports,
            vec![PageReport {
                url: "https://shop.example.test/cart".into(),
                url_params: Some("token=%5BREDACTED%5D".into()),
                visits: 0,
                clicks: 3,
                inputs: 2,
                submits: 1,
                scrolls: 7,
                dwell_ms: 4200,
                ..PageReport::default()
            }]
        );
        assert!(collector
            .handle(&call("S9", BINDING_NAME))
            .reports
            .is_empty());
        assert!(collector
            .handle(&call("S1", "somethingElse"))
            .reports
            .is_empty());
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

    /// 这串 JSON 终究是页面进程递过来的：缺字段、类型不对、数值离谱都不能崩，
    /// 也不能把离谱的数写进聚合。
    #[test]
    fn payload_is_clamped_and_validated() {
        assert!(parse_payload("").is_none());
        assert!(parse_payload("{}").is_none());
        assert!(parse_payload(&json!({ "url": "about:blank" }).to_string()).is_none());

        let missing_counts =
            parse_payload(&json!({ "url": "https://a.example.test/" }).to_string())
                .expect("只有 url 也是一条合法上报");
        assert_eq!(missing_counts.clicks, 0);
        assert_eq!(missing_counts.dwell_ms, 0);
        assert_eq!(missing_counts.visits, 0);

        let absurd = parse_payload(
            &json!({
                "url": "https://a.example.test/",
                "dwellMs": 99_999_999_999_u64,
                "counts": { "click": 999_999_999, "input": -5, "scroll": "many" },
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(absurd.clicks, MAX_COUNT_PER_REPORT as u32);
        assert_eq!(absurd.dwell_ms, MAX_DWELL_MS);
        assert_eq!(absurd.inputs, 0);
        assert_eq!(absurd.scrolls, 0);
    }

    #[test]
    fn payload_splits_and_redacts_query_parameters_before_aggregation() {
        let report = parse_payload(
            &json!({
                "url": "https://shop.example.test/cart?order=42&TOKEN=secret&empty=&order=43#top",
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(report.url, "https://shop.example.test/cart");
        assert!(format!("{report:?}")
            .contains("url_params: Some(\"order=42&TOKEN=%5BREDACTED%5D&empty=&order=43\")"));
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

    #[test]
    fn payload_rejects_sensitive_and_oversized_snapshot_values() {
        let long_value = "x".repeat(513);
        let payload = json!({
            "url": "https://shop.example.test/cart",
            "inputSnapshot": {
                "email": ["buyer@example.test"],
                "password": ["do-not-collect"],
                "tooLong": [long_value],
            },
            "submitSnapshot": { "quantity": ["2"] },
        })
        .to_string();

        let report = parse_payload(&payload).unwrap();
        let debug = format!("{report:?}");
        assert!(debug.contains("input_snapshot: Some({\"email\": [\"buyer@example.test\"]})"));
        assert!(debug.contains("submit_snapshot: Some({\"quantity\": [\"2\"]})"));
        assert!(!debug.contains("do-not-collect"));
        assert!(!debug.contains("tooLong"));
    }

    #[test]
    fn snapshot_sanitizing_enforces_utf8_and_total_byte_boundaries() {
        let accepted_key = "界".repeat(42); // 126 UTF-8 bytes
        let rejected_key = "界".repeat(43); // 129 UTF-8 bytes
        let accepted_value = "🚀".repeat(128); // 512 UTF-8 bytes
        let rejected_value = "🚀".repeat(129); // 516 UTF-8 bytes
        let mut fields = serde_json::Map::new();
        fields.insert(accepted_key.clone(), json!([accepted_value]));
        fields.insert(rejected_key.clone(), json!(["ignored"]));
        fields.insert("too-large".into(), json!([rejected_value]));
        let snapshot = sanitize_snapshot(Some(&Value::Object(fields))).unwrap();
        assert!(snapshot.contains_key(&accepted_key));
        assert!(!snapshot.contains_key(&rejected_key));
        assert!(!snapshot.contains_key("too-large"));

        let mut large_fields = serde_json::Map::new();
        for index in 0..50 {
            large_fields.insert(
                format!("field-{index:02}"),
                json!(vec!["x".repeat(512); 20]),
            );
        }
        let snapshot = sanitize_snapshot(Some(&Value::Object(large_fields))).unwrap();
        assert!(serde_json::to_vec(&snapshot).unwrap().len() <= MAX_SNAPSHOT_TOTAL_BYTES);
        assert!(snapshot.len() <= MAX_SNAPSHOT_FIELDS);
        assert!(snapshot
            .values()
            .all(|values| values.len() <= MAX_SNAPSHOT_VALUES_PER_FIELD));
    }

    #[test]
    fn payload_leaves_snapshot_timestamps_for_the_aggregate_to_assign() {
        let report = parse_payload(
            &json!({
                "url": "https://a.test/p",
                "inputSnapshot": { "email": ["buyer@example.test"] },
            })
            .to_string(),
        )
        .unwrap();

        let debug = format!("{report:?}");
        assert!(debug.contains("input_snapshot_at_ms: 0"));
        assert!(debug.contains("submit_snapshot_at_ms: 0"));
    }

    /// 注入脚本必须只在顶层文档跑、必须先摘掉全局属性，只读取经白名单过滤的表单值。
    #[test]
    fn the_injected_script_collects_only_safe_form_snapshots() {
        assert!(COLLECTOR_SCRIPT.contains("if (window.top !== window) return;"));
        assert!(COLLECTOR_SCRIPT.contains(&format!("delete window.{BINDING_NAME}")));
        assert!(COLLECTOR_SCRIPT.contains(&format!("window.{BINDING_NAME}")));
        assert!(COLLECTOR_SCRIPT.contains("inputSnapshot"));
        assert!(COLLECTOR_SCRIPT.contains("submitSnapshot"));
        assert!(COLLECTOR_SCRIPT.contains("input, textarea, select"));
        assert!(COLLECTOR_SCRIPT.contains("type === 'password'"));
        assert!(COLLECTOR_SCRIPT.contains("type === 'hidden'"));
        assert!(COLLECTOR_SCRIPT.contains("type === 'file'"));
        assert!(COLLECTOR_SCRIPT.contains("selectedOptions"));
        assert!(COLLECTOR_SCRIPT.contains("checked"));
        assert!(COLLECTOR_SCRIPT.contains("MAX_SNAPSHOT_FIELDS = 50"));
        assert!(COLLECTOR_SCRIPT.contains("MAX_SNAPSHOT_VALUES_PER_FIELD = 20"));
        assert!(COLLECTOR_SCRIPT.contains("MAX_SNAPSHOT_KEY_BYTES = 128"));
        assert!(COLLECTOR_SCRIPT.contains("MAX_SNAPSHOT_VALUE_BYTES = 512"));
        assert!(COLLECTOR_SCRIPT.contains("MAX_SNAPSHOT_TOTAL_BYTES = 32 * 1024"));
        assert!(COLLECTOR_SCRIPT.contains("return snapshot"));
        assert!(COLLECTOR_SCRIPT.contains("Object.create(null)"));
        assert!(COLLECTOR_SCRIPT.contains("Object.prototype.hasOwnProperty.call(snapshot, key)"));
        assert!(COLLECTOR_SCRIPT.contains("replace(/[^a-z0-9]/g, '')"));
        // 不读取页面其它敏感内容。
        for forbidden in [
            "textContent",
            "innerText",
            "outerHTML",
            "event.key",
            "document.title",
            "document.cookie",
        ] {
            assert!(!COLLECTOR_SCRIPT.contains(forbidden), "{forbidden}");
        }
    }

    /// `dwellMs` 必须是增量。改成累计值会让宿主侧的相加变成平方级放大，
    /// 而宿主侧确实是相加——同一个地址访问两次，时间要能叠上去。
    #[test]
    fn the_injected_script_reports_dwell_as_a_delta() {
        assert!(COLLECTOR_SCRIPT.contains("Math.round(now - dwellBase)"));
        assert!(COLLECTOR_SCRIPT.contains("dwellBase = now;"));
        // 转到后台先结账再停表，回到前台重新起表：隐藏期间不计时长
        assert!(COLLECTOR_SCRIPT.contains("else dwellBase = performance.now();"));
        // 心跳兜住「开着不动」的页面：浏览器被强杀时 pagehide 不一定跑得到
        assert!(COLLECTOR_SCRIPT.contains("setInterval"));
    }
}
