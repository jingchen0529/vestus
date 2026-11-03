//! Opt-in real Chromium regressions; all pages, cookies and profiles are local.
//! Run with VESTUS_TEST_CHROMIUM_PATH and `real_chromium_ --ignored`.

use super::*;
use std::future::Future;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::{interval, Instant};

const POLL_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(25);
static REAL_CHROMIUM_LOCK: Mutex<()> = Mutex::new(());

fn with_real_chromium(test: impl Future<Output = ()>) {
    // Do not compete for browser startup/renderer time, even with cargo's default
    // parallel test runner. A failed test must not poison the remaining cases.
    let _serial = REAL_CHROMIUM_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    crate::rt::runtime().block_on(async {
        timeout(Duration::from_secs(120), test)
            .await
            .expect("local Chromium regression timed out");
    });
}

struct TestBrowser {
    child: Child,
    dir: PathBuf,
}

impl Drop for TestBrowser {
    fn drop(&mut self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while matches!(self.child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn launch_test_browser() -> (TestBrowser, DevToolsEndpoint) {
    let executable = std::env::var_os("VESTUS_TEST_CHROMIUM_PATH")
        .map(PathBuf::from)
        .expect("set VESTUS_TEST_CHROMIUM_PATH to an existing Chromium binary");
    assert!(executable.is_file(), "test Chromium executable must exist");
    let dir = std::env::temp_dir().join(format!(
        "vestus-managed-cdp-regression-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir(&dir).unwrap();
    let child = Command::new(executable)
        .arg(format!("--user-data-dir={}", dir.display()))
        .args([
            "--headless=new",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-crash-reporter",
            "--disable-breakpad",
            "--password-store=basic",
            "--use-mock-keychain",
            "--no-proxy-server",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
            "about:blank",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut browser = TestBrowser { child, dir };
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let endpoint = loop {
        if let Ok(contents) = std::fs::read_to_string(browser.dir.join("DevToolsActivePort")) {
            if let Some(endpoint) = crate::browser::parse_devtools_active_port(&contents) {
                break endpoint;
            }
        }
        assert!(
            browser.child.try_wait().unwrap().is_none(),
            "browser exited during startup"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "DevTools port timeout"
        );
        std::thread::sleep(Duration::from_millis(30));
    };
    (browser, endpoint)
}

// The FIRST inline script samples the DOM before any fixture event can make a
// late guard look correct. The app's own capture listeners must also be blocked,
// not just its target listeners. Evidence survives automatic login navigation in
// local sessionStorage; observable root state and event delivery are the contract.
const FIXTURE_HTML: &str = r#"<!doctype html><html><head><script>
(() => {
  const sample = () => {
    const root = document.documentElement;
    const style = getComputedStyle(root);
    return {
      origin: location.origin, path: location.pathname,
      opacity: style.opacity, pointerEvents: style.pointerEvents, inert: root.inert,
      inlineOpacity: root.style.getPropertyValue('opacity'),
      opacityPriority: root.style.getPropertyPriority('opacity'),
      inlinePointer: root.style.getPropertyValue('pointer-events'),
      pointerPriority: root.style.getPropertyPriority('pointer-events'),
    };
  };
  const first = sample();
  const kinds = ['click', 'submit', 'input', 'paste'];
  const zeros = () => Object.fromEntries(kinds.map(kind => [kind, 0]));
  const state = window.__fixture = {
    first, sample, ready: false, historyProbes: [],
    counts: {capture: zeros(), target: zeros(), trustedClicks: 0},
  };
  for (const kind of kinds) {
    window.addEventListener(kind, event => {
      state.counts.capture[kind]++;
      if (kind === 'click' && event.isTrusted) state.counts.trustedClicks++;
    }, true);
  }
  window.addEventListener('popstate', () => {
    state.historyProbes.push(state.exercise());
  }, true);
})();
</script><title>Local managed session fixture</title></head><body>
<button id="fixture-button" type="button" style="width:180px;height:44px">Local action</button>
<form id="fixture-form" action="/unexpected-submit">
<input id="fixture-input" name="local_field" value="fixture-only">
<button type="submit">Local submit</button>
</form><script>
(() => {
  const state = window.__fixture;
  const button = document.getElementById('fixture-button');
  const form = document.getElementById('fixture-form');
  const input = document.getElementById('fixture-input');
  const targets = {click: button, submit: form, input, paste: input};
  for (const [kind, target] of Object.entries(targets)) {
    target.addEventListener(kind, event => {
      state.counts.target[kind]++;
      if (kind === 'submit') event.preventDefault();
    });
  }
  state.exercise = () => {
    const root = state.sample();
    const before = structuredClone(state.counts);
    const canceled = {};
    for (const [kind, target] of Object.entries(targets)) {
      const EventType = kind === 'click' ? MouseEvent : Event;
      canceled[kind] = !target.dispatchEvent(new EventType(kind, {bubbles: true, cancelable: true}));
    }
    return {root, before, after: structuredClone(state.counts), canceled};
  };
  const params = new URLSearchParams(location.search);
  const key = 'vestus-local-login-proof:' + params.get('case');
  state.loginProof = JSON.parse(sessionStorage.getItem(key) || 'null');
  state.initialProbe = state.exercise();
  state.snapshot = () => ({
    first: state.first, initialProbe: state.initialProbe, loginProof: state.loginProof,
    root: state.sample(), counts: structuredClone(state.counts), historyProbes: state.historyProbes,
  });
  state.ready = true;
  const origins = __FIXTURE_ORIGINS__;
  let next;
  if (location.pathname === '/hop') {
    next = new URL('/product', origins.product);
  } else if (location.pathname === '/product') {
    next = new URL(params.get('nested') === '1' ? '/login/challenge' : '/login', origins.login);
    params.set('auto', '1');
  } else if ((location.pathname === '/login' || location.pathname.startsWith('/login/'))
             && params.get('auto') === '1') {
    sessionStorage.setItem(key, JSON.stringify({first: state.first, probe: state.initialProbe}));
    next = new URL('/workbench', origins.login);
    params.delete('auto');
  }
  // The page's own redirect must still run while the login subtree is locked.
  if (next) {
    next.search = params.toString();
    location.replace(next.href);
  }
})();
</script></body></html>"#;

struct TestPages {
    base: String,
    product: String,
    cookie_seen: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Url>>>,
    servers: Vec<JoinHandle<()>>,
}

impl Drop for TestPages {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
    }
}

impl TestPages {
    async fn start() -> Self {
        let login = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let product = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut pages = Self {
            base: format!("http://{}", login.local_addr().unwrap()),
            product: format!("http://{}", product.local_addr().unwrap()),
            cookie_seen: Arc::new(AtomicBool::new(false)),
            requests: Arc::new(Mutex::new(Vec::new())),
            servers: Vec::new(),
        };
        let html = FIXTURE_HTML.replace(
            "__FIXTURE_ORIGINS__",
            &json!({"login": pages.base, "product": pages.product}).to_string(),
        );
        for (listener, origin) in [
            (login, pages.base.clone()),
            (product, pages.product.clone()),
        ] {
            let html = html.clone();
            let seen = pages.cookie_seen.clone();
            let requests = pages.requests.clone();
            pages.servers.push(tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {
                        accepted = listener.accept() => {
                            let Ok((stream, _)) = accepted else { break };
                            let (origin, html, seen, requests) =
                                (origin.clone(), html.clone(), seen.clone(), requests.clone());
                            connections.spawn(async move {
                                let _ = timeout(POLL_TIMEOUT, serve_fixture(stream, origin, html, seen, requests)).await;
                            });
                        }
                        Some(_) = connections.join_next() => {}
                    }
                }
            }));
        }
        pages
    }

    fn policy(&self) -> LogoutPolicy {
        LogoutPolicy {
            endpoint: Url::parse(&format!("{}/sso_logout", self.base)).unwrap(),
            login_route: Url::parse(&format!("{}/login", self.base)).unwrap(),
        }
    }

    fn hop_url(&self, case: &str, nested: bool) -> String {
        format!("{}/hop?case={case}&nested={}", self.base, u8::from(nested))
    }

    fn assert_hops(&self, case: &str, nested: bool) {
        let requests = self.requests.lock().unwrap();
        let actual: Vec<_> = requests
            .iter()
            .filter(|url| {
                url.query_pairs()
                    .any(|(key, value)| key == "case" && value == case)
            })
            .map(|url| format!("{}{}", url.origin().ascii_serialization(), url.path()))
            .collect();
        let login_path = if nested { "/login/challenge" } else { "/login" };
        assert_eq!(
            actual,
            vec![
                format!("{}/hop", self.base),
                format!("{}/product", self.product),
                format!("{}{login_path}", self.base),
                format!("{}/workbench", self.base),
            ],
            "{case} must execute both local-origin hops before returning through login"
        );
    }
}

async fn serve_fixture(
    mut stream: TcpStream,
    origin: String,
    html: String,
    seen: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Url>>>,
) {
    let mut request = Vec::new();
    loop {
        let mut buf = [0; 2048];
        let count = stream.read(&mut buf).await.unwrap_or(0);
        if count == 0 {
            return;
        }
        request.extend_from_slice(&buf[..count]);
        if request.len() > 16 * 1024 {
            return;
        }
        if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&request);
    let path = request.split_whitespace().nth(1).unwrap_or("/");
    let Ok(url) = Url::parse(&format!("{origin}{path}")) else {
        return;
    };
    requests.lock().unwrap().push(url.clone());
    let (content_type, body) = match url.path() {
        "/immediate" => {
            seen.store(
                request.contains("regression_session=local-only"),
                Ordering::Release,
            );
            (
                "text/html",
                "<!doctype html><script>location.replace('/sso_logout?test=redirect')</script>",
            )
        }
        "/spa" => (
            "text/html",
            "<!doctype html><script>history.replaceState({}, '', '/sso_logout?test=spa')</script>",
        ),
        "/worker.js" => (
            "text/javascript",
            "onmessage = () => postMessage('local-worker-ready');",
        ),
        "/favicon.ico" => ("image/x-icon", ""),
        _ => ("text/html", html.as_str()),
    };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn local_session(target: String) -> ManagedSession {
    validate_session(
        serde_json::from_value(json!({
            "targetUrl": target, "allowedHosts": ["127.0.0.1"],
            "cookies": [{"name": "regression_session", "value": "local-only", "domain": "127.0.0.1",
                         "path": "/", "secure": false, "httpOnly": true}]
        }))
        .unwrap(),
    )
    .unwrap()
}

// This control connection never auto-attaches or resumes targets. Only the real
// managed watcher is allowed to release pages paused at document start.
struct TestCdp {
    socket: ManagedSocket,
}

impl TestCdp {
    async fn connect(endpoint: &DevToolsEndpoint) -> Self {
        Self {
            socket: connect(endpoint).await.unwrap(),
        }
    }

    async fn command(&mut self, session: Option<&str>, method: &str, params: Value) -> Value {
        send_command(&mut self.socket, next_command_id(), method, params, session)
            .await
            .unwrap_or_else(|error| panic!("{method} failed: {error}"))
    }

    async fn targets(&mut self) -> Vec<Value> {
        self.command(None, "Target.getTargets", json!({})).await["targetInfos"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|info| info["type"] == "page")
            .cloned()
            .collect()
    }

    async fn attach(&mut self, target: &str) -> String {
        self.command(
            None,
            "Target.attachToTarget",
            json!({"targetId": target, "flatten": true}),
        )
        .await["sessionId"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn initial_page(&mut self) -> (String, String) {
        let targets = self.targets().await;
        assert_eq!(targets.len(), 1, "fresh profile must have exactly one page");
        let target = targets[0]["targetId"].as_str().unwrap().to_string();
        let session = self.attach(&target).await;
        (target, session)
    }

    async fn create_pages(&mut self, urls: &[String]) -> Vec<String> {
        // Send the whole burst before awaiting replies, so attach/enable/install
        // responses for different targets overlap instead of testing only one
        // fully initialized tab at a time.
        let mut pending = HashMap::new();
        let mut targets = vec![String::new(); urls.len()];
        for (index, url) in urls.iter().enumerate() {
            let id = next_command_id();
            pending.insert(id, index);
            self.socket
                .send(Message::Text(
                    json!({
                        "id": id, "method": "Target.createTarget", "params": {"url": url},
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
        }
        timeout(POLL_TIMEOUT, async {
            while !pending.is_empty() {
                let message = self
                    .socket
                    .next()
                    .await
                    .expect("control socket closed")
                    .unwrap();
                let Message::Text(text) = message else {
                    continue;
                };
                let reply: Value = serde_json::from_str(&text).unwrap();
                let Some(index) = reply["id"].as_i64().and_then(|id| pending.remove(&id)) else {
                    continue;
                };
                assert!(reply.get("error").is_none(), "createTarget failed: {reply}");
                targets[index] = reply["result"]["targetId"].as_str().unwrap().to_string();
            }
        })
        .await
        .expect("target creation burst timed out");
        targets
    }

    async fn try_evaluate(&mut self, session: &str, expression: &str) -> Result<Value, String> {
        let result = send_command(
            &mut self.socket,
            next_command_id(),
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true, "awaitPromise": true,
                   "userGesture": true, "timeout": 2000}),
            Some(session),
        )
        .await
        .map_err(|error| error.to_string())?;
        if let Some(exception) = result.get("exceptionDetails") {
            return Err(format!("fixture JavaScript exception: {exception}"));
        }
        Ok(result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    async fn evaluate(&mut self, session: &str, expression: &str) -> Value {
        self.try_evaluate(session, expression)
            .await
            .unwrap_or_else(|error| panic!("{expression}: {error}"))
    }

    async fn wait_for(&mut self, session: &str, expression: &str) -> Value {
        let deadline = Instant::now() + POLL_TIMEOUT;
        let mut poll = interval(POLL_INTERVAL);
        loop {
            poll.tick().await;
            let result = self.try_evaluate(session, expression).await;
            if let Ok(value) = &result {
                if !value.is_null() && value != &Value::Bool(false) {
                    return value.clone();
                }
            }
            // A navigation may destroy the execution context between probes.
            // Retry under a deadline, retaining the last state/error for diagnosis.
            assert!(
                Instant::now() < deadline,
                "waiting for {expression}: {result:?}"
            );
        }
    }

    async fn ready(&mut self, session: &str, path: &str, case: &str) -> Value {
        self.wait_for(session, &format!(
            "window.__fixture?.ready && location.pathname === {} && new URLSearchParams(location.search).get('case') === {} && __fixture.snapshot()",
            json!(path), json!(case),
        )).await
    }

    async fn click(&mut self, session: &str, locked: bool) {
        self.command(Some(session), "Page.bringToFront", json!({}))
            .await;
        let before = self
            .evaluate(session, "structuredClone(__fixture.counts)")
            .await;
        let point = self.evaluate(session,
            "(() => { const r = document.getElementById('fixture-button').getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; })()"
        ).await;
        for event_type in ["mousePressed", "mouseReleased"] {
            self.command(
                Some(session),
                "Input.dispatchMouseEvent",
                json!({
                    "type": event_type, "x": point["x"], "y": point["y"],
                    "button": "left", "clickCount": 1,
                }),
            )
            .await;
        }
        let after = self
            .evaluate(session, "structuredClone(__fixture.counts)")
            .await;
        let increment = u64::from(!locked);
        for phase in ["capture", "target"] {
            assert_eq!(
                after[phase]["click"].as_u64().unwrap(),
                before[phase]["click"].as_u64().unwrap() + increment,
                "trusted click, locked={locked}, {phase}"
            );
        }
        assert_eq!(
            after["trustedClicks"].as_u64().unwrap(),
            before["trustedClicks"].as_u64().unwrap() + increment
        );
    }
}

struct TestWatch {
    task: JoinHandle<(Instant, Result<bool, ManagedCdpError>)>,
}

impl Drop for TestWatch {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl TestWatch {
    async fn start(endpoint: &DevToolsEndpoint, policy: LogoutPolicy) -> Self {
        let watch = prepare_logout_watch_with_policy(endpoint, policy)
            .await
            .unwrap();
        Self {
            task: tokio::spawn(async move {
                let result = watch.wait().await;
                (Instant::now(), result)
            }),
        }
    }

    fn assert_running(&self) {
        assert!(
            !self.task.is_finished(),
            "watch ended without a persistent top-level login or logout"
        );
    }

    async fn finish_result(&mut self) -> (Instant, Result<bool, ManagedCdpError>) {
        timeout(POLL_TIMEOUT, &mut self.task)
            .await
            .expect("watch did not finish")
            .expect("watch task panicked")
    }

    async fn finish(&mut self) -> (Instant, bool) {
        let (finished, result) = self.finish_result().await;
        (finished, result.expect("watch failed"))
    }
}

#[track_caller]
fn assert_guard(root: &Value, locked: bool) {
    assert_eq!(root["inert"], locked, "root state: {root}");
    if locked {
        assert_eq!(root["opacity"], "0", "root state: {root}");
        assert_eq!(root["pointerEvents"], "none", "root state: {root}");
        assert_eq!(root["opacityPriority"], "important");
        assert_eq!(root["pointerPriority"], "important");
    } else {
        assert_ne!(
            root["opacity"], "0",
            "ordinary page must be visible: {root}"
        );
        assert_ne!(
            root["pointerEvents"], "none",
            "ordinary page must accept input: {root}"
        );
    }
}

#[track_caller]
fn assert_probe(probe: &Value, locked: bool) {
    assert_guard(&probe["root"], locked);
    for phase in ["capture", "target"] {
        for kind in ["click", "submit", "input", "paste"] {
            assert_eq!(
                probe["after"][phase][kind].as_u64().unwrap(),
                probe["before"][phase][kind].as_u64().unwrap() + u64::from(!locked),
                "{phase} {kind} leaked or was swallowed, locked={locked}: {probe}"
            );
            if locked {
                assert_eq!(
                    probe["canceled"][kind], true,
                    "{kind} default was not prevented"
                );
            }
        }
    }
}

fn assert_redirect_proof(state: &Value) {
    assert_guard(&state["loginProof"]["first"], true);
    assert_probe(&state["loginProof"]["probe"], true);
    assert_guard(&state["first"], false);
    assert_probe(&state["initialProbe"], false);
    assert_guard(&state["root"], false);
}

fn assert_restored(root: &Value, baseline: &Value) {
    for key in [
        "opacity",
        "pointerEvents",
        "inert",
        "inlineOpacity",
        "opacityPriority",
        "inlinePointer",
        "pointerPriority",
    ] {
        assert_eq!(root[key], baseline[key], "failed to restore {key}");
    }
}

async fn assert_stays_live(cdp: &mut TestCdp, session: &str, watch: &TestWatch) {
    let deadline = Instant::now() + LOGIN_SETTLE + Duration::from_millis(250);
    let mut poll = interval(POLL_INTERVAL);
    loop {
        poll.tick().await;
        watch.assert_running();
        assert_guard(&cdp.evaluate(session, "__fixture.sample()").await, false);
        watch.assert_running();
        if Instant::now() >= deadline {
            break;
        }
    }
}

// Observe the real collector's outbound commands through a loopback-only relay.
// A passing page test alone cannot prove that an eager collector never resumed a
// target before the watch installed its guard: that race could merely go our way.
struct TestCollector {
    task: JoinHandle<Result<(), crate::cdp::CdpError>>,
    relay: JoinHandle<()>,
    commands: Arc<Mutex<Vec<String>>>,
    reports: tokio::sync::mpsc::UnboundedReceiver<crate::cdp::PageReport>,
}

impl Drop for TestCollector {
    fn drop(&mut self) {
        self.task.abort();
        self.relay.abort();
    }
}

impl TestCollector {
    async fn start(endpoint: &DevToolsEndpoint) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_endpoint = DevToolsEndpoint {
            port: listener.local_addr().unwrap().port(),
            browser_path: endpoint.browser_path.clone(),
        };
        let actual = endpoint.clone();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let recorded = commands.clone();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let relay = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut downstream = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut upstream = connect(&actual).await.unwrap();
            let mut installs = HashSet::new();
            let mut ready = Some(ready_tx);
            loop {
                tokio::select! {
                    frame = downstream.next() => {
                        let Some(Ok(frame)) = frame else { break };
                        if let Message::Text(text) = &frame {
                            let command: Value = serde_json::from_str(text).unwrap();
                            if let Some(method) = command["method"].as_str() {
                                recorded.lock().unwrap().push(method.to_string());
                                if method == "Page.addScriptToEvaluateOnNewDocument" {
                                    installs.insert(command["id"].as_i64().unwrap());
                                }
                            }
                        }
                        if upstream.send(frame).await.is_err() { break; }
                    }
                    frame = upstream.next() => {
                        let Some(Ok(frame)) = frame else { break };
                        if let Message::Text(text) = &frame {
                            let reply: Value = serde_json::from_str(text).unwrap();
                            if reply["id"].as_i64().is_some_and(|id| installs.remove(&id)) {
                                assert!(reply.pointer("/result/identifier").and_then(Value::as_str).is_some(),
                                    "collector install failed: {reply}");
                                if let Some(ready) = ready.take() { let _ = ready.send(()); }
                            }
                        }
                        if downstream.send(frame).await.is_err() { break; }
                    }
                }
            }
        });
        let (sink, reports) = tokio::sync::mpsc::unbounded_channel();
        let collector = Self {
            task: tokio::spawn(crate::cdp::collect(relay_endpoint, sink, true)),
            relay,
            commands,
            reports,
        };
        timeout(POLL_TIMEOUT, ready_rx)
            .await
            .expect("collector did not install on the initial page")
            .expect("collector relay ended during startup");
        collector.assert_no_resume();
        collector
    }

    fn assert_no_resume(&self) {
        assert!(!self.task.is_finished(), "collector stopped unexpectedly");
        assert!(
            !self.relay.is_finished(),
            "collector relay stopped unexpectedly"
        );
        let commands = self.commands.lock().unwrap();
        assert!(commands.iter().any(|method| method == "Runtime.addBinding"));
        assert!(
            !commands
                .iter()
                .any(|method| method == "Runtime.runIfWaitingForDebugger"),
            "managed collector must never resume any target: {commands:?}"
        );
    }

    async fn wait_for_installs(&self, count: usize) {
        let deadline = Instant::now() + POLL_TIMEOUT;
        let mut poll = interval(POLL_INTERVAL);
        loop {
            poll.tick().await;
            self.assert_no_resume();
            let installed = self
                .commands
                .lock()
                .unwrap()
                .iter()
                .filter(|method| method.as_str() == "Page.addScriptToEvaluateOnNewDocument")
                .count();
            if installed >= count {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "collector installed only {installed}/{count} pages"
            );
        }
    }

    async fn wait_for_click(&mut self, url: &str) {
        timeout(POLL_TIMEOUT, async {
            loop {
                let report = self
                    .reports
                    .recv()
                    .await
                    .expect("collector report channel closed");
                if report.url == url && report.clicks > 0 {
                    break;
                }
            }
        })
        .await
        .expect("collector did not report ordinary-page activity");
        self.assert_no_resume();
    }
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; fresh headless browser and loopback fixture only"]
fn real_chromium_observes_immediate_redirect_and_same_document_logout() {
    with_real_chromium(async {
        let pages = TestPages::start().await;
        for path in ["/immediate", "/spa"] {
            let (_browser, endpoint) = launch_test_browser();
            let mut watch = TestWatch::start(&endpoint, pages.policy()).await;
            inject_session(&endpoint, &local_session(format!("{}{path}", pages.base)))
                .await
                .unwrap();
            assert!(watch.finish().await.1, "missing logout event for {path}");
            crate::cdp::request_exit(&endpoint).await.unwrap();
        }
        assert!(
            pages.cookie_seen.load(Ordering::Acquire),
            "cookie must be installed before the first navigation"
        );
    });
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; fresh headless browser and loopback fixture only"]
fn real_chromium_login_auto_redirect_remains_usable_past_settle() {
    with_real_chromium(async {
        let pages = TestPages::start().await;
        let (_browser, endpoint) = launch_test_browser();
        let watch = TestWatch::start(&endpoint, pages.policy()).await;
        let mut cdp = TestCdp::connect(&endpoint).await;
        let (_, session) = cdp.initial_page().await;
        inject_session(
            &endpoint,
            &local_session(format!("{}/login?case=auto&auto=1", pages.base)),
        )
        .await
        .unwrap();
        assert_redirect_proof(&cdp.ready(&session, "/workbench", "auto").await);
        cdp.click(&session, false).await;
        assert_stays_live(&mut cdp, &session, &watch).await;
        cdp.click(&session, false).await;
        crate::cdp::request_exit(&endpoint).await.unwrap();
    });
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; fresh headless browser and loopback fixture only"]
fn real_chromium_persistent_login_is_locked_until_settle_expiry() {
    with_real_chromium(async {
        let pages = TestPages::start().await;
        let (_browser, endpoint) = launch_test_browser();
        let mut watch = TestWatch::start(&endpoint, pages.policy()).await;
        let mut cdp = TestCdp::connect(&endpoint).await;
        // prepare_logout_watch completed this initial target's guard setup.
        // Navigate it only after that barrier; no test-side marker or resume is
        // allowed to make an unprepared direct-URL target appear protected.
        let (_, login) = cdp.initial_page().await;
        inject_session(
            &endpoint,
            &local_session(format!("{}/workbench?case=controlled", pages.base)),
        )
        .await
        .unwrap();
        cdp.ready(&login, "/workbench", "controlled").await;
        let target = cdp
            .create_pages(&[format!("{}/workbench?case=ordinary", pages.base)])
            .await
            .remove(0);
        let ordinary = cdp.attach(&target).await;
        cdp.ready(&ordinary, "/workbench", "ordinary").await;
        watch.assert_running();
        let started = Instant::now();
        let navigation = cdp
            .command(
                Some(&login),
                "Page.navigate",
                json!({"url": format!("{}/login?case=persistent", pages.base)}),
            )
            .await;
        assert!(
            navigation.get("errorText").is_none(),
            "login navigation failed: {navigation}"
        );
        let state = cdp.ready(&login, "/login", "persistent").await;
        assert_guard(&state["first"], true);
        assert_probe(&state["initialProbe"], true);
        cdp.click(&login, true).await;
        cdp.click(&ordinary, false).await;
        // An unrelated tab leaving/navigating must not clear this tab's timer.
        assert_probe(&cdp.evaluate(&ordinary,
            "history.replaceState({}, '', '/workbench?case=ordinary&changed=1'); __fixture.exercise()"
        ).await, false);
        let mut samples = 0;
        let mut poll = interval(POLL_INTERVAL);
        while !watch.task.is_finished() {
            poll.tick().await;
            assert_probe(&cdp.evaluate(&login, "__fixture.exercise()").await, true);
            samples += 1;
            assert!(
                started.elapsed() < LOGIN_SETTLE + POLL_TIMEOUT,
                "persistent login never expired"
            );
        }
        let (finished, expired) = watch.finish().await;
        assert!(
            expired,
            "socket disconnect must not masquerade as login expiry"
        );
        assert!(
            finished.duration_since(started) >= LOGIN_SETTLE,
            "login expired before its settle window"
        );
        assert!(
            samples > 1,
            "login must remain locked throughout the settle window"
        );
        assert_probe(&cdp.evaluate(&login, "__fixture.exercise()").await, true);
        crate::cdp::request_exit(&endpoint).await.unwrap();
    });
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; fresh headless browser and loopback fixture only"]
fn real_chromium_direct_url_login_fails_closed() {
    with_real_chromium(async {
        let pages = TestPages::start().await;
        let (_browser, endpoint) = launch_test_browser();
        let mut watch = TestWatch::start(&endpoint, pages.policy()).await;
        let mut cdp = TestCdp::connect(&endpoint).await;
        let (_, ordinary) = cdp.initial_page().await;
        inject_session(
            &endpoint,
            &local_session(format!("{}/workbench?case=direct-opener", pages.base)),
        )
        .await
        .unwrap();
        cdp.ready(&ordinary, "/workbench", "direct-opener").await;
        watch.assert_running();

        // Chrome can run a createTarget(url) first document before CDP pauses it.
        // The contract here is an immediate local guard fault for the owner to
        // close the browser, not a claim that this document was pre-locked and
        // not the four-second credential-expiry signal of an already-ready page.
        let started = Instant::now();
        cdp.create_pages(&[format!("{}/login?case=direct-login", pages.base)])
            .await;
        let (finished, result) = watch.finish_result().await;
        assert_eq!(
            result,
            Err(ManagedCdpError::Command("新登录页面尚未建立托管防护".into())),
            "unprepared direct login must report a local guard fault, never credential expiry or disconnection"
        );
        assert!(
            finished.duration_since(started) < LOGIN_SETTLE,
            "unprepared login must fail closed without waiting for login settle"
        );
        crate::cdp::request_exit(&endpoint).await.unwrap();
    });
}

async fn exercise_later_tabs_and_popup(with_collector: bool) {
    let pages = TestPages::start().await;
    let (_browser, endpoint) = launch_test_browser();
    let watch = TestWatch::start(&endpoint, pages.policy()).await;
    let mut collector = if with_collector {
        Some(TestCollector::start(&endpoint).await)
    } else {
        None
    };
    let mut cdp = TestCdp::connect(&endpoint).await;
    let (opener_target, opener) = cdp.initial_page().await;
    inject_session(
        &endpoint,
        &local_session(format!("{}/workbench?case=opener", pages.base)),
    )
    .await
    .unwrap();
    cdp.ready(&opener, "/workbench", "opener").await;
    let urls: Vec<_> = (0..6)
        .map(|index| pages.hop_url(&format!("tab-{index}"), index % 2 == 1))
        .collect();
    let targets = cdp.create_pages(&urls).await;
    assert_eq!(targets.iter().collect::<HashSet<_>>().len(), 6);
    for (index, target) in targets.iter().enumerate() {
        let session = cdp.attach(target).await;
        let case = format!("tab-{index}");
        assert_redirect_proof(&cdp.ready(&session, "/workbench", &case).await);
        pages.assert_hops(&case, index % 2 == 1);
        cdp.click(&session, false).await;
        watch.assert_running();
    }
    assert_eq!(
        cdp.evaluate(
            &opener,
            &format!(
                "Boolean(window.open({}, 'vestus-local-popup', 'popup,width=480,height=360'))",
                json!(pages.hop_url("popup", true)),
            )
        )
        .await,
        true,
        "window.open must create a real page target"
    );
    let deadline = Instant::now() + POLL_TIMEOUT;
    let mut poll = interval(POLL_INTERVAL);
    let popup_target = loop {
        poll.tick().await;
        let infos = cdp.targets().await;
        if let Some(info) = infos.iter().find(|info| {
            info["openerId"] == opener_target
                && info["targetId"] != opener_target
                && info["url"]
                    .as_str()
                    .is_some_and(|url| url.contains("case=popup"))
        }) {
            break info["targetId"].as_str().unwrap().to_string();
        }
        assert!(Instant::now() < deadline, "popup target missing: {infos:?}");
    };
    let popup = cdp.attach(&popup_target).await;
    assert_redirect_proof(&cdp.ready(&popup, "/workbench", "popup").await);
    pages.assert_hops("popup", true);
    cdp.click(&popup, false).await;
    assert!(
        cdp.targets().await.len() >= 8,
        "opener + six later tabs + popup must coexist"
    );
    if let Some(collector) = &mut collector {
        collector.wait_for_installs(8).await;
        cdp.click(&opener, false).await;
        // Flush the real collector via its normal pagehide listener, not a sleep
        // for its batching timer or a direct call to its private binding.
        cdp.evaluate(&opener, "dispatchEvent(new Event('pagehide')); true")
            .await;
        collector
            .wait_for_click(&format!("{}/workbench", pages.base))
            .await;
    }
    assert_stays_live(&mut cdp, &opener, &watch).await;
    if let Some(collector) = &collector {
        collector.assert_no_resume();
    }
    crate::cdp::request_exit(&endpoint).await.unwrap();
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; fresh headless browser and loopback fixture only"]
fn real_chromium_guards_later_tabs_and_popup_across_loopback_origins() {
    with_real_chromium(exercise_later_tabs_and_popup(false));
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; fresh headless browser and loopback fixture only"]
fn real_chromium_guard_and_collector_coexist_without_collector_resuming_targets() {
    with_real_chromium(exercise_later_tabs_and_popup(true));
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; fresh headless browser and loopback fixture only"]
fn real_chromium_spa_locks_synchronously_but_ignores_other_origins_and_frames() {
    with_real_chromium(async {
        let pages = TestPages::start().await;
        let (_browser, endpoint) = launch_test_browser();
        let watch = TestWatch::start(&endpoint, pages.policy()).await;
        let mut cdp = TestCdp::connect(&endpoint).await;
        let (_, session) = cdp.initial_page().await;
        inject_session(
            &endpoint,
            &local_session(format!("{}/workbench?case=spa", pages.base)),
        )
        .await
        .unwrap();
        cdp.ready(&session, "/workbench", "spa").await;
        let baseline = cdp.evaluate(&session,
            "document.documentElement.style.setProperty('opacity', '0.75', 'important'); document.documentElement.style.setProperty('pointer-events', 'auto', 'important'); __fixture.sample()"
        ).await;
        // Each expression samples and dispatches events in the SAME JS turn as
        // the history call: polling for an eventual MutationObserver is not enough.
        for expression in [
            "history.pushState({}, '', '/login?case=spa'); __fixture.exercise()",
            "history.replaceState({}, '', '/login/challenge?case=spa'); __fixture.exercise()",
        ] {
            assert_probe(&cdp.evaluate(&session, expression).await, true);
        }
        let restored = cdp
            .evaluate(
                &session,
                "history.replaceState({}, '', '/workbench?case=spa'); __fixture.exercise()",
            )
            .await;
        assert_probe(&restored, false);
        assert_restored(&restored["root"], &baseline);
        assert_probe(
            &cdp.evaluate(
                &session,
                "history.replaceState({}, '', '/login?case=spa-replace'); __fixture.exercise()",
            )
            .await,
            true,
        );
        let restored = cdp
            .evaluate(
                &session,
                "history.pushState({}, '', '/workbench?case=spa-replace'); __fixture.exercise()",
            )
            .await;
        assert_probe(&restored, false);
        assert_restored(&restored["root"], &baseline);
        for path in ["/login-help", "/login2", "/workbench?next=/login"] {
            let probe = cdp
                .evaluate(
                    &session,
                    &format!(
                        "history.pushState({{}}, '', {}); __fixture.exercise()",
                        json!(path),
                    ),
                )
                .await;
            assert_probe(&probe, false);
            assert_restored(&probe["root"], &baseline);
        }
        assert_probe(
            &cdp.evaluate(
                &session,
                "history.pushState({}, '', '/login/step?case=history'); __fixture.exercise()",
            )
            .await,
            true,
        );
        assert_probe(
            &cdp.evaluate(
                &session,
                "history.pushState({}, '', '/workbench?case=history'); __fixture.exercise()",
            )
            .await,
            false,
        );
        cdp.evaluate(&session, "history.back(); true").await;
        let back = cdp
            .wait_for(
                &session,
                "__fixture.historyProbes.length === 1 && __fixture.historyProbes[0]",
            )
            .await;
        assert_eq!(back["root"]["path"], "/login/step");
        assert_probe(&back, true); // sampled inside the app's own popstate listener
        cdp.evaluate(&session, "history.forward(); true").await;
        let forward = cdp
            .wait_for(
                &session,
                "__fixture.historyProbes.length === 2 && __fixture.historyProbes[1]",
            )
            .await;
        assert_eq!(forward["root"]["path"], "/workbench");
        assert_probe(&forward, false);
        assert_restored(&forward["root"], &baseline);
        cdp.click(&session, false).await;

        cdp.evaluate(&session,
            "(() => { const frame = document.createElement('iframe'); frame.id = 'local-frame'; frame.src = '/login?case=iframe'; document.body.append(frame); const worker = new Worker('/worker.js'); worker.onmessage = event => { __fixture.workerReply = event.data; worker.terminate(); }; worker.postMessage('local-only'); return true; })()"
        ).await;
        let frame = cdp.wait_for(&session,
            "document.getElementById('local-frame').contentWindow.__fixture?.ready && document.getElementById('local-frame').contentWindow.__fixture.snapshot()"
        ).await;
        assert_guard(&frame["first"], false);
        assert_probe(&frame["initialProbe"], false);
        assert_eq!(
            cdp.wait_for(&session, "__fixture.workerReply || null")
                .await,
            "local-worker-ready"
        );
        let foreign_target = cdp
            .create_pages(&[format!("{}/login?case=other-origin", pages.product)])
            .await
            .remove(0);
        let foreign = cdp.attach(&foreign_target).await;
        let state = cdp.ready(&foreign, "/login", "other-origin").await;
        assert_guard(&state["first"], false);
        assert_probe(&state["initialProbe"], false);
        cdp.click(&foreign, false).await;
        // Leave both the child frame and the other-port top-level page on login
        // for a full settle window. Neither may expire the managed main page.
        assert_stays_live(&mut cdp, &session, &watch).await;
        assert_restored(
            &cdp.evaluate(&session, "__fixture.sample()").await,
            &baseline,
        );
        crate::cdp::request_exit(&endpoint).await.unwrap();
    });
}
