//! Periodic, bounded network diagnostics for the desktop client.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Runtime};

use crate::auth::DesktopAuthState;
use crate::browser::BrowserSessionManager;
use crate::device;
use crate::network_diagnostics::{measure_browser_cdp, measure_management, NetworkDiagnosticsReport, NetworkDiagnosticsSnapshot, NetworkSample};
use crate::state::AppState;
use super::{auth_command_error, require_desktop_auth, CmdResult, CommandError};

const INTERVAL: Duration = Duration::from_secs(60);
const MAX_QUEUE: usize = 120;

#[derive(Clone)]
pub struct NetworkMonitor {
    inner: Arc<MonitorInner>,
}

struct MonitorInner {
    state: Mutex<MonitorState>,
}

struct MonitorState {
    running: bool,
    generation: u64,
    stop: Option<tokio::sync::watch::Sender<bool>>,
    latest: NetworkDiagnosticsSnapshot,
    queue: VecDeque<NetworkDiagnosticsReport>,
}

impl Default for NetworkMonitor {
    fn default() -> Self {
        Self { inner: Arc::new(MonitorInner { state: Mutex::new(MonitorState {
            running: false, generation: 0, stop: None,
            latest: NetworkDiagnosticsSnapshot { samples: Vec::new(), device_id: device::wire_device_id() },
            queue: VecDeque::new(),
        }) }) }
    }
}

impl NetworkMonitor {
    pub fn snapshot(&self) -> NetworkDiagnosticsSnapshot {
        self.inner.state.lock().expect("网络监控锁已中毒").latest.clone()
    }

    pub fn stop(&self) {
        let mut state = self.inner.state.lock().expect("网络监控锁已中毒");
        state.running = false;
        state.generation = state.generation.wrapping_add(1).max(1);
        if let Some(stop) = state.stop.take() { let _ = stop.send(true); }
    }

    fn start<R: Runtime>(&self, app: AppHandle<R>, auth: DesktopAuthState, browsers: BrowserSessionManager, owner: (i64, String, u64), api: String) -> CmdResult<()> {
        let (user_id, profile_key, generation) = owner;
        let mut state = self.inner.state.lock().expect("网络监控锁已中毒");
        if state.running { return Ok(()); }
        state.running = true;
        state.generation = generation;
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        state.stop = Some(stop_tx);
        let monitor = self.clone();
        crate::rt::runtime().spawn(async move {
            let mut first = true;
            loop {
                if !first {
                    tokio::select! { _ = tokio::time::sleep(INTERVAL) => {}, changed = stop_rx.changed() => { if changed.is_err() || *stop_rx.borrow() { break; } } }
                }
                first = false;
                if *stop_rx.borrow() { break; }
                let samples = collect_samples(&api, &browsers).await;
                let snapshot = NetworkDiagnosticsSnapshot { samples, device_id: device::wire_device_id() };
                {
                    let mut state = monitor.inner.state.lock().expect("网络监控锁已中毒");
                    if state.generation != generation || !state.running { break; }
                    state.latest = snapshot.clone();
                    state.queue.push_back(snapshot.clone().report());
                    while state.queue.len() > MAX_QUEUE { state.queue.pop_front(); }
                }
                let _ = app.emit("network-diagnostics-changed", &snapshot);
                if flush_queue(&monitor, &auth, user_id, &profile_key, generation).await { break; }
            }
        });
        Ok(())
    }
}

async fn collect_samples(api: &str, browsers: &BrowserSessionManager) -> Vec<NetworkSample> {
    let mut samples = vec![measure_management(&format!("{api}/api/product")).await];
    if let Some(browser) = browsers.recent_sessions().into_iter().next() {
        let mut sample = measure_browser_cdp(browser.endpoint.as_ref()).await;
        sample.platform_id = Some(browser.platform_id.to_string());
        sample.browser_id = Some(browser.browser_id.to_string());
        sample.network_mode = if browser.direct_mode { "direct" } else { "proxy" }.into();
        samples.push(sample);
    }
    samples
}

/// Returns true when the owner session changed and the worker must terminate.
async fn flush_queue(monitor: &NetworkMonitor, auth: &DesktopAuthState, user: i64, profile: &str, generation: u64) -> bool {
    loop {
        let report = { monitor.inner.state.lock().ok().and_then(|state| state.queue.front().cloned()) };
        let Some(report) = report else { return false; };
        if let Err(error) = auth.report_network_diagnostics(user, profile, generation, &report).await {
            return matches!(error.code.as_str(), "session_changed" | "unauthenticated");
        }
        if let Ok(mut state) = monitor.inner.state.lock() { state.queue.pop_front(); }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn get_network_diagnostics(monitor: tauri::State<'_, NetworkMonitor>, auth: tauri::State<'_, DesktopAuthState>) -> CmdResult<NetworkDiagnosticsSnapshot> {
    require_desktop_auth(&auth)?;
    Ok(monitor.snapshot())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn start_network_diagnostics<R: Runtime>(app: AppHandle<R>, monitor: tauri::State<'_, NetworkMonitor>, auth: tauri::State<'_, DesktopAuthState>, browsers: tauri::State<'_, BrowserSessionManager>, _state: tauri::State<'_, AppState>) -> CmdResult<()> {
    require_desktop_auth(&auth)?;
    let (user, profile, generation) = auth.current_identity().map_err(auth_command_error)?;
    let profile = profile.ok_or_else(|| CommandError::new("请先同步桌面配置", "not_ready"))?;
    let api = auth.api_base_url().map_err(auth_command_error)?.to_string();
    monitor.start(app, (*auth).clone(), (*browsers).clone(), (user, profile, generation), api)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn stop_network_diagnostics(monitor: tauri::State<'_, NetworkMonitor>, auth: tauri::State<'_, DesktopAuthState>) -> CmdResult<()> {
    require_desktop_auth(&auth)?;
    monitor.stop();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn queue_is_bounded() {
        let monitor = NetworkMonitor::default();
        let mut state = monitor.inner.state.lock().unwrap();
        for _ in 0..150 { state.queue.push_back(NetworkDiagnosticsReport { protocol_version: 1, samples: vec![], device_id: None }); while state.queue.len() > MAX_QUEUE { state.queue.pop_front(); } }
        assert_eq!(state.queue.len(), MAX_QUEUE);
    }
    #[test] fn stop_invalidates_generation() { let monitor = NetworkMonitor::default(); let before = monitor.inner.state.lock().unwrap().generation; monitor.stop(); assert_ne!(before, monitor.inner.state.lock().unwrap().generation); }
}
