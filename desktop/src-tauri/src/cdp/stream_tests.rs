//! Acceptance at the production `collect` report-stream / managed-signal seams.
use super::*;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

#[derive(Default)]
struct SchedulingGate {
    paused: std::sync::atomic::AtomicBool,
    waker: std::sync::Mutex<Option<std::task::Waker>>,
}

impl SchedulingGate {
    fn pause(&self) {
        self.paused.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn resume(&self) {
        self.paused
            .store(false, std::sync::atomic::Ordering::SeqCst);
        if let Some(waker) = self.waker.lock().unwrap().take() {
            waker.wake();
        }
    }
}

struct StreamFixture {
    events: UnboundedSender<Value>,
    commands: UnboundedReceiver<Value>,
    reports: UnboundedReceiver<PageReport>,
    task: tokio::task::JoinHandle<Result<(), CdpError>>,
    server: tokio::task::JoinHandle<()>,
    scheduling: std::sync::Arc<SchedulingGate>,
    close: UnboundedSender<()>,
    sent: UnboundedReceiver<()>,
    managed: bool,
}

impl StreamFixture {
    async fn new(managed: Option<ManagedWatch>) -> Self {
        let is_managed = managed.is_some();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = DevToolsEndpoint {
            port: listener.local_addr().unwrap().port(),
            browser_path: "/devtools/browser/stream-fixture".into(),
        };
        let (events, mut event_rx) = unbounded_channel::<Value>();
        let (command_tx, commands) = unbounded_channel();
        let (close, mut close_rx) = unbounded_channel();
        let (sent_tx, sent) = unbounded_channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            loop {
                tokio::select! {
                    event = event_rx.recv() => {
                        let Some(event) = event else { break };
                        socket.send(Message::Text(event.to_string().into())).await.unwrap();
                        let _ = sent_tx.send(());
                    }
                    _ = close_rx.recv() => {
                        let _ = socket.close(None).await;
                        let _ = sent_tx.send(());
                        return;
                    }
                    frame = socket.next() => {
                        let Some(Ok(Message::Text(text))) = frame else { break };
                        command_tx.send(serde_json::from_str(&text).unwrap()).unwrap();
                    }
                }
            }
            let _ = socket.close(None).await;
        });
        let (sink, reports) = unbounded_channel();
        let scheduling = std::sync::Arc::new(SchedulingGate::default());
        let task_gate = scheduling.clone();
        let task = tokio::spawn(async move {
            let mut collection = std::pin::pin!(collect(endpoint, sink, managed));
            std::future::poll_fn(move |cx| {
                if task_gate.paused.load(std::sync::atomic::Ordering::SeqCst) {
                    *task_gate.waker.lock().unwrap() = Some(cx.waker().clone());
                    return std::task::Poll::Pending;
                }
                std::future::Future::poll(collection.as_mut(), cx)
            })
            .await
        });
        let mut fixture = Self {
            events,
            commands,
            reports,
            task,
            server,
            scheduling,
            close,
            sent,
            managed: is_managed,
        };
        let auto = fixture.command().await;
        assert_eq!(auto["method"], "Target.setAutoAttach");
        fixture.send(json!({"id":auto["id"],"result":{}}));
        assert_eq!(fixture.command().await["method"], "Target.getTargets");
        fixture
    }

    async fn command(&mut self) -> Value {
        timeout(Duration::from_secs(2), self.commands.recv())
            .await
            .unwrap()
            .unwrap()
    }

    fn send(&self, message: Value) {
        self.events.send(message).unwrap();
    }

    async fn begin_attach(&mut self, session: &str, target: &str) -> Vec<Value> {
        self.send(json!({"method":"Target.attachedToTarget","params":{
            "sessionId":session,"targetInfo":{"targetId":target,"type":"page","url":"about:blank"},
            "waitingForDebugger":true
        }}));
        let count = if self.managed { 4 } else { 3 };
        let mut commands = Vec::new();
        for _ in 0..count {
            commands.push(self.command().await);
        }
        commands
    }

    fn acknowledge(&self, command: &Value) {
        let result = if command["method"] == "Page.getFrameTree" {
            json!({"frameTree":{"frame":{"id":"main","loaderId":"L0","url":"about:blank"}}})
        } else {
            json!({})
        };
        self.send(command_reply(command, result));
    }

    async fn accept_resume(&mut self, session: &str) -> Value {
        let resume = self.command().await;
        assert_eq!(resume["method"], "Runtime.runIfWaitingForDebugger");
        assert_eq!(resume["sessionId"], session);
        self.acknowledge(&resume);
        resume
    }

    /// Managed tree races delay only the valid tree ACK; ordinary trees always
    /// remain pending until the individual test supplies their contents.
    async fn attach_before_tree(&mut self, session: &str, target: &str) -> Vec<Value> {
        let commands = self.begin_attach(session, target).await;
        for command in &commands {
            if command["method"] != "Page.getFrameTree" {
                self.acknowledge(command);
            }
        }
        commands
    }

    async fn attach(&mut self, session: &str, target: &str) -> Vec<Value> {
        let mut commands = self.attach_before_tree(session, target).await;
        if self.managed {
            let tree = commands
                .iter()
                .find(|c| c["method"] == "Page.getFrameTree")
                .unwrap();
            self.acknowledge(tree);
            commands.push(self.accept_resume(session).await);
        }
        commands
    }

    // A round-trip command is a processing barrier, unlike waiting for the
    // fixture socket to write bytes (which does not mean collect consumed them).
    async fn barrier(&mut self) {
        self.send(json!({"method":"Target.attachedToTarget","params":{
            "sessionId":"barrier-worker","targetInfo":{"type":"worker","targetId":"barrier"}
        }}));
        assert_eq!(
            self.command().await["method"],
            "Runtime.runIfWaitingForDebugger"
        );
        assert_eq!(self.command().await["method"], "Target.detachFromTarget");
    }

    async fn failed(self) {
        let result = timeout(Duration::from_secs(2), self.task)
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(result, Err(CdpError::Command(_))),
            "local guard failure: {result:?}"
        );
        drop(self.events);
        timeout(Duration::from_secs(2), self.server)
            .await
            .unwrap()
            .unwrap();
    }

    async fn report(&mut self) -> PageReport {
        timeout(Duration::from_secs(2), self.reports.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn stop(self) {
        drop(self.events);
        self.server.await.unwrap();
        assert_eq!(self.task.await.unwrap(), Ok(()));
    }
}

fn platform_watch(signals: tokio::sync::mpsc::UnboundedSender<ManagedSignal>) -> ManagedWatch {
    let monitor =
        crate::managed_cdp::ManagedSessionMonitor::for_session("https://agent.oceanengine.com/")
            .unwrap();
    let status = monitor.status_view();
    ManagedWatch {
        login_guard_script: crate::managed_cdp::logout_guard_script(
            "https://agent.oceanengine.com/",
        )
        .unwrap(),
        monitor,
        signals,
        status,
        guard_installed: crate::managed_cdp::GuardInstalled::default(),
    }
}

fn navigation(session: &str, url: &str) -> Value {
    json!({"method":"Page.frameNavigated","sessionId":session,"params":{
        "frame":{"id":"main","loaderId":"L1","url":url}
    }})
}

fn command_reply(command: &Value, result: Value) -> Value {
    let mut reply = json!({"id":command["id"],"result":result});
    if let Some(session) = command.get("sessionId") {
        reply["sessionId"] = session.clone();
    }
    reply
}

fn lifecycle(session: &str, frame: &str, loader: &str, name: &str) -> Value {
    json!({"method":"Page.lifecycleEvent","sessionId":session,"params":{
        "frameId":frame,"loaderId":loader,"name":name
    }})
}

fn page_loaded(session: &str, frame: &str) -> Value {
    lifecycle(session, frame, "L1", "load")
}

#[tokio::test]
async fn queued_login_cancellation_wins_when_collector_resumes_after_deadline() {
    for action in ["away", "detach", "close"] {
        let (signals, mut signal_rx) = unbounded_channel();
        let watch = crate::managed_cdp::localhost_test_watch("http://127.0.0.1:18765/", signals);
        let mut fixture = StreamFixture::new(Some(watch)).await;
        fixture.attach("S1", "T1").await;
        fixture.send(navigation("S1", "http://127.0.0.1:18765/login"));
        fixture.report().await;
        fixture.send(page_loaded("S1", "main"));
        fixture.barrier().await;
        fixture.scheduling.pause();
        while fixture.sent.try_recv().is_ok() {}
        if action == "close" {
            fixture.close.send(()).unwrap();
        } else {
            let event = if action == "away" {
                json!({"method":"Page.navigatedWithinDocument","sessionId":"S1",
                    "params":{"frameId":"main","url":"http://127.0.0.1:18765/workbench"}})
            } else {
                json!({"method":"Target.detachedFromTarget","params":{"sessionId":"S1"}})
            };
            fixture.send(event);
        }
        timeout(Duration::from_secs(2), fixture.sent.recv())
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(100)).await;
        fixture.scheduling.resume();
        if action == "close" {
            assert!(
                matches!(
                    timeout(Duration::from_secs(2), signal_rx.recv()).await,
                    Ok(Some(ManagedSignal::ConnectionLost))
                ),
                "queued close must not expire credentials"
            );
            fixture.server.await.unwrap();
            assert_eq!(fixture.task.await.unwrap(), Ok(()));
        } else {
            if action == "away" {
                fixture.report().await;
            }
            assert!(
                timeout(Duration::from_millis(100), signal_rx.recv())
                    .await
                    .is_err(),
                "queued cancellation must win over an overdue timer"
            );
            fixture.stop().await;
        }
    }
}

#[tokio::test]
async fn full_navigation_preserves_pending_main_frame_spa_visits() {
    let mut fixture = StreamFixture::new(None).await;
    let commands = fixture.attach("S1", "T1").await;
    let tree = commands
        .iter()
        .find(|c| c["method"] == "Page.getFrameTree")
        .unwrap();
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1",
        "params":{"frameId":"child","url":"https://example.test/ignored?advid=99"}}),
    );
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1",
        "params":{"frameId":"main","url":"https://example.test/spa?advid=1"}}),
    );
    fixture.send(navigation("S1", "https://example.test/document?advid=2"));
    let first = fixture.report().await;
    assert_eq!(first.url, "https://example.test/spa");
    assert_eq!(first.url_params.as_deref(), Some("advid=1"));
    let second = fixture.report().await;
    assert_eq!(second.url, "https://example.test/document");
    assert_eq!(second.url_params.as_deref(), Some("advid=2"));
    fixture.send(
        json!({"id":tree["id"],"sessionId":"S1","result":{"frameTree":{
            "frame":{"id":"main","url":"https://example.test/stale"}
        }}}),
    );
    assert!(timeout(Duration::from_millis(100), fixture.reports.recv())
        .await
        .is_err());
    fixture.stop().await;
}

#[tokio::test]
async fn spa_before_initial_tree_uses_new_route_not_stale_tree_or_iframe() {
    let mut fixture = StreamFixture::new(None).await;
    let commands = fixture.attach("S1", "T1").await;
    let tree = commands
        .iter()
        .find(|c| c["method"] == "Page.getFrameTree")
        .unwrap();
    for (frame, url) in [
        ("child", "https://shop.example.test/iframe-spa"),
        ("main", "https://shop.example.test/earlier-spa?advid=28"),
        (
            "main",
            "https://shop.example.test/new-spa?advid=29&token=fixture",
        ),
    ] {
        fixture.send(
            json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
                "frameId":frame,"url":url
            }}),
        );
    }
    fixture.send(
        json!({"id":tree["id"],"sessionId":"S1","result":{"frameTree":{
            "frame":{"id":"main","url":"https://shop.example.test/stale"}
        }}}),
    );
    assert_eq!(
        fixture.report().await,
        PageReport::visit_parts(
            "https://shop.example.test/earlier-spa".into(),
            Some("advid=28".into())
        )
    );
    assert_eq!(
        fixture.report().await,
        PageReport::visit_parts(
            "https://shop.example.test/new-spa".into(),
            Some("advid=29&token=%5BREDACTED%5D".into())
        )
    );
    assert!(timeout(Duration::from_millis(100), fixture.reports.recv())
        .await
        .is_err());
    fixture.stop().await;
}

#[tokio::test]
async fn pre_tree_spa_away_from_login_cannot_expire_from_stale_login_tree() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let mut fixture = StreamFixture::new(Some(watch)).await;
    let commands = fixture.attach_before_tree("S1", "T1").await;
    let tree = commands
        .iter()
        .find(|c| c["method"] == "Page.getFrameTree")
        .unwrap();
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
            "frameId":"child","url":"https://sso.oceanengine.com/account/page/service/sso_logout"
        }}),
    );
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
            "frameId":"main","url":"https://agent.oceanengine.com/workbench?advid=34"
        }}),
    );
    fixture.send(
        json!({"id":tree["id"],"sessionId":"S1","result":{"frameTree":{
            "frame":{"id":"main","loaderId":"L1","url":"https://agent.oceanengine.com/login"}
        }}}),
    );
    fixture.accept_resume("S1").await;
    fixture.send(page_loaded("S1", "main"));
    assert_eq!(
        fixture.report().await.url_params.as_deref(),
        Some("advid=34")
    );
    assert!(timeout(
        crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(100),
        signal_rx.recv()
    )
    .await
    .is_err());
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
            "frameId":"main","url":"https://sso.oceanengine.com/account/page/service/sso_logout"
        }}),
    );
    assert!(
        matches!(signal_rx.recv().await, Some(ManagedSignal::Expired)),
        "tree-seeded main id drives guard after race"
    );
    fixture.stop().await;
}

#[tokio::test]
async fn newer_navigation_wins_over_stale_unsolicited_and_failed_frame_trees() {
    let mut fixture = StreamFixture::new(None).await;
    let commands = fixture.attach("S1", "T1").await;
    let tree = commands
        .iter()
        .find(|c| c["method"] == "Page.getFrameTree")
        .unwrap();
    fixture.send(navigation("S1", "https://shop.example.test/newer?advid=23"));
    assert_eq!(
        fixture.report().await.url_params.as_deref(),
        Some("advid=23")
    );
    for (id, session) in [
        (999, "S1"),
        (tree["id"].as_i64().unwrap(), "other"),
        (tree["id"].as_i64().unwrap(), "S1"),
    ] {
        fixture.send(json!({"id":id,"sessionId":session,"result":{"frameTree":{
            "frame":{"id":"stale-main","url":"https://shop.example.test/stale"}
        }}}));
    }
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
            "frameId":"main","url":"https://shop.example.test/spa-after-race"
        }}),
    );
    assert_eq!(
        fixture.report().await.url,
        "https://shop.example.test/spa-after-race"
    );
    let commands = fixture.attach("S2", "T2").await;
    let tree = commands
        .iter()
        .find(|c| c["method"] == "Page.getFrameTree")
        .unwrap();
    fixture.send(json!({"id":tree["id"],"sessionId":"S2","error":{"code":-32000}}));
    fixture.send(
        json!({"id":tree["id"],"sessionId":"S2","result":{"frameTree":{
            "frame":{"id":"ignored","url":"https://shop.example.test/failed-tree"}
        }}}),
    );
    assert!(timeout(Duration::from_millis(100), fixture.reports.recv())
        .await
        .is_err());
    fixture.send(navigation("S2", "https://shop.example.test/recovered"));
    assert_eq!(
        fixture.report().await.url,
        "https://shop.example.test/recovered"
    );
    fixture.stop().await;
}

#[tokio::test]
async fn managed_initial_tree_starts_deadline_and_detach_cancels_it() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let mut fixture = StreamFixture::new(Some(watch)).await;
    let commands = fixture.attach_before_tree("S1", "T1").await;
    let tree = commands
        .iter()
        .find(|c| c["method"] == "Page.getFrameTree")
        .unwrap();
    fixture.send(
        json!({"id":tree["id"],"sessionId":"S1","result":{"frameTree":{
            "frame":{"id":"main","loaderId":"L1","url":"https://agent.oceanengine.com/login"}
        }}}),
    );
    fixture.report().await;
    fixture.accept_resume("S1").await;
    fixture.send(page_loaded("S1", "main"));
    fixture.barrier().await;
    fixture.send(json!({"method":"Target.detachedFromTarget","params":{"sessionId":"S1"}}));
    assert!(timeout(
        crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(100),
        signal_rx.recv()
    )
    .await
    .is_err());
    let commands = fixture.attach_before_tree("S2", "T2").await;
    let tree = commands
        .iter()
        .find(|c| c["method"] == "Page.getFrameTree")
        .unwrap();
    fixture.send(
        json!({"id":tree["id"],"sessionId":"S2","result":{"frameTree":{
            "frame":{"id":"main","loaderId":"L1","url":"https://agent.oceanengine.com/login"}
        }}}),
    );
    fixture.report().await;
    fixture.accept_resume("S2").await;
    fixture.send(page_loaded("S2", "main"));
    assert!(matches!(
        timeout(
            crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(200),
            signal_rx.recv()
        )
        .await,
        Ok(Some(ManagedSignal::Expired))
    ));
    fixture.stop().await;
}

#[tokio::test]
async fn rejected_duplicate_session_cannot_expire_managed_session() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let mut fixture = StreamFixture::new(Some(watch)).await;
    fixture.attach("S1", "T1").await;
    fixture.send(json!({"method":"Target.attachedToTarget","params":{
        "sessionId":"S9","targetInfo":{"targetId":"T1","type":"page","url":"about:blank"}
    }}));
    assert_eq!(
        fixture.command().await["method"],
        "Runtime.runIfWaitingForDebugger"
    );
    assert_eq!(fixture.command().await["method"], "Target.detachFromTarget");
    fixture.send(navigation(
        "S9",
        "https://sso.oceanengine.com/account/page/service/sso_logout",
    ));
    assert!(timeout(Duration::from_millis(100), signal_rx.recv())
        .await
        .is_err());
    assert!(timeout(Duration::from_millis(100), fixture.reports.recv())
        .await
        .is_err());
    fixture.stop().await;
    assert!(matches!(
        signal_rx.recv().await,
        Some(ManagedSignal::ConnectionLost)
    ));
}

#[tokio::test]
async fn managed_connect_failure_signals_connection_lost_once() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = DevToolsEndpoint {
        port: listener.local_addr().unwrap().port(),
        browser_path: "/devtools/browser/gone".into(),
    };
    drop(listener);
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let (sink, _reports) = unbounded_channel();
    assert!(matches!(
        collect(endpoint, sink, Some(watch)).await,
        Err(CdpError::Connect(_))
    ));
    assert!(matches!(
        signal_rx.recv().await,
        Some(ManagedSignal::ConnectionLost)
    ));
    assert!(signal_rx.recv().await.is_none());
}

#[tokio::test]
async fn quiet_managed_login_expires_once_without_runtime_events() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let mut fixture = StreamFixture::new(Some(watch)).await;
    let commands = fixture.attach("S1", "T1").await;
    assert!(!commands
        .iter()
        .any(|c| c["method"] == "Runtime.enable" || c["method"] == "Runtime.addBinding"));
    assert_eq!(
        commands
            .iter()
            .filter(|c| c["method"] == "Page.addScriptToEvaluateOnNewDocument")
            .count(),
        1
    );
    fixture.send(navigation("S1", "https://agent.oceanengine.com/login"));
    fixture.report().await;
    // 加载完成门禁：主 frame 的 load 之后才开始观察窗。
    fixture.send(page_loaded("S1", "main"));
    assert!(
        matches!(
            timeout(
                crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(300),
                signal_rx.recv()
            )
            .await,
            Ok(Some(ManagedSignal::Expired))
        ),
        "a quiet, fully loaded login must expire without any Runtime events"
    );
    assert!(
        timeout(Duration::from_millis(100), signal_rx.recv())
            .await
            .is_err(),
        "Expired is one-shot"
    );
    fixture.stop().await;
    assert!(matches!(
        signal_rx.recv().await,
        Some(ManagedSignal::ConnectionLost)
    ));
    assert!(signal_rx.recv().await.is_none());
}

/// 慢加载回归：导航已提交到 /login、但主 frame 一直没发 load（页面仍在加载）
/// 时，即使远超 LOGIN_SETTLE 也不能判凭据失效；load 到达且继续停留才计时失效。
#[tokio::test]
async fn slow_login_without_load_event_never_expires_early() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let mut fixture = StreamFixture::new(Some(watch)).await;
    fixture.attach("S1", "T1").await;
    fixture.send(navigation("S1", "https://agent.oceanengine.com/login"));
    fixture.report().await;

    // 导航提交之后一直不发 loadEventFired——模拟页面仍在加载。
    // 跨过两个观察窗都没有任何 Expired。
    for _ in 0..2 {
        tokio::time::sleep(crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(100)).await;
        assert!(
            timeout(Duration::from_millis(100), signal_rx.recv())
                .await
                .is_err(),
            "仍在加载的登录页不能误判失效"
        );
    }

    // 子 frame 的 load 也不算主文档加载完成。
    fixture.send(page_loaded("S1", "child"));
    tokio::time::sleep(crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(100)).await;
    assert!(
        timeout(Duration::from_millis(100), signal_rx.recv())
            .await
            .is_err(),
        "iframe 的 load 不能开始登录观察窗"
    );

    // 主 frame 真正加载完成后，稳定停留才在观察窗后失效。
    fixture.send(page_loaded("S1", "main"));
    assert!(matches!(
        timeout(
            crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(300),
            signal_rx.recv()
        )
        .await,
        Ok(Some(ManagedSignal::Expired))
    ));
    fixture.stop().await;
}

#[tokio::test]
async fn frame_tree_seeds_initial_url_once_and_spa_is_main_frame_only() {
    let mut fixture = StreamFixture::new(None).await;
    let commands = fixture.attach("S1", "T1").await;
    let tree = commands
        .iter()
        .find(|c| c["method"] == "Page.getFrameTree")
        .unwrap();
    fixture.send(json!({"id":tree["id"],"sessionId":"S1","result":{"frameTree":{
        "frame":{"id":"main","loaderId":"L1","url":"https://shop.example.test/first?advid=17"},
        "childFrames":[{"frame":{"id":"child","parentId":"main","url":"https://shop.example.test/frame"}}]
    }}}));
    assert_eq!(
        fixture.report().await,
        PageReport::visit_parts(
            "https://shop.example.test/first".into(),
            Some("advid=17".into())
        )
    );
    fixture.send(
        json!({"method":"Page.frameNavigated","sessionId":"S1","params":{
            "frame":{"id":"main","loaderId":"L1","url":"https://shop.example.test/first?advid=17"}
        }}),
    );
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
            "frameId":"child","url":"https://shop.example.test/iframe-spa"
        }}),
    );
    assert!(timeout(Duration::from_millis(100), fixture.reports.recv())
        .await
        .is_err());
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
            "frameId":"main","url":"https://shop.example.test/spa?advid=18"
        }}),
    );
    assert_eq!(
        fixture.report().await.url_params.as_deref(),
        Some("advid=18")
    );
    fixture.stop().await;
}

#[tokio::test]
async fn guard_ready_requires_every_install_and_resume_ack_for_the_exact_page() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let ready = watch.guard_installed.clone();
    let mut fixture = StreamFixture::new(Some(watch)).await;
    let commands = fixture.begin_attach("S1", "T1").await;
    assert_eq!(
        commands
            .iter()
            .map(|c| c["method"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "Page.addScriptToEvaluateOnNewDocument",
            "Page.enable",
            "Page.getFrameTree",
            "Page.setLifecycleEventsEnabled"
        ]
    );
    assert_eq!(commands[3]["params"]["enabled"], true);
    assert_eq!(commands[0]["params"]["runImmediately"], true);
    assert!(
        !ready.wait_ready(Duration::from_millis(40)).await,
        "sending install commands is not readiness"
    );

    let tree = &commands[2];
    for command in commands
        .iter()
        .filter(|c| c["method"] != "Page.getFrameTree")
    {
        fixture.acknowledge(command);
    }
    let mut wrong = command_reply(
        tree,
        json!({"frameTree":{"frame":{"id":"main","loaderId":"L0","url":"about:blank"}}}),
    );
    wrong["id"] = json!(99999);
    fixture.send(wrong.clone());
    wrong["id"] = tree["id"].clone();
    wrong["sessionId"] = json!("other-session");
    fixture.send(wrong);
    fixture.barrier().await;
    assert!(
        fixture.commands.try_recv().is_err(),
        "missing/extraneous tree ACK cannot resume page"
    );
    assert!(!ready.wait_ready(Duration::from_millis(40)).await);
    fixture.acknowledge(tree);
    let resume = fixture.command().await;
    assert_eq!(resume["method"], "Runtime.runIfWaitingForDebugger");
    assert!(
        !ready.wait_ready(Duration::from_millis(40)).await,
        "resume send is not readiness"
    );
    let mut wrong = command_reply(&resume, json!({}));
    wrong["id"] = json!(99998);
    fixture.send(wrong.clone());
    wrong["id"] = resume["id"].clone();
    wrong["sessionId"] = json!("other-session");
    fixture.send(wrong);
    // A valid worker resume reply cannot satisfy page readiness either.
    fixture.send(json!({"method":"Target.attachedToTarget","params":{
        "sessionId":"worker","targetInfo":{"targetId":"worker","type":"service_worker"}
    }}));
    let worker = fixture.command().await;
    assert_eq!(worker["method"], "Runtime.runIfWaitingForDebugger");
    fixture.acknowledge(&worker);
    assert_eq!(fixture.command().await["method"], "Target.detachFromTarget");
    fixture.barrier().await;
    assert!(!ready.wait_ready(Duration::from_millis(40)).await);
    fixture.acknowledge(&resume);
    assert!(ready.wait_ready(Duration::from_secs(1)).await);
    assert!(signal_rx.try_recv().is_err());
    fixture.stop().await;
}

#[tokio::test]
async fn rejected_or_malformed_guard_and_resume_acks_fail_locally_without_readiness() {
    for method in [
        "Page.enable",
        "Page.getFrameTree",
        "Page.setLifecycleEventsEnabled",
        "Page.addScriptToEvaluateOnNewDocument",
        "Runtime.runIfWaitingForDebugger",
    ] {
        for invalid in ["error", "missing-result", "null-result", "array-result"] {
            let (signals, mut signal_rx) = unbounded_channel();
            let watch = platform_watch(signals);
            let ready = watch.guard_installed.clone();
            let status = watch.status.clone();
            let mut fixture = StreamFixture::new(Some(watch)).await;
            let commands = fixture.begin_attach("S1", "T1").await;
            let command = if method == "Runtime.runIfWaitingForDebugger" {
                for command in &commands {
                    fixture.acknowledge(command);
                }
                fixture.command().await
            } else {
                commands
                    .iter()
                    .find(|c| c["method"] == method)
                    .unwrap()
                    .clone()
            };
            let mut reply = command_reply(&command, json!({}));
            match invalid {
                "error" => {
                    reply["error"] = json!({"code":-32000,"message":"synthetic rejection"});
                }
                "missing-result" => {
                    reply.as_object_mut().unwrap().remove("result");
                }
                "null-result" => reply["result"] = Value::Null,
                "array-result" => reply["result"] = json!([]),
                _ => unreachable!(),
            }
            fixture.send(reply);
            assert!(
                matches!(
                    timeout(Duration::from_secs(1), signal_rx.recv()).await,
                    Ok(Some(ManagedSignal::ConnectionLost))
                ),
                "{method} {invalid} must be local failure, not expiry"
            );
            assert_eq!(
                status.current(),
                crate::managed_cdp::LoginGuardStatus::MonitorGone
            );
            assert!(!ready.wait_ready(Duration::from_millis(20)).await);
            fixture.failed().await;
            assert!(signal_rx.recv().await.is_none());
        }
    }
    for result in [
        json!({}),
        json!({"frameTree":{}}),
        json!({"frameTree":{"frame":null}}),
        json!({"frameTree":{"frame":{"id":"","url":"about:blank"}}}),
    ] {
        let (signals, mut signal_rx) = unbounded_channel();
        let watch = platform_watch(signals);
        let ready = watch.guard_installed.clone();
        let mut fixture = StreamFixture::new(Some(watch)).await;
        let commands = fixture.begin_attach("S1", "T1").await;
        let tree = commands
            .iter()
            .find(|c| c["method"] == "Page.getFrameTree")
            .unwrap();
        fixture.send(command_reply(tree, result));
        assert!(
            matches!(
                timeout(Duration::from_secs(1), signal_rx.recv()).await,
                Ok(Some(ManagedSignal::ConnectionLost))
            ),
            "managed tree ACK must contain a usable frame"
        );
        assert!(!ready.wait_ready(Duration::from_millis(20)).await);
        fixture.failed().await;
    }
}

#[tokio::test]
async fn queued_expiry_is_revoked_by_disconnect_before_watcher_classifies_it() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let status = watch.status.clone();
    let mut fixture = StreamFixture::new(Some(watch)).await;
    fixture.attach("S1", "T1").await;
    fixture.send(navigation("S1", "https://agent.oceanengine.com/login"));
    fixture.report().await;
    fixture.send(page_loaded("S1", "main"));
    fixture.barrier().await;
    tokio::time::sleep(crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(100)).await;
    fixture.barrier().await;
    assert_eq!(
        status.current(),
        crate::managed_cdp::LoginGuardStatus::ExpiryValid,
        "expiry was actually published before disconnect"
    );
    fixture.close.send(()).unwrap();
    assert_eq!(
        timeout(Duration::from_secs(2), fixture.task)
            .await
            .unwrap()
            .unwrap(),
        Ok(())
    );
    fixture.server.await.unwrap();
    assert_eq!(
        status.current(),
        crate::managed_cdp::LoginGuardStatus::MonitorGone
    );
    let (_exit_tx, mut exited) = tokio::sync::oneshot::channel();
    assert!(
        matches!(
            crate::commands::wait_managed_signal(&status, &mut signal_rx, &mut exited).await,
            Some(ManagedSignal::ConnectionLost)
        ),
        "queued Expired must be reclassified after disconnect"
    );
    assert!(matches!(
        signal_rx.recv().await,
        Some(ManagedSignal::ConnectionLost)
    ));
    assert!(signal_rx.recv().await.is_none());
}

#[tokio::test]
async fn spa_login_on_a_loaded_workbench_expires_without_another_load() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let mut fixture = StreamFixture::new(Some(watch)).await;
    fixture.attach("S1", "T1").await;
    fixture.send(navigation("S1", "https://agent.oceanengine.com/workbench"));
    fixture.report().await;
    fixture.send(page_loaded("S1", "main"));
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
            "frameId":"child","url":"https://agent.oceanengine.com/login"
        }}),
    );
    fixture.barrier().await;
    assert!(signal_rx.try_recv().is_err());
    fixture.send(
        json!({"method":"Page.navigatedWithinDocument","sessionId":"S1","params":{
            "frameId":"main","url":"https://agent.oceanengine.com/login"
        }}),
    );
    fixture.report().await;
    assert!(matches!(
        timeout(
            crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(300),
            signal_rx.recv()
        )
        .await,
        Ok(Some(ManagedSignal::Expired))
    ));
    fixture.stop().await;
}

#[tokio::test]
async fn loading_restart_cancels_old_deadline_and_stale_loader_cannot_rearm_it() {
    let (signals, mut signal_rx) = unbounded_channel();
    let watch = platform_watch(signals);
    let status = watch.status.clone();
    let mut fixture = StreamFixture::new(Some(watch)).await;
    fixture.attach("S1", "T1").await;
    fixture.send(navigation("S1", "https://agent.oceanengine.com/login"));
    fixture.report().await;
    fixture.send(page_loaded("S1", "main"));
    fixture.barrier().await;
    tokio::time::sleep(crate::managed_cdp::LOGIN_SETTLE - Duration::from_millis(500)).await;
    fixture.send(
        json!({"method":"Page.frameStartedLoading","sessionId":"S1","params":{"frameId":"main"}}),
    );
    fixture.send(lifecycle("S1", "main", "L2", "init"));
    fixture.send(page_loaded("S1", "main")); // stale L1 load
    fixture.send(lifecycle("S1", "child", "L2", "load"));
    fixture.barrier().await;
    assert!(
        timeout(
            crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(100),
            signal_rx.recv()
        )
        .await
        .is_err(),
        "restart must cancel old deadline before navigation commits"
    );
    assert_eq!(
        status.current(),
        crate::managed_cdp::LoginGuardStatus::NotExpired
    );
    let mut next = navigation("S1", "https://agent.oceanengine.com/login/retry");
    next["params"]["frame"]["loaderId"] = json!("L2");
    fixture.send(next);
    fixture.report().await;
    fixture.send(lifecycle("S1", "main", "L2", "load"));
    assert!(
        timeout(Duration::from_millis(200), signal_rx.recv())
            .await
            .is_err(),
        "new loaded document gets a fresh settle window"
    );
    assert!(matches!(
        timeout(
            crate::managed_cdp::LOGIN_SETTLE + Duration::from_millis(300),
            signal_rx.recv()
        )
        .await,
        Ok(Some(ManagedSignal::Expired))
    ));
    fixture.stop().await;
}

#[tokio::test]
async fn main_error_document_is_connection_loss_not_credential_expiry() {
    for error_frame in [
        json!({"id":"main","loaderId":"L2","url":"chrome-error://chromewebdata/","unreachableUrl":"https://agent.oceanengine.com/login"}),
        json!({"id":"main","loaderId":"L2","url":"https://agent.oceanengine.com/login","unreachableUrl":"https://agent.oceanengine.com/login"}),
    ] {
        let (signals, mut signal_rx) = unbounded_channel();
        let watch = platform_watch(signals);
        let status = watch.status.clone();
        let mut fixture = StreamFixture::new(Some(watch)).await;
        fixture.attach("S1", "T1").await;
        // An iframe error must neither fail the main document nor expire credentials.
        fixture.send(json!({"method":"Page.frameNavigated","sessionId":"S1","params":{"frame":{
            "id":"child","parentId":"main","url":"chrome-error://chromewebdata/","unreachableUrl":"https://agent.oceanengine.com/login"
        }}}));
        fixture.barrier().await;
        assert!(signal_rx.try_recv().is_err());
        fixture.send(
            json!({"method":"Page.frameNavigated","sessionId":"S1","params":{"frame":error_frame}}),
        );
        assert!(matches!(
            timeout(Duration::from_secs(1), signal_rx.recv()).await,
            Ok(Some(ManagedSignal::ConnectionLost))
        ));
        assert_eq!(
            status.current(),
            crate::managed_cdp::LoginGuardStatus::MonitorGone
        );
        fixture.failed().await;
        assert!(signal_rx.recv().await.is_none());
    }
}

#[tokio::test]
async fn ordinary_collection_subscribes_only_to_page_urls() {
    let mut fixture = StreamFixture::new(None).await;
    let commands = fixture.attach("S1", "T1").await;
    let methods: Vec<&str> = commands
        .iter()
        .map(|c| c["method"].as_str().unwrap())
        .collect();
    assert_eq!(
        methods,
        vec![
            "Page.enable",
            "Page.getFrameTree",
            "Runtime.runIfWaitingForDebugger"
        ]
    );
    fixture.stop().await;
}

#[tokio::test]
async fn url_only_stream_ignores_legacy_activity_binding() {
    let mut fixture = StreamFixture::new(None).await;
    fixture.attach("S1", "T1").await;
    fixture.send(navigation(
        "S1",
        "https://shop.example.test/orders?advid=42&token=fixture",
    ));
    assert_eq!(
        fixture.report().await,
        PageReport::visit_parts(
            "https://shop.example.test/orders".into(),
            Some("advid=42&token=%5BREDACTED%5D".into())
        )
    );
    fixture.send(
        json!({"method":"Runtime.bindingCalled","sessionId":"S1","params":{
            "name":"__vestusReportActivity", "payload":json!({
                "url":"https://shop.example.test/orders?advid=42", "dwellMs":60000,
                "counts":{"click":1,"input":1,"submit":1,"scroll":1},
                "inputSnapshot":{"quantity":["2"]},"submitSnapshot":{"quantity":["2"]}
            }).to_string()
        }}),
    );
    assert!(
        timeout(Duration::from_millis(150), fixture.reports.recv())
            .await
            .is_err(),
        "legacy interaction/dwell/form binding must never produce a new report"
    );
    fixture.stop().await;
}
