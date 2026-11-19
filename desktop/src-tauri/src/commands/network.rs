//! Periodic, bounded network diagnostics for the desktop client.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Runtime};

use super::{auth_command_error, require_desktop_auth, CmdResult, CommandError};
use crate::auth::DesktopAuthState;
use crate::browser::BrowserSessionManager;
use crate::device;
use crate::network_diagnostics::{
    measure_browser_cdp, measure_management, measure_proxy, NetworkDiagnosticsReport,
    NetworkDiagnosticsSnapshot, NetworkSample,
};
use crate::state::AppState;

const INTERVAL: Duration = Duration::from_secs(60);
const MAX_QUEUE: usize = 120;
const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(30),
    Duration::from_secs(120),
];

type WorkerFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
type CollectHook = Arc<dyn Fn() -> WorkerFuture<Vec<NetworkSample>> + Send + Sync>;
type ReportHook =
    Arc<dyn Fn(NetworkDiagnosticsReport) -> WorkerFuture<Result<(), ReportFailure>> + Send + Sync>;
type EmitHook = Arc<dyn Fn(&NetworkDiagnosticsSnapshot) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReportFailure {
    SessionChanged,
    Retryable,
}

#[derive(Clone)]
struct WorkerHooks {
    collect: CollectHook,
    report: ReportHook,
    emit: EmitHook,
}

#[derive(Clone)]
pub struct NetworkMonitor {
    inner: Arc<MonitorInner>,
}

struct MonitorInner {
    state: Mutex<MonitorState>,
    wake: tokio::sync::Notify,
}

struct MonitorState {
    running: bool,
    generation: u64,
    stop: Option<tokio::sync::watch::Sender<bool>>,
    latest: NetworkDiagnosticsSnapshot,
    queue: VecDeque<NetworkDiagnosticsReport>,
    dropped_count: u64,
}

impl Default for NetworkMonitor {
    fn default() -> Self {
        Self {
            inner: Arc::new(MonitorInner {
                state: Mutex::new(MonitorState {
                    running: false,
                    generation: 0,
                    stop: None,
                    latest: NetworkDiagnosticsSnapshot {
                        samples: Vec::new(),
                        device_id: device::wire_device_id(),
                        upload_status: "idle".into(),
                        queued_count: 0,
                        dropped_count: 0,
                    },
                    queue: VecDeque::new(),
                    dropped_count: 0,
                }),
                wake: tokio::sync::Notify::new(),
            }),
        }
    }
}

impl NetworkMonitor {
    pub fn snapshot(&self) -> NetworkDiagnosticsSnapshot {
        self.inner
            .state
            .lock()
            .expect("网络监控锁已中毒")
            .latest
            .clone()
    }

    pub fn stop(&self) {
        let mut state = self.inner.state.lock().expect("网络监控锁已中毒");
        state.running = false;
        state.generation = state.generation.wrapping_add(1).max(1);
        if let Some(stop) = state.stop.take() {
            let _ = stop.send(true);
        }
    }

    pub fn wake(&self) {
        self.inner.wake.notify_one();
    }

    fn prepare_start(&self, generation: u64) -> Option<tokio::sync::watch::Receiver<bool>> {
        let mut state = self.inner.state.lock().expect("网络监控锁已中毒");
        if state.running {
            if state.generation == generation {
                return None;
            }
            if let Some(stop) = state.stop.take() {
                let _ = stop.send(true);
            }
            state.running = false;
        }
        state.running = true;
        state.generation = generation;
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        state.stop = Some(stop_tx);
        Some(stop_rx)
    }

    #[cfg(test)]
    fn enqueue(&self, report: NetworkDiagnosticsReport) {
        let mut state = self.inner.state.lock().expect("网络监控锁已中毒");
        state.queue.push_back(report);
        while state.queue.len() > MAX_QUEUE {
            state.queue.pop_front();
            state.dropped_count = state.dropped_count.saturating_add(1);
        }
    }

    #[cfg(test)]
    fn queue_len(&self) -> usize {
        self.inner
            .state
            .lock()
            .expect("网络监控锁已中毒")
            .queue
            .len()
    }

    #[cfg(test)]
    fn queued_reports(&self) -> Vec<NetworkDiagnosticsReport> {
        self.inner
            .state
            .lock()
            .expect("网络监控锁已中毒")
            .queue
            .iter()
            .cloned()
            .collect()
    }

    fn start<R: Runtime>(
        &self,
        app: AppHandle<R>,
        auth: DesktopAuthState,
        browsers: BrowserSessionManager,
        owner: (i64, String, u64),
        api: String,
    ) -> CmdResult<()> {
        let (user_id, profile_key, generation) = owner;
        let Some(stop_rx) = self.prepare_start(generation) else {
            return Ok(());
        };
        let api = api.clone();
        let browsers = browsers.clone();
        let monitor = self.clone();
        let collect: CollectHook = Arc::new(move || {
            let api = api.clone();
            let browsers = browsers.clone();
            Box::pin(async move { collect_samples(&api, &browsers).await })
        });
        let report: ReportHook = Arc::new(move |payload| {
            let auth = auth.clone();
            let profile_key = profile_key.clone();
            Box::pin(async move {
                auth.report_network_diagnostics(user_id, &profile_key, generation, &payload)
                    .await
                    .map(|_| ())
                    .map_err(|error| {
                        if matches!(error.code.as_str(), "session_changed" | "unauthenticated") {
                            ReportFailure::SessionChanged
                        } else {
                            ReportFailure::Retryable
                        }
                    })
            })
        });
        let emit: EmitHook = Arc::new(move |snapshot| {
            let _ = app.emit("network-diagnostics-changed", snapshot);
        });
        let hooks = WorkerHooks {
            collect,
            report,
            emit,
        };
        crate::rt::runtime().spawn(run_worker(
            monitor,
            generation,
            stop_rx,
            hooks,
            INTERVAL,
            RETRY_DELAYS,
        ));
        Ok(())
    }

    #[cfg(test)]
    fn start_test_worker(
        &self,
        generation: u64,
        hooks: WorkerHooks,
        interval: Duration,
        retry_delays: [Duration; 3],
    ) -> Option<tokio::task::JoinHandle<()>> {
        let stop_rx = self.prepare_start(generation)?;
        Some(tokio::spawn(run_worker(
            self.clone(),
            generation,
            stop_rx,
            hooks,
            interval,
            retry_delays,
        )))
    }
}

async fn run_worker(
    monitor: NetworkMonitor,
    generation: u64,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
    hooks: WorkerHooks,
    interval: Duration,
    retry_delays: [Duration; 3],
) {
    let mut first = true;
    loop {
        if !first {
            tokio::select! {
                _ = tokio::time::sleep(interval) => {},
                _ = monitor.inner.wake.notified() => {},
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() { break; }
                }
            }
        }
        first = false;
        if *stop_rx.borrow() {
            break;
        }
        let samples = (hooks.collect)().await;
        let snapshot = NetworkDiagnosticsSnapshot {
            samples,
            device_id: device::wire_device_id(),
            upload_status: "pending".into(),
            queued_count: 0,
            dropped_count: 0,
        };
        let current = {
            let mut state = monitor.inner.state.lock().expect("网络监控锁已中毒");
            if state.generation != generation || !state.running {
                false
            } else {
                state.queue.push_back(snapshot.clone().report());
                while state.queue.len() > MAX_QUEUE {
                    state.queue.pop_front();
                    state.dropped_count = state.dropped_count.saturating_add(1);
                }
                let mut snapshot = snapshot;
                snapshot.upload_status = "pending".into();
                snapshot.queued_count = state.queue.len();
                snapshot.dropped_count = state.dropped_count;
                state.latest = snapshot;
                true
            }
        };
        if !current {
            break;
        }
        (hooks.emit)(&monitor.snapshot());
        let stopped = flush_queue_with(&monitor, &hooks.report, &mut stop_rx, retry_delays).await;
        let after_flush = {
            let mut state = monitor.inner.state.lock().expect("网络监控锁已中毒");
            state.latest.upload_status = if state.queue.is_empty() { "uploaded" } else { "retrying" }.into();
            state.latest.queued_count = state.queue.len();
            state.latest.dropped_count = state.dropped_count;
            state.latest.clone()
        };
        if stopped {
            break;
        }
        if after_flush.queued_count > 0 {
            (hooks.emit)(&after_flush);
        }
    }
    if let Ok(mut state) = monitor.inner.state.lock() {
        if state.generation == generation {
            state.running = false;
            state.stop = None;
        }
    }
}

async fn collect_samples(api: &str, browsers: &BrowserSessionManager) -> Vec<NetworkSample> {
    let mut samples = vec![
        measure_management(&format!("{api}/api/product")).await,
        measure_proxy(None, &format!("{api}/api/product")).await,
    ];
    let recent = browsers.recent_sessions().into_iter().next();
    let mut sample = measure_browser_cdp(
        recent
            .as_ref()
            .and_then(|browser| browser.endpoint.as_ref()),
    )
    .await;
    if let Some(browser) = recent {
        sample.platform_id = Some(browser.platform_id.to_string());
        sample.browser_id = Some(browser.browser_id.to_string());
        sample.network_mode = if browser.direct_mode {
            "direct"
        } else {
            "proxy"
        }
        .into();
    }
    samples.push(sample);
    samples
}

/// Returns true when the owner session changed and the worker must terminate.
async fn flush_queue_with(
    monitor: &NetworkMonitor,
    report: &ReportHook,
    stop_rx: &mut tokio::sync::watch::Receiver<bool>,
    retry_delays: [Duration; 3],
) -> bool {
    let mut retry_delays = retry_delays.into_iter();
    loop {
        let payload = {
            monitor
                .inner
                .state
                .lock()
                .ok()
                .and_then(|state| state.queue.front().cloned())
        };
        let Some(payload) = payload else {
            return false;
        };
        if let Err(error) = report(payload).await {
            if error == ReportFailure::SessionChanged {
                return true;
            }
            if let Some(delay) = retry_delays.next() {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {},
                    changed = stop_rx.changed() => { if changed.is_err() || *stop_rx.borrow() { return true; } }
                }
                continue;
            }
            return false;
        }
        if let Ok(mut state) = monitor.inner.state.lock() {
            state.queue.pop_front();
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_network_diagnostics(
    monitor: tauri::State<'_, NetworkMonitor>,
    auth: tauri::State<'_, DesktopAuthState>,
) -> CmdResult<NetworkDiagnosticsSnapshot> {
    require_desktop_auth(&auth)?;
    Ok(monitor.snapshot())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_network_diagnostics<R: Runtime>(
    app: AppHandle<R>,
    monitor: tauri::State<'_, NetworkMonitor>,
    auth: tauri::State<'_, DesktopAuthState>,
    browsers: tauri::State<'_, BrowserSessionManager>,
    _state: tauri::State<'_, AppState>,
) -> CmdResult<()> {
    require_desktop_auth(&auth)?;
    let (user, profile, generation) = auth.current_identity().map_err(auth_command_error)?;
    let profile = profile.ok_or_else(|| CommandError::new("请先同步桌面配置", "not_ready"))?;
    let api = auth.api_base_url().map_err(auth_command_error)?.to_string();
    monitor.start(
        app,
        (*auth).clone(),
        (*browsers).clone(),
        (user, profile, generation),
        api,
    )
}

#[tauri::command(rename_all = "camelCase")]
pub async fn stop_network_diagnostics(
    monitor: tauri::State<'_, NetworkMonitor>,
    auth: tauri::State<'_, DesktopAuthState>,
) -> CmdResult<()> {
    require_desktop_auth(&auth)?;
    monitor.stop();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::BrowserSessionManager;
    use futures_util::{SinkExt, StreamExt};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;
    use tokio::sync::Notify;
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    fn sample(id: usize) -> NetworkSample {
        NetworkSample::success(format!("sample-{id}"), "test", "test", "direct", 1, 0)
    }

    fn report(id: usize) -> NetworkDiagnosticsReport {
        NetworkDiagnosticsReport {
            protocol_version: 1,
            samples: vec![sample(id)],
            device_id: None,
        }
    }

    fn hooks(
        calls: Arc<AtomicUsize>,
        reports: Arc<Mutex<Vec<NetworkDiagnosticsReport>>>,
        results: Arc<Mutex<VecDeque<Result<(), ReportFailure>>>>,
        emitted: Arc<Mutex<Vec<NetworkDiagnosticsSnapshot>>>,
    ) -> WorkerHooks {
        let collect: CollectHook = Arc::new(move || {
            let id = calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { vec![sample(id)] }) as WorkerFuture<Vec<NetworkSample>>
        });
        let report: ReportHook = Arc::new(move |payload| {
            reports.lock().expect("报告锁已中毒").push(payload);
            let outcome = results
                .lock()
                .expect("结果锁已中毒")
                .pop_front()
                .unwrap_or(Ok(()));
            Box::pin(async move { outcome }) as WorkerFuture<Result<(), ReportFailure>>
        });
        let emit: EmitHook = Arc::new(move |snapshot| {
            emitted.lock().expect("事件锁已中毒").push(snapshot.clone());
        });
        WorkerHooks {
            collect,
            report,
            emit,
        }
    }

    async fn wait_for_calls(calls: &AtomicUsize, expected: usize) {
        for _ in 0..100 {
            if calls.load(Ordering::SeqCst) >= expected {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("worker did not make {expected} collection calls");
    }

    #[tokio::test(start_paused = true)]
    async fn worker_samples_immediately_then_after_sixty_seconds_and_is_non_reentrant() {
        let monitor = NetworkMonitor::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let results = Arc::new(Mutex::new(VecDeque::new()));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let hooks = hooks(Arc::clone(&calls), reports, results, emitted);
        let handle = monitor
            .start_test_worker(11, hooks.clone(), INTERVAL, RETRY_DELAYS)
            .expect("first worker should start");
        assert!(
            monitor
                .start_test_worker(11, hooks, INTERVAL, RETRY_DELAYS)
                .is_none(),
            "same generation must not start a second worker"
        );
        wait_for_calls(&calls, 1).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "first sample is immediate");

        tokio::time::advance(Duration::from_secs(59)).await;
        tokio::task::yield_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        wait_for_calls(&calls, 2).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        monitor.stop();
        handle.await.expect("worker should stop cleanly");
    }

    #[tokio::test(start_paused = true)]
    async fn wake_starts_one_follow_up_sample_while_current_sample_is_in_flight() {
        let monitor = NetworkMonitor::default();
        let calls = Arc::new(AtomicUsize::new(0));
        let first_started = Arc::new(Notify::new());
        let release_first = Arc::new(Notify::new());
        let collect: CollectHook = Arc::new({
            let calls = Arc::clone(&calls);
            let first_started = Arc::clone(&first_started);
            let release_first = Arc::clone(&release_first);
            move || {
                let id = calls.fetch_add(1, Ordering::SeqCst);
                let first_started = Arc::clone(&first_started);
                let release_first = Arc::clone(&release_first);
                Box::pin(async move {
                    if id == 0 {
                        first_started.notify_one();
                        release_first.notified().await;
                    }
                    vec![sample(id)]
                }) as WorkerFuture<Vec<NetworkSample>>
            }
        });
        let reports = Arc::new(Mutex::new(Vec::new()));
        let results = Arc::new(Mutex::new(VecDeque::new()));
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let generic = hooks(Arc::clone(&calls), reports, results, emitted);
        let hooks = WorkerHooks {
            collect,
            report: generic.report,
            emit: generic.emit,
        };
        let handle = monitor
            .start_test_worker(12, hooks, INTERVAL, RETRY_DELAYS)
            .expect("worker should start");
        first_started.notified().await;
        monitor.wake();
        monitor.wake();
        tokio::time::advance(INTERVAL).await;
        tokio::task::yield_now().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "wake cannot re-enter an in-flight sample"
        );
        release_first.notify_one();
        wait_for_calls(&calls, 2).await;
        monitor.stop();
        handle.await.expect("worker should stop cleanly");
    }

    #[tokio::test]
    async fn collect_samples_returns_management_vpn_and_browser_samples() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = crate::httpio::read_head(&mut stream).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
        });
        let samples = collect_samples(
            &format!("http://{address}"),
            &BrowserSessionManager::default(),
        )
        .await;
        server.await.unwrap();
        assert_eq!(samples.len(), 3);
        assert_eq!(
            samples
                .iter()
                .map(|sample| sample.route.as_str())
                .collect::<Vec<_>>(),
            ["management", "vpn", "browser"]
        );
        assert_eq!(samples[0].status, "ok");
        assert_eq!(samples[1].error_code.as_deref(), Some("proxy_disabled"));
        assert_eq!(samples[2].error_code.as_deref(), Some("cdp_unavailable"));
    }

    #[tokio::test]
    async fn worker_emits_browser_closed_on_the_round_after_cdp_closes() {
        let management_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let management_address = management_listener.local_addr().unwrap();
        let management_server = tokio::spawn(async move {
            let mut served = 0;
            while served < 2 {
                let (mut stream, _) = management_listener.accept().await.unwrap();
                if crate::httpio::read_head(&mut stream).await.is_err() {
                    continue;
                }
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
                    )
                    .await
                    .unwrap();
                served += 1;
            }
        });

        let cdp_listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let cdp_endpoint = crate::browser::DevToolsEndpoint {
            port: cdp_listener.local_addr().unwrap().port(),
            browser_path: "/devtools/browser/network-test".into(),
        };
        let cdp_server = tokio::spawn(async move {
            let mut served = 0;
            while served < 2 {
                let (stream, _) = cdp_listener.accept().await.unwrap();
                let Ok(mut socket) = accept_async(stream).await else {
                    continue;
                };
                if socket.next().await.is_none() {
                    continue;
                }
                if served == 1 {
                    socket.send(Message::Close(None)).await.unwrap();
                } else {
                    if socket
                        .send(Message::Text(r#"{"id":1,"result":{}}"#.into()))
                        .await
                        .is_err()
                    {
                        continue;
                    }
                }
                served += 1;
            }
        });

        let browsers = BrowserSessionManager::default();
        browsers.insert_test_session(7, Some(cdp_endpoint));
        browsers.note_browser_activity(7, 701, false);
        let api = format!("http://{management_address}");
        let collect: CollectHook = Arc::new({
            let browsers = browsers.clone();
            move || {
                let browsers = browsers.clone();
                let api = api.clone();
                Box::pin(async move { collect_samples(&api, &browsers).await })
            }
        });
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let emitted_once = Arc::new(Notify::new());
        let emit: EmitHook = Arc::new({
            let emitted = Arc::clone(&emitted);
            let emitted_once = Arc::clone(&emitted_once);
            move |snapshot| {
                emitted.lock().expect("事件锁已中毒").push(snapshot.clone());
                emitted_once.notify_one();
            }
        });
        let hooks = WorkerHooks {
            collect,
            report: Arc::new(|_| {
                Box::pin(async { Ok(()) }) as WorkerFuture<Result<(), ReportFailure>>
            }),
            emit,
        };
        let monitor = NetworkMonitor::default();
        let handle = monitor
            .start_test_worker(31, hooks, INTERVAL, RETRY_DELAYS)
            .expect("worker should start");
        emitted_once.notified().await;
        monitor.wake();
        emitted_once.notified().await;
        monitor.stop();
        handle.await.unwrap();
        management_server.await.unwrap();
        cdp_server.await.unwrap();

        let emitted = emitted.lock().expect("事件锁已中毒");
        assert_eq!(emitted.len(), 2);
        assert_eq!(
            emitted[0]
                .samples
                .iter()
                .find(|sample| sample.route == "browser")
                .and_then(|sample| sample.error_code.as_deref()),
            None
        );
        let browser = emitted[1]
            .samples
            .iter()
            .find(|sample| sample.route == "browser")
            .expect("browser sample should be emitted");
        assert_eq!(browser.error_code.as_deref(), Some("browser_closed"));
        assert_eq!(browser.browser_id.as_deref(), Some("7"));
        assert_eq!(browser.platform_id.as_deref(), Some("701"));
        assert_eq!(browser.network_mode, "proxy");
    }

    #[tokio::test]
    async fn recent_activity_hook_selects_latest_browser_for_browser_sample() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = crate::httpio::read_head(&mut stream).await.unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
        });
        let browsers = BrowserSessionManager::default();
        browsers.insert_test_session(7, None);
        browsers.insert_test_session(8, None);
        browsers.note_browser_activity(7, 701, true);
        std::thread::sleep(Duration::from_millis(2));
        browsers.note_browser_activity(8, 801, false);
        let samples = collect_samples(&format!("http://{address}"), &browsers).await;
        server.await.unwrap();
        assert_eq!(samples[2].browser_id.as_deref(), Some("8"));
        assert_eq!(samples[2].platform_id.as_deref(), Some("801"));
        assert_eq!(samples[2].network_mode, "proxy");
        assert_eq!(browsers.recent_sessions()[0].browser_id, 8);
    }

    #[tokio::test(start_paused = true)]
    async fn stale_generation_stops_old_worker_and_allows_new_generation_to_start() {
        let monitor = NetworkMonitor::default();
        let old_calls = Arc::new(AtomicUsize::new(0));
        let old_started = Arc::new(Notify::new());
        let release_old = Arc::new(Notify::new());
        let old_collect: CollectHook = Arc::new({
            let old_calls = Arc::clone(&old_calls);
            let old_started = Arc::clone(&old_started);
            let release_old = Arc::clone(&release_old);
            move || {
                old_calls.fetch_add(1, Ordering::SeqCst);
                let old_started = Arc::clone(&old_started);
                let release_old = Arc::clone(&release_old);
                Box::pin(async move {
                    old_started.notify_one();
                    release_old.notified().await;
                    vec![sample(1)]
                }) as WorkerFuture<Vec<NetworkSample>>
            }
        });
        let old_emitted = Arc::new(Mutex::new(Vec::new()));
        let old_hooks = WorkerHooks {
            collect: old_collect,
            report: Arc::new(|_| {
                Box::pin(async { Ok(()) }) as WorkerFuture<Result<(), ReportFailure>>
            }),
            emit: {
                let old_emitted = Arc::clone(&old_emitted);
                Arc::new(move |snapshot| old_emitted.lock().unwrap().push(snapshot.clone()))
            },
        };
        let old_handle = monitor
            .start_test_worker(21, old_hooks, Duration::from_secs(60), RETRY_DELAYS)
            .unwrap();
        old_started.notified().await;

        let new_calls = Arc::new(AtomicUsize::new(0));
        let new_emitted = Arc::new(Mutex::new(Vec::new()));
        let new_results = Arc::new(Mutex::new(VecDeque::from([Err(
            ReportFailure::SessionChanged,
        )])));
        let new_hooks = hooks(
            Arc::clone(&new_calls),
            Arc::new(Mutex::new(Vec::new())),
            new_results,
            Arc::clone(&new_emitted),
        );
        let new_handle = monitor
            .start_test_worker(22, new_hooks, Duration::from_secs(60), RETRY_DELAYS)
            .unwrap();
        wait_for_calls(&new_calls, 1).await;
        release_old.notify_one();
        old_handle.await.unwrap();
        new_handle.await.unwrap();
        assert!(
            old_emitted.lock().unwrap().is_empty(),
            "old generation must not emit a sample"
        );
        assert_eq!(new_emitted.lock().unwrap().len(), 1);
        assert_eq!(monitor.queue_len(), 1, "stale auth keeps the unsent report");

        let recovery_calls = Arc::new(AtomicUsize::new(0));
        let recovery_hooks = hooks(
            Arc::clone(&recovery_calls),
            Arc::new(Mutex::new(Vec::new())),
            Arc::new(Mutex::new(VecDeque::new())),
            Arc::new(Mutex::new(Vec::new())),
        );
        let recovery_handle = monitor
            .start_test_worker(23, recovery_hooks, Duration::from_secs(60), RETRY_DELAYS)
            .expect("a new generation can restart after stale auth");
        wait_for_calls(&recovery_calls, 1).await;
        monitor.stop();
        recovery_handle.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn retry_backoff_waits_and_cancellation_retains_failed_report() {
        let monitor = NetworkMonitor::default();
        monitor.enqueue(report(0));
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempt_hook: ReportHook = Arc::new({
            let attempts = Arc::clone(&attempts);
            move |_| {
                attempts.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Err(ReportFailure::Retryable) })
                    as WorkerFuture<Result<(), ReportFailure>>
            }
        });
        let (_stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        let flushing = tokio::spawn({
            let monitor = monitor.clone();
            async move {
                flush_queue_with(
                    &monitor,
                    &attempt_hook,
                    &mut stop_rx,
                    [
                        Duration::from_secs(5),
                        Duration::from_secs(30),
                        Duration::from_secs(120),
                    ],
                )
                .await
            }
        });
        wait_for_calls(&attempts, 1).await;
        tokio::time::advance(Duration::from_secs(4)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        wait_for_calls(&attempts, 2).await;
        assert_eq!(monitor.queue_len(), 1);
        let _ = _stop_tx.send(true);
        assert!(
            flushing.await.unwrap(),
            "cancellation should stop retry loop"
        );
        assert_eq!(monitor.queue_len(), 1, "failed report must be retained");
    }

    #[tokio::test(start_paused = true)]
    async fn retry_backoff_progresses_through_five_thirty_and_one_twenty_second_boundaries() {
        let monitor = NetworkMonitor::default();
        monitor.enqueue(report(0));
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempt_hook: ReportHook = Arc::new({
            let attempts = Arc::clone(&attempts);
            move |_| {
                attempts.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Err(ReportFailure::Retryable) })
                    as WorkerFuture<Result<(), ReportFailure>>
            }
        });
        let (_stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        let flushing = tokio::spawn({
            let monitor = monitor.clone();
            async move {
                flush_queue_with(
                    &monitor,
                    &attempt_hook,
                    &mut stop_rx,
                    [
                        Duration::from_secs(5),
                        Duration::from_secs(30),
                        Duration::from_secs(120),
                    ],
                )
                .await
            }
        });

        wait_for_calls(&attempts, 1).await;
        tokio::time::advance(Duration::from_secs(4)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(1)).await;
        wait_for_calls(&attempts, 2).await;

        tokio::time::advance(Duration::from_secs(29)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_secs(1)).await;
        wait_for_calls(&attempts, 3).await;

        tokio::time::advance(Duration::from_secs(119)).await;
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        tokio::time::advance(Duration::from_secs(1)).await;
        wait_for_calls(&attempts, 4).await;

        assert!(!flushing.await.unwrap(), "retry budget should be exhausted");
        assert_eq!(monitor.queue_len(), 1, "failed report must be retained");
        assert_eq!(attempts.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn successful_flush_deletes_report_and_queue_keeps_latest_120() {
        let monitor = NetworkMonitor::default();
        for id in 0..=120 {
            monitor.enqueue(report(id));
        }
        let queued = monitor.queued_reports();
        assert_eq!(queued.len(), 120);
        assert_eq!(queued[0].samples[0].sample_id, "sample-1");
        let sent = Arc::new(Mutex::new(Vec::new()));
        let report_hook: ReportHook = Arc::new({
            let sent = Arc::clone(&sent);
            move |payload| {
                sent.lock().unwrap().push(payload);
                Box::pin(async { Ok(()) }) as WorkerFuture<Result<(), ReportFailure>>
            }
        });
        let (_stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        assert!(!flush_queue_with(&monitor, &report_hook, &mut stop_rx, [Duration::ZERO; 3]).await);
        assert!(monitor.queue_len() == 0);
        assert_eq!(sent.lock().unwrap().len(), 120);
    }
}
