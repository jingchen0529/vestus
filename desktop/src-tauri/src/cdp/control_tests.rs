//! Control acceptance uses only a loopback page and a fresh temporary profile.
use super::*;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{timeout_at, Instant as TokioInstant};

const READY_TIMEOUT: Duration = Duration::from_secs(30);

async fn readiness_attempt(endpoint: &DevToolsEndpoint, url: &str) -> Result<bool, CdpError> {
    let started = Instant::now();
    eprintln!("CDP readiness phase: Browser.getVersion (connect/handshake/reply)");
    let version = control_command(endpoint, "Browser.getVersion", json!({})).await?;
    if version.get("product").and_then(Value::as_str).is_none() {
        return Err(CdpError::Command(
            "Browser.getVersion returned no product".into(),
        ));
    }
    eprintln!(
        "CDP version response after {:?}: {version}",
        started.elapsed()
    );
    let started = Instant::now();
    eprintln!("CDP readiness phase: Target.getTargets (connect/handshake/reply)");
    let targets = page_targets(endpoint).await?;
    eprintln!(
        "CDP target response after {:?}: {targets:?}",
        started.elapsed()
    );
    Ok(targets.iter().any(|(_, target)| target == url))
}

async fn wait_until_ready(
    endpoint: &DevToolsEndpoint,
    url: &str,
    budget: Duration,
) -> Result<(), CdpError> {
    let deadline = TokioInstant::now() + budget;
    let started = Instant::now();
    loop {
        let result = timeout_at(deadline, readiness_attempt(endpoint, url)).await;
        match result {
            Ok(Ok(true)) => {
                eprintln!(
                    "CDP readiness: version and target ready after {:?}",
                    started.elapsed()
                );
                return Ok(());
            }
            Ok(Ok(false)) => eprintln!("CDP readiness: waiting for local page target"),
            Ok(Err(error)) => eprintln!(
                "CDP readiness attempt after {:?}: {error:?}",
                started.elapsed()
            ),
            Err(_) => return Err(CdpError::Timeout),
        }
        if TokioInstant::now() >= deadline {
            return Err(CdpError::Timeout);
        }
        tokio::time::sleep_until((TokioInstant::now() + Duration::from_millis(50)).min(deadline))
            .await;
    }
}

async fn protocol_fixture(
    delayed_first_connection: bool,
) -> (DevToolsEndpoint, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let mut first = true;
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let delay = delayed_first_connection && first;
            first = false;
            tokio::spawn(async move {
                if delay {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    return;
                }
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let Some(Ok(Message::Text(text))) = socket.next().await else {
                    return;
                };
                let request: Value = serde_json::from_str(&text).unwrap();
                let result = if request["method"] == "Browser.getVersion" {
                    json!({"product": "Fixture/1"})
                } else if request["method"] == "Target.getTargets" {
                    json!({"targetInfos": [{"targetId": "local", "type": "page", "url": "http://127.0.0.1/"}]})
                } else {
                    json!({})
                };
                // The real exchange must ignore events and unrelated command replies.
                for response in [
                    json!({"method": "Target.targetCreated", "params": {}}),
                    json!({"id": 999, "result": {}}),
                    json!({"id": request["id"], "result": result}),
                ] {
                    if socket
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    };
                }
            });
        }
    });
    (
        DevToolsEndpoint {
            port,
            browser_path: "/devtools/browser/fixture".into(),
        },
        server,
    )
}

#[tokio::test]
async fn control_exchange_ignores_events_and_unrelated_replies() {
    let (endpoint, server) = protocol_fixture(false).await;
    let result = page_targets(&endpoint).await;
    server.abort();
    assert_eq!(
        result.unwrap(),
        vec![("local".into(), "http://127.0.0.1/".into())]
    );
}

#[tokio::test]
async fn readiness_requires_a_responsive_cdp_connection_not_a_listening_port() {
    let (endpoint, server) = protocol_fixture(true).await;
    let result = wait_until_ready(&endpoint, "http://127.0.0.1/", Duration::from_secs(2)).await;
    server.abort();
    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn readiness_never_passes_for_a_missing_target() {
    let (endpoint, server) = protocol_fixture(false).await;
    let result = wait_until_ready(
        &endpoint,
        "http://127.0.0.1/missing",
        Duration::from_millis(150),
    )
    .await;
    server.abort();
    assert_eq!(result, Err(CdpError::Timeout));
}

#[tokio::test]
async fn an_endpoint_that_never_completes_the_handshake_still_times_out() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = DevToolsEndpoint {
        port: listener.local_addr().unwrap().port(),
        browser_path: "/devtools/browser/stalled".into(),
    };
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(stream);
    });
    let started = Instant::now();
    let result = wait_until_ready(&endpoint, "http://127.0.0.1/", Duration::from_millis(150)).await;
    server.abort();
    assert_eq!(result, Err(CdpError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn production_control_deadline_still_rejects_a_stalled_handshake() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = DevToolsEndpoint {
        port: listener.local_addr().unwrap().port(),
        browser_path: "/devtools/browser/stalled".into(),
    };
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(stream);
    });
    let started = Instant::now();
    let result = open_or_activate_page(&endpoint, "http://127.0.0.1/").await;
    server.abort();
    assert_eq!(result, Err(CdpError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(5));
}

struct Fixture {
    root: PathBuf,
    url: String,
    stderr: File,
    process: Option<crate::browser::TestBrowserProcess>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let cleaned = self
            .process
            .as_mut()
            .is_none_or(|process| match process.terminate() {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("Control fixture process cleanup failed: {error}");
                    false
                }
            });
        self.server.abort();
        if std::thread::panicking() {
            if let Ok(mut log) = File::open(self.root.join("chromium.log")) {
                let size = log.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                let _ = log.seek(SeekFrom::Start(size.saturating_sub(16 * 1024)));
                let mut text = String::new();
                let _ = log.read_to_string(&mut text);
                eprintln!("Isolated Chromium log (last 16 KiB):\n{text}");
            }
        }
        if cleaned {
            if let Err(error) = std::fs::remove_dir_all(&self.root) {
                eprintln!("Control fixture directory cleanup failed: {error}");
            }
        } else {
            eprintln!("Control fixture profile retained because process cleanup was not verified");
        }
    }
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "vestus-control-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let stderr = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(root.join("chromium.log"))
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        );
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut request = [0; 8192];
                    let Ok(Ok(_)) =
                        timeout(Duration::from_secs(5), stream.read(&mut request)).await
                    else {
                        return;
                    };
                    let body = r#"<!doctype html><title>Vestus local collector fixture</title>
                        <form><input id="input" name="quantity"><input id="checkbox" type="checkbox"><button type="submit">submit</button></form>
                        <iframe id="child" src="/frame"></iframe><div style="height:5000px">Local only</div>
                        <script>
                        window.fixtureSeen = {input:0,change:0,click:0,submit:0};
                        for (const kind of Object.keys(fixtureSeen)) document.addEventListener(kind, event => {
                          fixtureSeen[kind]++; if (kind === 'submit') event.preventDefault();
                        });
                        </script>"#;
                    let body = if String::from_utf8_lossy(&request).starts_with("GET /frame ") {
                        "<!doctype html><title>Local child</title><p>iframe</p>"
                    } else {
                        body
                    };
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            root,
            url,
            stderr,
            process: None,
            server,
        }
    }

    async fn launch(&mut self, executable: &std::path::Path, url: &str) -> DevToolsEndpoint {
        self.launch_with_mode(executable, url, false).await
    }

    async fn launch_with_mode(
        &mut self,
        executable: &std::path::Path,
        url: &str,
        headless: bool,
    ) -> DevToolsEndpoint {
        crate::browser::prepare_test_sandbox_access(executable)
            .expect("prepare bundled Chromium sandbox permissions before launch");
        let mut command = Command::new(executable);
        if headless {
            // Collection acceptance must not steal focus or lose its tab to
            // incidental desktop interaction during the 61-second idle check.
            command.arg("--headless=new");
        }
        command
            .arg(format!("--user-data-dir={}", self.root.display()))
            .args([
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-background-mode",
                "--disable-breakpad",
                "--disable-infobars",
                "--disable-quic",
                "--password-store=basic",
                "--use-mock-keychain",
            ])
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(self.stderr.try_clone().unwrap());
        if let Some(directory) = executable.parent() {
            command.current_dir(directory);
        }
        self.process = Some(
            crate::browser::TestBrowserProcess::spawn(&mut command)
                .expect("launch isolated bundled Chromium"),
        );
        eprintln!(
            "Control browser: executable={executable:?}; arch={}; pid={}",
            std::env::consts::ARCH,
            self.process.as_ref().unwrap().id()
        );
        let started = Instant::now();
        let deadline = TokioInstant::now() + READY_TIMEOUT;
        loop {
            assert!(
                !self
                    .process
                    .as_ref()
                    .unwrap()
                    .has_exited()
                    .expect("inspect owned browser"),
                "Chromium exited before endpoint readiness"
            );
            if let Ok(text) = std::fs::read_to_string(self.root.join("DevToolsActivePort")) {
                if let Some(endpoint) = crate::browser::parse_devtools_active_port(&text) {
                    eprintln!(
                        "Port file appeared after {:?}; probing CDP readiness",
                        started.elapsed()
                    );
                    let budget = deadline.saturating_duration_since(TokioInstant::now());
                    wait_until_ready(&endpoint, url, budget)
                        .await
                        .expect("version/target readiness within startup deadline");
                    return endpoint;
                }
            }
            assert!(
                TokioInstant::now() < deadline,
                "Chromium endpoint startup timeout"
            );
            tokio::time::sleep_until(
                (TokioInstant::now() + Duration::from_millis(50)).min(deadline),
            )
            .await;
        }
    }
}

async fn test_page_command(
    endpoint: &DevToolsEndpoint,
    target: &str,
    method: &str,
    params: Value,
) -> Value {
    let mut socket = connect(endpoint).await.unwrap();
    socket
        .send(Message::Text(
            json!({"id":1,"method":"Target.attachToTarget","params":{
                "targetId":target,"flatten":true
            }})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let session = loop {
        let Some(Ok(Message::Text(text))) = socket.next().await else {
            panic!("attach reply missing")
        };
        let reply: Value = serde_json::from_str(&text).unwrap();
        if reply["id"] == 1 {
            assert!(reply.get("error").is_none(), "test attach failed: {reply}");
            break reply["result"]["sessionId"].as_str().unwrap().to_string();
        }
    };
    socket
        .send(Message::Text(
            json!({"id":2,"sessionId":session,"method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let result = loop {
        let Some(Ok(Message::Text(text))) = socket.next().await else {
            panic!("page reply missing")
        };
        let reply: Value = serde_json::from_str(&text).unwrap();
        if reply["id"] == 2 {
            assert!(reply.get("error").is_none(), "test command failed: {reply}");
            break reply["result"].clone();
        }
    };
    let _ = socket.close(None).await;
    result
}

async fn test_evaluate(endpoint: &DevToolsEndpoint, target: &str, expression: &str) -> Value {
    let result = timeout(Duration::from_secs(5), test_page_command(endpoint, target, "Runtime.evaluate",
        json!({"expression":expression,"returnByValue":true,"awaitPromise":true,"userGesture":true})))
        .await.expect("local test evaluation deadline");
    assert!(
        result.get("exceptionDetails").is_none(),
        "local test script failed: {result}"
    );
    result["result"]["value"].clone()
}

fn material_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} for the material regression"))
}

async fn material_endpoint(profile: &std::path::Path) -> DevToolsEndpoint {
    let port_file = profile.join(crate::profile::DEVTOOLS_PORT_FILE);
    let deadline = TokioInstant::now() + Duration::from_secs(10);
    loop {
        if let Ok(contents) = std::fs::read_to_string(&port_file) {
            if let Some(endpoint) = crate::browser::parse_devtools_active_port(&contents) {
                if control_command(&endpoint, "Browser.getVersion", json!({}))
                    .await
                    .is_ok()
                {
                    return endpoint;
                }
            }
        }
        assert!(
            TokioInstant::now() < deadline,
            "material browser CDP endpoint timeout"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn material_target(endpoint: &DevToolsEndpoint, url_prefix: &str) -> String {
    let targets = page_targets(endpoint)
        .await
        .expect("list material page targets");
    let target_id = std::env::var("VESTUS_MATERIAL_TARGET_ID").ok();
    targets
        .into_iter()
        .find(|(id, url)| {
            target_id.as_deref().is_some_and(|expected| expected == id)
                || (target_id.is_none() && url.starts_with(url_prefix))
        })
        .map(|(id, _)| id)
        .unwrap_or_else(|| panic!("no material page target matched the configured profile"))
}

fn material_selector_literal(selector: &str) -> String {
    serde_json::to_string(selector).expect("serialize material selector")
}

async fn material_click(endpoint: &DevToolsEndpoint, target: &str, selector: &str) {
    let expression = format!(
        "(() => {{ const element = document.querySelector({}); if (!element) return null; const rect = element.getBoundingClientRect(); return {{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height }}; }})()",
        material_selector_literal(selector)
    );
    let rect = test_evaluate(endpoint, target, &expression).await;
    let x = rect["x"].as_f64().filter(|value| value.is_finite());
    let y = rect["y"].as_f64().filter(|value| value.is_finite());
    assert!(
        x.zip(y).is_some_and(|(x, y)| x >= 0.0
            && y >= 0.0
            && rect["width"].as_f64().unwrap_or(0.0) > 0.0
            && rect["height"].as_f64().unwrap_or(0.0) > 0.0),
        "material selector is missing or not visible"
    );
    let (x, y) = (x.unwrap(), y.unwrap());
    for (event_type, buttons) in [("mousePressed", 1), ("mouseReleased", 0)] {
        test_page_command(
            endpoint,
            target,
            "Input.dispatchMouseEvent",
            json!({
                "type": event_type,
                "x": x,
                "y": y,
                "button": "left",
                "buttons": buttons,
                "clickCount": 1,
            }),
        )
        .await;
    }
}

async fn material_sample(endpoint: &DevToolsEndpoint, target: &str, round: usize) -> Value {
    test_page_command(endpoint, target, "HeapProfiler.collectGarbage", json!({})).await;
    test_page_command(endpoint, target, "HeapProfiler.collectGarbage", json!({})).await;
    let heap = test_page_command(endpoint, target, "Runtime.getHeapUsage", json!({})).await;
    let dom = test_page_command(endpoint, target, "Memory.getDOMCounters", json!({})).await;
    let metrics = test_page_command(endpoint, target, "Performance.getMetrics", json!({})).await;
    let page = test_evaluate(
        endpoint,
        target,
        "({elements:document.getElementsByTagName('*').length,videos:document.querySelectorAll('video').length,readyState:document.readyState})",
    )
    .await;
    let metric = |name: &str| {
        metrics["metrics"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["name"] == name))
            .and_then(|item| item["value"].as_f64())
    };
    json!({
        "round": round,
        "heapUsedSize": heap["usedSize"],
        "heapTotalSize": heap["totalSize"],
        "domNodes": dom["nodes"],
        "domDocuments": dom["documents"],
        "domEventListeners": dom["jsEventListeners"],
        "performanceNodes": metric("Nodes"),
        "performanceEventListeners": metric("JSEventListeners"),
        "elements": page["elements"],
        "videos": page["videos"],
        "readyState": page["readyState"],
    })
}

fn assert_url_only(report: &PageReport) {
    assert_eq!(report.visits, 1);
    assert_eq!(
        (
            report.clicks,
            report.inputs,
            report.submits,
            report.scrolls,
            report.dwell_ms
        ),
        (0, 0, 0, 0, 0)
    );
    assert!(report.input_snapshot.is_none() && report.submit_snapshot.is_none());
    assert_eq!(
        (report.input_snapshot_at_ms, report.submit_snapshot_at_ms),
        (0, 0)
    );
}

async fn expected_report(
    reports: &mut tokio::sync::mpsc::UnboundedReceiver<PageReport>,
    url: &str,
    params: Option<&str>,
) {
    let report = timeout(Duration::from_secs(10), reports.recv())
        .await
        .unwrap()
        .unwrap();
    assert_url_only(&report);
    assert_eq!(report.url, url);
    assert_eq!(report.url_params.as_deref(), params);
    eprintln!("URL-only report verified: {report:?}");
}

async fn no_reports(
    reports: &mut tokio::sync::mpsc::UnboundedReceiver<PageReport>,
    budget: Duration,
    phase: &str,
) {
    assert!(
        timeout(budget, reports.recv()).await.is_err(),
        "unexpected report during {phase}"
    );
    eprintln!("Zero reports verified during {phase} ({budget:?})");
}

async fn close_fixture(fixture: &mut Fixture, endpoint: &DevToolsEndpoint) {
    assert_eq!(request_exit(endpoint).await, Ok(()));
    let deadline = TokioInstant::now() + Duration::from_secs(10);
    while !fixture.process.as_ref().unwrap().has_exited().unwrap() {
        assert!(
            TokioInstant::now() < deadline,
            "browser did not shut down cleanly"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    fixture
        .process
        .as_mut()
        .unwrap()
        .terminate()
        .expect("verify owned process tree shutdown");
    eprintln!("Browser.close completed; isolated process tree verified stopped");
}

/// Real production collect stream: the driver connection never subscribes to
/// Runtime and only controls synthetic loopback pages in a new private profile.
#[test]
#[ignore = "requires bundled VESTUS_CONTROL_CHROMIUM; opens isolated real browser windows"]
fn url_only_collection_and_managed_guard_against_a_real_browser() {
    let executable = PathBuf::from(
        std::env::var_os("VESTUS_CONTROL_CHROMIUM").expect("bundled Chromium required"),
    );
    assert!(executable.is_absolute() && executable.is_file());
    crate::rt::runtime().block_on(async {
        let mut fixture = Fixture::new().await;
        let base = fixture.url.clone();
        let initial = format!("{base}first?advid=42&token=fixture#top");
        let endpoint = fixture.launch_with_mode(&executable, &initial, true).await;
        let target = page_targets(&endpoint).await.unwrap()[0].0.clone();
        assert_eq!(test_evaluate(&endpoint, &target, "new Promise(resolve => document.readyState === 'complete' ? resolve(true) : addEventListener('load', () => resolve(true), {once:true}))").await, true);
        let (sink, mut reports) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(collect(endpoint.clone(), sink, None));
        expected_report(&mut reports, &format!("{base}first"), Some("advid=42&token=%5BREDACTED%5D")).await;
        no_reports(&mut reports, Duration::from_millis(200), "initial duplicate seed").await;
        assert_eq!(test_evaluate(&endpoint, &target,
            "({binding:typeof window.__vestusReportActivity,guard:Object.hasOwn(window,'__vestusManagedLoginGuard')})").await,
            json!({"binding":"undefined","guard":false}));
        let ordinary = test_evaluate(&endpoint, &target, "(() => {
            input.value='2'; input.dispatchEvent(new InputEvent('input',{bubbles:true,cancelable:true}));
            checkbox.click(); checkbox.dispatchEvent(new Event('change',{bubbles:true,cancelable:true}));
            document.querySelector('form').requestSubmit(); window.scrollTo(0,1500);
            return {checked:checkbox.checked, inputSeen:fixtureSeen.input, changeSeen:fixtureSeen.change, submitSeen:fixtureSeen.submit,scrollY};
        })()").await;
        assert_eq!(ordinary["checked"], true);
        assert_eq!(ordinary["inputSeen"], 2, "text input plus native checkbox input");
        assert!(ordinary["changeSeen"].as_u64().unwrap() >= 1);
        assert_eq!(ordinary["submitSeen"], 1);
        assert!(ordinary["scrollY"].as_i64().unwrap() > 0);
        no_reports(&mut reports, Duration::from_secs(61), "checkbox/input/submit/scroll and idle beyond legacy heartbeat").await;

        test_page_command(&endpoint, &target, "Page.navigate", json!({"url":format!("{base}regular?advid=43")})).await;
        expected_report(&mut reports, &format!("{base}regular"), Some("advid=43")).await;
        test_evaluate(&endpoint, &target, "history.pushState({},'', '/spa?advid=44'); true").await;
        expected_report(&mut reports, &format!("{base}spa"), Some("advid=44")).await;
        test_evaluate(&endpoint, &target, "child.contentWindow.history.pushState({},'', '/iframe-spa'); child.src='/iframe-nav'; true").await;
        no_reports(&mut reports, Duration::from_millis(400), "iframe SPA and full navigation").await;
        test_evaluate(&endpoint, &target, "window.open('/popup?advid=45','fixture-popup','width=400,height=300'); true").await;
        expected_report(&mut reports, &format!("{base}popup"), Some("advid=45")).await;
        control_command(&endpoint, "Target.createTarget", json!({"url":format!("{base}new-tab?advid=46")})).await.unwrap();
        expected_report(&mut reports, &format!("{base}new-tab"), Some("advid=46")).await;
        test_page_command(&endpoint, &target, "Page.navigate", json!({"url":format!("{base}login")})).await;
        expected_report(&mut reports, &format!("{base}login"), None).await;
        assert_eq!(test_evaluate(&endpoint, &target, "({inert:document.documentElement.inert,guard:Object.hasOwn(window,'__vestusManagedLoginGuard'),binding:typeof window.__vestusReportActivity})").await,
            json!({"inert":false,"guard":false,"binding":"undefined"}));
        no_reports(&mut reports, Duration::from_millis(200), "ordinary login and popup/new tab duplicates").await;
        close_fixture(&mut fixture, &endpoint).await;
        let result = timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
        assert!(matches!(result, Ok(()) | Err(CdpError::Transport(_))), "collector stopped after verified browser exit: {result:?}");
        eprintln!("Collector exit after Browser.close: {result:?}");

        let mut fixture = Fixture::new().await;
        let base = fixture.url.clone();
        let endpoint = fixture.launch_with_mode(&executable, "about:blank", true).await;
        let target = page_targets(&endpoint).await.unwrap()[0].0.clone();
        let (signals, mut signal_rx) = tokio::sync::mpsc::unbounded_channel();
        let watch = crate::managed_cdp::localhost_test_watch(&base, signals);
        let (sink, mut reports) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(collect(endpoint.clone(), sink, Some(watch)));
        // about:blank itself never reports. Wait until the collecting session has
        // attached before navigating the first real document.
        let mut ready = false;
        for _ in 0..100 {
            let targets = control_command(&endpoint,"Target.getTargets",json!({})).await.unwrap();
            ready = targets["targetInfos"].as_array().unwrap().iter().any(|t| t["targetId"] == target && t["attached"] == true);
            if ready { break }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(ready, "collector attached to isolated blank target");
        tokio::time::sleep(Duration::from_millis(100)).await;
        test_page_command(&endpoint, &target, "Page.navigate", json!({"url":format!("{base}workbench?advid=51")})).await;
        expected_report(&mut reports, &format!("{base}workbench"), Some("advid=51")).await;
        assert_eq!(test_evaluate(&endpoint, &target, "({guard:Object.hasOwn(window,'__vestusManagedLoginGuard'),inert:document.documentElement.inert,binding:typeof window.__vestusReportActivity})").await,
            json!({"guard":true,"inert":false,"binding":"undefined"}));
        test_evaluate(&endpoint, &target, "window.open('/popup?advid=52','managed-popup','width=400,height=300'); true").await;
        expected_report(&mut reports, &format!("{base}popup"), Some("advid=52")).await;
        // Keep login, blocked interactions and self-healing in one renderer task.
        // Separate CDP connections must not consume the four-second login budget.
        let mut healed = test_evaluate(&endpoint, &target, "(() => {
            const started=performance.now();
            history.pushState({},'', '/login');
            const locked={inert:document.documentElement.inert,opacity:document.documentElement.style.opacity};
            const i=new InputEvent('input',{bubbles:true,cancelable:true});document.getElementById('input').dispatchEvent(i);
            const c=new Event('change',{bubbles:true,cancelable:true});document.getElementById('checkbox').dispatchEvent(c);
            document.querySelector('form').requestSubmit();
            history.replaceState({},'', '/workbench');
            return {locked,inert:document.documentElement.inert,opacity:document.documentElement.style.opacity,
                inputBlocked:i.defaultPrevented,changeBlocked:c.defaultPrevented,seen:fixtureSeen,binding:typeof window.__vestusReportActivity,
                route:location.pathname,elapsedMs:performance.now()-started};
        })()").await;
        let elapsed_ms = healed.as_object_mut().unwrap().remove("elapsedMs").unwrap().as_f64().unwrap();
        assert!(elapsed_ms < crate::managed_cdp::LOGIN_SETTLE.as_secs_f64() * 1000.0,
            "test self-healing exceeded the production login window: {elapsed_ms}ms");
        assert_eq!(healed, json!({"locked":{"inert":true,"opacity":"0"},"inert":false,"opacity":"","inputBlocked":true,"changeBlocked":true,
            "seen":{"input":0,"change":0,"click":0,"submit":0},"binding":"undefined","route":"/workbench"}));
        expected_report(&mut reports, &format!("{base}login"), None).await;
        expected_report(&mut reports, &format!("{base}workbench"), None).await;
        let cancellation = timeout(crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(200), signal_rx.recv()).await;
        assert!(cancellation.is_err(), "self-healed login must stay active past its original deadline: {cancellation:?}; collector_finished={}", task.is_finished());
        eprintln!("Self-healed login verified in {elapsed_ms:.3}ms; no expiry across the full login window");
        test_page_command(&endpoint, &target, "Page.navigate", json!({"url":format!("{base}login")})).await;
        expected_report(&mut reports, &format!("{base}login"), None).await;
        assert!(matches!(timeout(crate::managed_cdp::LOGIN_SETTLE + Duration::from_secs(1), signal_rx.recv()).await,
            Ok(Some(ManagedSignal::Expired))), "quiet real login expires without Runtime subscription");
        no_reports(&mut reports, Duration::from_millis(200), "managed guard interactions and quiet login").await;
        assert!(timeout(Duration::from_millis(100), signal_rx.recv()).await.is_err(), "one-shot Expired");
        close_fixture(&mut fixture, &endpoint).await;
        let result = timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
        assert!(matches!(result, Ok(()) | Err(CdpError::Transport(_))), "collector stopped after verified browser exit: {result:?}");
        eprintln!("Collector exit after Browser.close: {result:?}");
        assert!(matches!(signal_rx.recv().await, Some(ManagedSignal::ConnectionLost)));
        assert!(signal_rx.recv().await.is_none());
        eprintln!("Real URL-only and managed-guard acceptance completed");
    });
}

/// Explicit acceptance gate: never silently passes because system Chrome is absent.
#[test]
#[ignore = "requires bundled VESTUS_CONTROL_CHROMIUM; opens isolated real browser windows"]
fn target_commands_work_against_a_real_browser() {
    let executable = PathBuf::from(
        std::env::var_os("VESTUS_CONTROL_CHROMIUM")
            .expect("set VESTUS_CONTROL_CHROMIUM to bundled executable"),
    );
    assert!(
        executable.is_absolute() && executable.is_file(),
        "Chromium must be an existing absolute file"
    );
    crate::rt::runtime().block_on(async {
        let mut fixture = Fixture::new().await;
        let url = fixture.url.clone();
        let endpoint = fixture.launch(&executable, &url).await;
        // No retries around these acceptance assertions; the production deadline stays 3s.
        let started = Instant::now();
        let first = open_or_activate_page(&endpoint, &url).await;
        eprintln!(
            "Initial activation: {first:?}, elapsed={:?}",
            started.elapsed()
        );
        assert_eq!(
            first,
            Ok(PageOutcome::Activated),
            "existing local page must activate"
        );
        assert_eq!(
            open_or_activate_page(&endpoint, "http://other.example.invalid/").await,
            Err(CdpError::NoMatchingPage),
            "no new page for unmatched host"
        );
        assert_eq!(
            open_or_activate_page(&endpoint, &format!("{url}other/path")).await,
            Ok(PageOutcome::Activated),
            "same host reuses existing tab"
        );
        let targets = page_targets(&endpoint).await.unwrap();
        assert_eq!(
            targets.len(),
            1,
            "activation must not create extra pages: {targets:?}"
        );
        fixture
            .process
            .as_mut()
            .unwrap()
            .terminate()
            .expect("verified owned tree cleanup");
        eprintln!("Control browser process tree terminated successfully");
    });
}

/// Run the real material pagination sequence against one already-authenticated
/// VESTUS browser. The browser is intentionally owned by the caller so the A/B
/// launch variant and the proxy/profile remain exactly the ones being tested.
#[test]
#[ignore = "requires VESTUS_MATERIAL_PROFILE, selectors and a running VESTUS browser"]
fn material_selection_30_flip_regression() {
    let profile = PathBuf::from(material_env("VESTUS_MATERIAL_PROFILE"));
    assert!(
        profile.is_dir(),
        "material profile directory does not exist"
    );
    let url_prefix = material_env("VESTUS_MATERIAL_URL");
    let next_selector = material_env("VESTUS_MATERIAL_NEXT_SELECTOR");
    let previous_selector = material_env("VESTUS_MATERIAL_PREV_SELECTOR");
    let variant = material_env("VESTUS_MATERIAL_VARIANT");
    assert!(
        matches!(variant.as_str(), "A" | "B"),
        "material variant must be A or B"
    );
    let result_path = PathBuf::from(material_env("VESTUS_MATERIAL_RESULT"));
    let settle_ms = std::env::var("VESTUS_MATERIAL_SETTLE_MS")
        .ok()
        .map(|value| {
            value
                .parse::<u64>()
                .expect("material settle time must be an integer")
        })
        .unwrap_or(1_000);
    let open_selector = std::env::var("VESTUS_MATERIAL_OPEN_SELECTOR").ok();

    crate::rt::runtime().block_on(async {
        let endpoint = material_endpoint(&profile).await;
        let version = control_command(&endpoint, "Browser.getVersion", json!({}))
            .await
            .expect("read material browser version");
        assert!(
            version["product"].as_str().is_some(),
            "material browser did not return a product"
        );
        let target = material_target(&endpoint, &url_prefix).await;
        test_page_command(&endpoint, &target, "Performance.enable", json!({})).await;

        if let Some(selector) = open_selector.as_deref() {
            material_click(&endpoint, &target, selector).await;
            tokio::time::sleep(Duration::from_millis(settle_ms)).await;
        }

        let baseline = material_sample(&endpoint, &target, 0).await;
        let mut samples = vec![baseline];
        for round in 1..=30 {
            let started = Instant::now();
            material_click(&endpoint, &target, &next_selector).await;
            tokio::time::sleep(Duration::from_millis(settle_ms)).await;
            material_click(&endpoint, &target, &previous_selector).await;
            tokio::time::sleep(Duration::from_millis(settle_ms)).await;
            assert_eq!(
                test_evaluate(&endpoint, &target, "document.readyState === 'complete'").await,
                true,
                "material page stopped responding after pagination round {round}"
            );
            let mut sample = material_sample(&endpoint, &target, round).await;
            sample["roundLatencyMs"] = json!(started.elapsed().as_secs_f64() * 1000.0);
            samples.push(sample);
            eprintln!("material regression round {round}/30 completed");
        }

        if let Some(parent) = result_path.parent() {
            std::fs::create_dir_all(parent).expect("create material result directory");
        }
        let result = json!({
            "variant": variant,
            "rounds": 30,
            "samples": samples,
            "browserProduct": version["product"],
        });
        std::fs::write(
            &result_path,
            serde_json::to_vec_pretty(&result).expect("serialize material regression result"),
        )
        .expect("write material regression result");
        eprintln!("material regression result written");
    });
}
