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
//! 只上报「规范化后的 URL + 各类操作次数 + 停留时长」。不采页面标题、不采表单
//! 内容、不采点了哪个元素、不采按了哪个键，也不采 query——[`normalize_url`] 在进
//! 内存之前就剥掉 query 和 fragment，它们经常带 token、session id 和搜索词。
//!
//! # 与页面脚本的隔离
//!
//! 注入脚本在文档最前面运行，拿到 binding 的函数引用后立刻 `delete` 掉那个全局
//! 属性。于是页面自己的脚本既看不见这个通道，也没法伪造上报。

use std::collections::HashSet;
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

/// 注入到每个新文档最前面的采集脚本。
///
/// 只数事件个数，不看事件内容：没有 `event.target`、没有键值、没有表单值。滚动
/// 按 500ms 合并，否则一次拖动就是几十条。
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
  let pending = null;
  let timer = 0;
  let lastScroll = -SCROLL_COALESCE;
  let dwellBase = performance.now();

  const send = () => {
    if (timer) { clearTimeout(timer); timer = 0; }
    const counts = pending;
    pending = null;
    const now = performance.now();
    const elapsed = Math.round(now - dwellBase);
    dwellBase = now;
    try {
      report(JSON.stringify({
        url: location.href,
        dwellMs: elapsed,
        counts: counts || {},
      }));
    } catch (error) {}
  };
  const bump = (kind) => {
    if (!pending) pending = {};
    pending[kind] = (pending[kind] || 0) + 1;
    if (!timer) timer = setTimeout(send, FLUSH_DELAY);
  };

  addEventListener('click', () => bump('click'), true);
  addEventListener('submit', () => bump('submit'), true);
  addEventListener('input', () => bump('input'), true);
  addEventListener('change', () => bump('input'), true);
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
    pub visits: u32,
    pub clicks: u32,
    pub inputs: u32,
    pub submits: u32,
    pub scrolls: u32,
    /// 自上一次上报以来的停留毫秒数（增量，不含页面在后台的时间）。因为是增量，
    /// 聚合时直接相加即可，同一个地址被访问两次也不会互相覆盖。
    pub dwell_ms: u64,
}

impl PageReport {
    fn visit(url: String) -> Self {
        Self {
            url,
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
fn parse_payload(payload: &str) -> Option<PageReport> {
    let value: Value = serde_json::from_str(payload).ok()?;
    let url = normalize_url(value.get("url").and_then(Value::as_str)?)?;
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
    })
}

/// 只留 scheme + host + port + path，别的一概不要。
///
/// query 和 fragment 是明确的采集边界：它们经常带 token、session id 和搜索词，
/// 剥在这里意味着它们连内存都进不去。凭据一起去掉——`Url` 会把它们序列化回
/// host 前面。非 http(s) 的地址（`about:blank`、`chrome://`、`devtools://`）
/// 不是「访问了一个页面」，直接丢。
pub fn normalize_url(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_query(None);
    url.set_fragment(None);
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    let normalized = url.into();
    // 剥完还超长的只能是病态路径：截断会造出一个并不存在的地址，所以宁可不记。
    Some(normalized).filter(|value: &String| value.len() <= MAX_URL_BYTES)
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
    /// 已经装好采集的 page 级 sessionId。既用于去重，也用于确认 `bindingCalled`
    /// 来自我们自己附上的页面。
    sessions: HashSet<String>,
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
            "Page.frameNavigated" => {
                let frame = params.get("frame").unwrap_or(&Value::Null);
                if frame.get("parentId").is_none() {
                    if let Some(url) = frame.get("url").and_then(Value::as_str) {
                        out.reports
                            .extend(normalize_url(url).map(PageReport::visit));
                    }
                }
            }
            // pushState/replaceState。没有新文档，注入脚本不会重跑，所以 SPA 的
            // 路由切换只有这个事件能看见。
            "Page.navigatedWithinDocument" => {
                if let Some(url) = params.get("url").and_then(Value::as_str) {
                    out.reports
                        .extend(normalize_url(url).map(PageReport::visit));
                }
            }
            "Runtime.bindingCalled" => {
                let is_ours = params.get("name").and_then(Value::as_str) == Some(BINDING_NAME)
                    && session_id.is_some_and(|id| self.sessions.contains(id));
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
        if !self.sessions.insert(session_id.clone()) {
            return;
        }
        // 已经附上的页面不会再补一条 frameNavigated，所以它当前的地址只能从这里
        // 拿。新建的 target 这里通常是 about:blank，被 normalize_url 过滤掉。
        if let Some(url) = target.get("url").and_then(Value::as_str) {
            out.reports
                .extend(normalize_url(url).map(PageReport::visit));
        }
        out.commands.extend(self.install(&session_id));
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
            vec![PageReport::visit("https://shop.example.test/orders".into())]
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

    /// 主框架跳转算一次访问，iframe 的跳转不算——一个页面里十个广告位不是十次访问。
    #[test]
    fn only_the_main_frame_navigation_counts_as_a_visit() {
        let mut collector = Collector::default();

        let main = json!({
            "sessionId": "S1",
            "method": "Page.frameNavigated",
            "params": { "frame": { "id": "F1", "url": "https://shop.example.test/cart" } }
        })
        .to_string();
        assert_eq!(
            collector.handle(&main).reports,
            vec![PageReport::visit("https://shop.example.test/cart".into())]
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
        let mut collector = Collector::default();
        let event = json!({
            "sessionId": "S1",
            "method": "Page.navigatedWithinDocument",
            "params": { "frameId": "F1", "url": "https://shop.example.test/orders/1" }
        })
        .to_string();

        assert_eq!(
            collector.handle(&event).reports,
            vec![PageReport::visit(
                "https://shop.example.test/orders/1".into()
            )]
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
                visits: 0,
                clicks: 3,
                inputs: 2,
                submits: 1,
                scrolls: 7,
                dwell_ms: 4200,
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

    /// 注入脚本必须只在顶层文档跑、必须先摘掉全局属性、且不许碰事件内容。
    #[test]
    fn the_injected_script_stays_within_the_collection_boundary() {
        assert!(COLLECTOR_SCRIPT.contains("if (window.top !== window) return;"));
        assert!(COLLECTOR_SCRIPT.contains(&format!("delete window.{BINDING_NAME}")));
        assert!(COLLECTOR_SCRIPT.contains(&format!("window.{BINDING_NAME}")));
        // 只数个数：不读元素、不读键、不读表单值
        for forbidden in [
            "event.target",
            ".value",
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
