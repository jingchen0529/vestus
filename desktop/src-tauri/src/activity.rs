//! Browser activity is committed locally before delivery. Staged observations are
//! atomically converted into immutable v2 batches; only a matching server ACK
//! removes a batch. Account-scoped queues survive offline exits and app upgrades.
//! CDP events not yet delivered to this process, and disk/quota failures, remain
//! explicit limits to durability. No credential is stored in the queue.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::auth::DesktopAuthState;
use crate::browser::DevToolsEndpoint;
use crate::cdp::{self, FormSnapshot, PageReport};
use crate::rt;

/// 后台检查持久队列的间隔，采集事件落盘不等待此定时器。
const FLUSH_INTERVAL: Duration = Duration::from_secs(30);

/// 上报失败后的退避。第 n 次重试等 `RETRY_BACKOFF * n`，上限 `MAX_RETRY_BACKOFF`。
const RETRY_BACKOFF: Duration = Duration::from_secs(10);
const MAX_RETRY_BACKOFF: Duration = Duration::from_secs(300);

/// 聚合表里最多留多少个地址。到顶之后新地址就丢——一次会话逛出几百个不同页面已经
/// 不正常，而无上限的表会让一个跑循环的页面把内存吃光。
///
/// 这个值同时是**一次请求最多带多少个地址**：满表会一次全发出去。所以它必须和后端
/// `app/schemas/browser_activity.py` 里的 `MAX_PAGES_PER_REPORT` 相等，否则上报会
/// 被服务端整批拒掉。
const MAX_TRACKED_PAGES: usize = 500;

/// 后端 `BrowserActivityReport` 请求体的最大字节数（4 MiB）。快照大小会让同样
/// 页数的 JSON 体积相差几个数量级，因此每批按实际序列化长度分割。
const MAX_ACTIVITY_REPORT_BYTES: usize = 4 * 1024 * 1024;

/// 关应用时等待采集事件提交本地队列的上限，不等待网络上传。
const SHUTDOWN_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

/// 随每批上报一起发的客户端版本号，由 `build.rs` 从 `tauri.conf.json` 读出。
///
/// 不用 `CARGO_PKG_VERSION`：发布流水线只把版本号写进 `tauri.conf.json`，
/// `Cargo.toml` 的 `version` 不参与打包命名也不随标签变动，用它会让每个版本
/// 都报同一个数字。
const CLIENT_VERSION: &str = env!("VESTUS_CLIENT_VERSION");

/// 一次浏览器会话的身份。`browser_id` 由 [`crate::state`] 分配，同一进程唯一。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionKey {
    pub browser_id: u64,
    pub platform_id: i64,
    pub direct_mode: bool,
}

impl SessionKey {
    /// 这次会话在服务端的去重键。
    ///
    /// 一次会话会分多批上报，服务端要能把它们落到同一行，所以必须有一个跨批次稳定
    /// 的标识。`browser_id` 只在单个桌面端进程里唯一——重启就从头再来——所以再拼上
    /// 启动时刻的纳秒和进程号。服务端的唯一约束是 `(user_id, session_key)`，于是
    /// 这个值只需要在一个用户内唯一，不需要全局唯一，也就不必引入随机数依赖。
    fn wire_key(&self) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos() as u64)
            .unwrap_or(0);
        format!(
            "{nanos:016x}{:08x}{:08x}",
            std::process::id(),
            self.browser_id as u32
        )
    }
}

/// 一批上报的线格式。字段名与后端 `BrowserActivityReport` 一一对应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityReport {
    /// 这次会话的去重键，见 [`SessionKey::wire_key`]。同一次会话的每一批都相同。
    session_key: String,
    browser_id: u64,
    platform_id: i64,
    direct_mode: bool,
    client_version: String,
    /// 操作系统暴露的机器标识。读不到时为 None，服务端按可空处理——采集失败
    /// 绝不能让上报失败。见 [`crate::device`]。
    device_id: Option<String>,
    /// 客户端本机时钟的毫秒时间戳。服务端不信这个值，只用它排序并夹到「现在」，
    /// 记录时间仍由服务端自己盖。
    reported_at_ms: u64,
    /// 因为聚合表满了而没能记下的地址数。唯一能告诉运维「这次会话的数据不全」
    /// 的信号，所以跟着上报一起走。
    dropped_pages: u64,
    pages: Vec<PageRow>,
}

/// 一个地址在这一批里的增量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageRow {
    url: String,
    url_params: Option<String>,
    visits: u32,
    clicks: u32,
    inputs: u32,
    submits: u32,
    scrolls: u32,
    dwell_ms: u64,
    first_seen_at_ms: u64,
    last_seen_at_ms: u64,
    input_snapshot: Option<FormSnapshot>,
    input_snapshot_at_ms: u64,
    submit_snapshot: Option<FormSnapshot>,
    submit_snapshot_at_ms: u64,
}

/// 按地址合并的待上报增量。
///
/// 用 `BTreeMap` 而不是 `HashMap`：顺序稳定，于是上报体是确定的，测试也好断言。
#[derive(Debug, Default)]
struct Aggregate {
    pages: BTreeMap<(String, Option<String>), PageRow>,
    /// 因为到了 [`MAX_TRACKED_PAGES`] 而被丢掉的地址数，只用于判断表是否溢出过。
    dropped: u64,
}

impl Aggregate {
    fn absorb(&mut self, report: PageReport, now_ms: u64) {
        let PageReport {
            url,
            url_params,
            visits,
            clicks,
            inputs,
            submits,
            scrolls,
            dwell_ms,
            input_snapshot,
            submit_snapshot,
            ..
        } = report;
        let key = (url.clone(), url_params.clone());
        let row = match self.pages.get_mut(&key) {
            Some(row) => row,
            None => {
                if self.pages.len() >= MAX_TRACKED_PAGES {
                    self.dropped = self.dropped.saturating_add(1);
                    return;
                }
                self.pages.entry(key).or_insert_with(|| PageRow {
                    url,
                    url_params,
                    visits: 0,
                    clicks: 0,
                    inputs: 0,
                    submits: 0,
                    scrolls: 0,
                    dwell_ms: 0,
                    first_seen_at_ms: now_ms,
                    last_seen_at_ms: now_ms,
                    input_snapshot: None,
                    input_snapshot_at_ms: 0,
                    submit_snapshot: None,
                    submit_snapshot_at_ms: 0,
                })
            }
        };
        row.visits = row.visits.saturating_add(visits);
        row.clicks = row.clicks.saturating_add(clicks);
        row.inputs = row.inputs.saturating_add(inputs);
        row.submits = row.submits.saturating_add(submits);
        row.scrolls = row.scrolls.saturating_add(scrolls);
        row.dwell_ms = row.dwell_ms.saturating_add(dwell_ms);
        if input_snapshot.is_some()
            && (row.input_snapshot.is_none() || now_ms > row.input_snapshot_at_ms)
        {
            row.input_snapshot = input_snapshot;
            row.input_snapshot_at_ms = now_ms;
        }
        if submit_snapshot.is_some()
            && (row.submit_snapshot.is_none() || now_ms > row.submit_snapshot_at_ms)
        {
            row.submit_snapshot = submit_snapshot;
            row.submit_snapshot_at_ms = now_ms;
        }
        row.last_seen_at_ms = now_ms;
    }

    fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }

    fn take(&mut self) -> Vec<PageRow> {
        std::mem::take(&mut self.pages).into_values().collect()
    }

    /// 上报失败时把这一批合回来，等下一次连着新增量一起发。
    ///
    /// 合回来的行可能和期间新攒的行撞上同一个地址，所以只能相加、不能覆盖——覆盖
    /// 就会丢掉退避期间的操作。
    fn merge_back(&mut self, rows: Vec<PageRow>) {
        for row in rows {
            let full = self.pages.len() >= MAX_TRACKED_PAGES;
            let key = (row.url.clone(), row.url_params.clone());
            match self.pages.get_mut(&key) {
                Some(existing) => {
                    existing.visits = existing.visits.saturating_add(row.visits);
                    existing.clicks = existing.clicks.saturating_add(row.clicks);
                    existing.inputs = existing.inputs.saturating_add(row.inputs);
                    existing.submits = existing.submits.saturating_add(row.submits);
                    existing.scrolls = existing.scrolls.saturating_add(row.scrolls);
                    existing.dwell_ms = existing.dwell_ms.saturating_add(row.dwell_ms);
                    existing.first_seen_at_ms = existing.first_seen_at_ms.min(row.first_seen_at_ms);
                    existing.last_seen_at_ms = existing.last_seen_at_ms.max(row.last_seen_at_ms);
                    if row.input_snapshot.is_some()
                        && (existing.input_snapshot.is_none()
                            || row.input_snapshot_at_ms > existing.input_snapshot_at_ms)
                    {
                        existing.input_snapshot = row.input_snapshot;
                        existing.input_snapshot_at_ms = row.input_snapshot_at_ms;
                    }
                    if row.submit_snapshot.is_some()
                        && (existing.submit_snapshot.is_none()
                            || row.submit_snapshot_at_ms > existing.submit_snapshot_at_ms)
                    {
                        existing.submit_snapshot = row.submit_snapshot;
                        existing.submit_snapshot_at_ms = row.submit_snapshot_at_ms;
                    }
                }
                None if full => self.dropped = self.dropped.saturating_add(1),
                None => {
                    self.pages.insert(key, row);
                }
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// The owner is captured while opening the browser, before asynchronous CDP startup.
/// Queue namespaces are stable across app upgrades and separate servers and users.
#[derive(Debug, Clone)]
pub(crate) struct ActivityOwner {
    user_id: i64,
    profile_key: String,
    namespace: String,
}

impl ActivityOwner {
    pub(crate) fn new(api_base: &str, profile_key: &str, user_id: i64) -> Self {
        use sha2::{Digest, Sha256};
        let encoded = serde_json::to_vec(&("activity-owner/v1", api_base, profile_key, user_id))
            .expect("owner identity serializes");
        Self {
            user_id,
            profile_key: profile_key.to_owned(),
            namespace: format!("{:x}", Sha256::digest(encoded)),
        }
    }

    fn current(auth: &DesktopAuthState) -> Option<Self> {
        let (user_id, profile_key, _) = auth.current_identity().ok()?;
        Some(Self::new(
            auth.api_base_url().ok()?,
            profile_key.as_deref()?,
            user_id,
        ))
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReliableReport {
    protocol_version: u32,
    owner_user_id: i64,
    batch_id: String,
    #[serde(flatten)]
    report: ActivityReport,
}

/// Durable staging is separate from upload: network timeouts cannot stop recording.
#[derive(Clone, Default)]
pub struct ActivityCollector {
    sessions: Arc<Mutex<Vec<JoinHandle<()>>>>,
    outbox: Arc<std::sync::OnceLock<Arc<crate::activity_outbox::ActivityOutbox>>>,
    wake: Arc<tokio::sync::Notify>,
}

impl ActivityCollector {
    pub fn initialize(&self, root: &std::path::Path, auth: DesktopAuthState) {
        let outbox = match crate::activity_outbox::ActivityOutbox::open(root) {
            Ok(outbox) => Arc::new(outbox),
            Err(error) => {
                eprintln!("activity queue unavailable, existing data retained: {error}");
                return;
            }
        };
        if self.outbox.set(outbox.clone()).is_err() {
            return;
        }
        let wake = self.wake.clone();
        rt::runtime().spawn(async move {
            let mut failures = 0u32;
            loop {
                if let Some(owner) = ActivityOwner::current(&auth) {
                    match deliver_pending(outbox.clone(), &owner, &auth).await {
                        Ok(()) => failures = 0,
                        Err(error) => {
                            failures = failures.saturating_add(1);
                            eprintln!("activity delivery deferred; queued data retained: {error}");
                        }
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(next_delay(failures)) => {},
                    _ = wake.notified() => {},
                }
            }
        });
    }

    pub(crate) fn start(&self, key: SessionKey, endpoint: DevToolsEndpoint, owner: ActivityOwner) {
        let Some(outbox) = self.outbox.get().cloned() else {
            eprintln!("activity collection unavailable: durable queue was not initialized");
            return;
        };
        let (sender, mut receiver) = mpsc::unbounded_channel();
        rt::runtime().spawn(async move {
            if let Err(error) = cdp::collect(endpoint, sender).await {
                eprintln!("activity collection stopped: {error}");
            }
        });
        let session_key = key.wire_key();
        let wake = self.wake.clone();
        let capture = rt::runtime().spawn(async move {
            while let Some(event) = receiver.recv().await {
                let mut aggregate = Aggregate::default();
                let time = now_ms();
                aggregate.absorb(event, time);
                if aggregate.is_empty() {
                    continue;
                }
                let report = activity_report(
                    &key,
                    &session_key,
                    time,
                    aggregate.dropped,
                    aggregate.take(),
                );
                let payload = serde_json::to_value(report).expect("activity report serializes");
                let queue = outbox.clone();
                let namespace = owner.namespace.clone();
                let result = rt::runtime()
                    .spawn_blocking(move || queue.stage(&namespace, &payload))
                    .await;
                if !matches!(result, Ok(Ok(()))) {
                    // Disk/quota failures cannot be made durable; make the loss explicit and
                    // try subsequent events again, without deleting any queued observations.
                    eprintln!("activity observation could not be persisted: {result:?}");
                }
            }
            wake.notify_one();
        });
        let mut sessions = self.sessions.lock().expect("活动采集锁已中毒");
        sessions.retain(|task| !task.is_finished());
        sessions.push(capture);
    }

    /// Browser shutdown ends CDP first; wait for remaining observations to reach disk.
    /// Upload is independent and may continue after the next login/restart.
    pub fn shutdown(&self) {
        let handles = std::mem::take(&mut *self.sessions.lock().expect("活动采集锁已中毒"));
        if handles.is_empty() {
            return;
        }
        let completed =
            rt::runtime().block_on(tokio::time::timeout(SHUTDOWN_FLUSH_TIMEOUT, async move {
                for handle in handles {
                    let _ = handle.await;
                }
            }));
        if completed.is_err() {
            eprintln!("activity shutdown deadline reached; committed queue is retained, unprocessed CDP events may be lost");
        }
    }
}

/// The database transaction commits staged -> immutable batches together. IDs and
/// payloads are never regenerated after an uncertain HTTP result.
fn build_ready_reports(
    values: Vec<serde_json::Value>,
    owner_id: i64,
) -> Result<Vec<serde_json::Value>, String> {
    let mut groups: BTreeMap<String, (ActivityReport, Aggregate)> = BTreeMap::new();
    for value in values {
        let report: ActivityReport =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        let entry = groups
            .entry(report.session_key.clone())
            .or_insert_with(|| (report.clone(), Aggregate::default()));
        entry.0.reported_at_ms = entry.0.reported_at_ms.max(report.reported_at_ms);
        entry.1.dropped = entry.1.dropped.max(report.dropped_pages);
        entry.1.merge_back(report.pages);
    }
    let mut ready = Vec::new();
    for (_, (original, mut aggregate)) in groups {
        let mut template = original;
        template.dropped_pages = aggregate.dropped;
        template.pages.clear();
        // Measure the actual persisted metadata, including versions from an older
        // client, and reserve the exact v2 envelope size before packing pages.
        let empty_wire = serde_json::to_vec(&ReliableReport {
            protocol_version: 2,
            owner_user_id: owner_id,
            batch_id: "0".repeat(64),
            report: template.clone(),
        })
        .map_err(|error| error.to_string())?
        .len();
        let empty_report = serde_json::to_vec(&template)
            .map_err(|error| error.to_string())?
            .len();
        let overhead = empty_wire - empty_report;
        let rows = aggregate
            .take()
            .into_iter()
            .flat_map(split_page_counters)
            .collect();
        let chunks = split_report_rows(&template, rows, MAX_ACTIVITY_REPORT_BYTES - overhead)
            .map_err(|_| "an activity page exceeds the upload size limit".to_string())?;
        for report in chunks {
            let mut random = [0u8; 32];
            getrandom::getrandom(&mut random).map_err(|error| error.to_string())?;
            let batch_id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let value = serde_json::to_value(ReliableReport {
                protocol_version: 2,
                owner_user_id: owner_id,
                batch_id,
                report,
            })
            .map_err(|error| error.to_string())?;
            if serde_json::to_vec(&value)
                .map_err(|error| error.to_string())?
                .len()
                > MAX_ACTIVITY_REPORT_BYTES
            {
                return Err("activity batch exceeds the upload size limit".into());
            }
            ready.push(value);
        }
    }
    Ok(ready)
}

async fn deliver_pending(
    outbox: Arc<crate::activity_outbox::ActivityOutbox>,
    owner: &ActivityOwner,
    auth: &DesktopAuthState,
) -> Result<(), String> {
    deliver_with_sender(outbox, owner, |payload| async move {
        let batch_id = payload["batchId"].as_str().ok_or("missing batchId")?;
        auth.report_browser_activity(owner.user_id, &owner.profile_key, batch_id, &payload)
            .await
            .map_err(|error| format!("{}: {}", error.code, error.message))
    })
    .await
}

async fn deliver_with_sender<F, Fut>(
    outbox: Arc<crate::activity_outbox::ActivityOutbox>,
    owner: &ActivityOwner,
    mut send: F,
) -> Result<(), String>
where
    F: FnMut(serde_json::Value) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    // Bound each pass so a huge recovered backlog does not monopolize the worker.
    for _ in 0..64 {
        let queue = outbox.clone();
        let namespace = owner.namespace.clone();
        let user_id = owner.user_id;
        let payload = rt::runtime()
            .spawn_blocking(move || {
                if let Some(ready) = queue.next(&namespace)? {
                    return Ok::<_, crate::activity_outbox::OutboxError>(Some(ready));
                }
                queue.prepare(&namespace, |values| build_ready_reports(values, user_id))?;
                queue.next(&namespace)
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
        let Some(payload) = payload else {
            return Ok(());
        };
        let report: ReliableReport =
            serde_json::from_value(payload.clone()).map_err(|error| error.to_string())?;
        if report.protocol_version != 2 || report.owner_user_id != owner.user_id {
            return Err("unsupported queue payload or owner mismatch".into());
        }
        send(payload).await?;
        let queue = outbox.clone();
        let namespace = owner.namespace.clone();
        rt::runtime()
            .spawn_blocking(move || queue.acknowledge(&namespace, &report.batch_id))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Partition increments without clamping their total. Snapshots belong only to
/// the final part, with their original timestamps, so older parts cannot replace
/// the latest captured form when the server receives batches in another order.
fn split_page_counters(mut row: PageRow) -> Vec<PageRow> {
    const MAX_COUNT: u32 = 1_000_000;
    const MAX_DWELL: u64 = 24 * 60 * 60 * 1000;
    let mut parts = Vec::new();
    loop {
        let mut part = row.clone();
        part.visits = row.visits.min(MAX_COUNT);
        part.clicks = row.clicks.min(MAX_COUNT);
        part.inputs = row.inputs.min(MAX_COUNT);
        part.submits = row.submits.min(MAX_COUNT);
        part.scrolls = row.scrolls.min(MAX_COUNT);
        part.dwell_ms = row.dwell_ms.min(MAX_DWELL);
        row.visits -= part.visits;
        row.clicks -= part.clicks;
        row.inputs -= part.inputs;
        row.submits -= part.submits;
        row.scrolls -= part.scrolls;
        row.dwell_ms -= part.dwell_ms;
        let remaining = row.visits > 0
            || row.clicks > 0
            || row.inputs > 0
            || row.submits > 0
            || row.scrolls > 0
            || row.dwell_ms > 0;
        if remaining {
            part.input_snapshot = None;
            part.input_snapshot_at_ms = 0;
            part.submit_snapshot = None;
            part.submit_snapshot_at_ms = 0;
        }
        parts.push(part);
        if !remaining {
            break;
        }
    }
    parts
}

#[cfg(test)]
fn split_activity_reports(
    key: &SessionKey,
    session_key: &str,
    reported_at_ms: u64,
    dropped_pages: u64,
    rows: Vec<PageRow>,
) -> Result<Vec<ActivityReport>, Vec<PageRow>> {
    let template = activity_report(key, session_key, reported_at_ms, dropped_pages, Vec::new());
    split_report_rows(&template, rows, MAX_ACTIVITY_REPORT_BYTES)
}

fn split_report_rows(
    template: &ActivityReport,
    rows: Vec<PageRow>,
    byte_limit: usize,
) -> Result<Vec<ActivityReport>, Vec<PageRow>> {
    let base_len = serde_json::to_vec(template)
        .expect("ActivityReport 必须可序列化")
        .len();
    let mut reports = Vec::new();
    let mut pages: Vec<PageRow> = Vec::new();
    let mut page_bytes = 0;
    let mut rows = rows.into_iter();
    while let Some(row) = rows.next() {
        let row_len = serde_json::to_vec(&row)
            .expect("PageRow 必须可序列化")
            .len();
        let candidate_len = wire_len(base_len, page_bytes, pages.len(), row_len);
        // Keep each URL increment in a separate batch when a counter was split.
        // The server can therefore apply every bounded increment independently.
        let duplicate = pages
            .iter()
            .any(|page| page.url == row.url && page.url_params == row.url_params);
        if candidate_len <= byte_limit && pages.len() < MAX_TRACKED_PAGES && !duplicate {
            page_bytes = if pages.is_empty() {
                row_len
            } else {
                page_bytes + 1 + row_len
            };
            pages.push(row);
            continue;
        }
        if pages.is_empty() {
            return Err(restore_rows(reports, pages, row, rows));
        }
        let mut report = template.clone();
        report.pages = std::mem::take(&mut pages);
        reports.push(report);
        if wire_len(base_len, 0, 0, row_len) > byte_limit {
            return Err(restore_rows(reports, pages, row, rows));
        }
        page_bytes = row_len;
        pages.push(row);
    }
    if !pages.is_empty() {
        let mut report = template.clone();
        report.pages = pages;
        reports.push(report);
    }
    Ok(reports)
}

fn wire_len(base_len: usize, page_bytes: usize, page_count: usize, next_row_len: usize) -> usize {
    base_len + page_bytes + usize::from(page_count > 0) + next_row_len
}

fn restore_rows(
    reports: Vec<ActivityReport>,
    mut pages: Vec<PageRow>,
    row: PageRow,
    remaining: impl Iterator<Item = PageRow>,
) -> Vec<PageRow> {
    let mut restored = reports
        .into_iter()
        .flat_map(|report| report.pages)
        .collect::<Vec<_>>();
    restored.append(&mut pages);
    restored.push(row);
    restored.extend(remaining);
    restored
}

fn activity_report(
    key: &SessionKey,
    session_key: &str,
    reported_at_ms: u64,
    dropped_pages: u64,
    pages: Vec<PageRow>,
) -> ActivityReport {
    ActivityReport {
        session_key: session_key.to_string(),
        browser_id: key.browser_id,
        platform_id: key.platform_id,
        direct_mode: key.direct_mode,
        client_version: CLIENT_VERSION.to_string(),
        device_id: crate::device::wire_device_id(),
        reported_at_ms,
        dropped_pages,
        pages,
    }
}

#[cfg(test)]
fn merge_unsent_reports(
    aggregate: &mut Aggregate,
    failed: ActivityReport,
    unsent: impl IntoIterator<Item = ActivityReport>,
) {
    aggregate.merge_back(failed.pages);
    for report in unsent {
        aggregate.merge_back(report.pages);
    }
}

/// 成功之后按正常节奏，失败之后线性退避到上限。
fn next_delay(failures: u32) -> Duration {
    if failures == 0 {
        return FLUSH_INTERVAL;
    }
    (RETRY_BACKOFF * failures).min(MAX_RETRY_BACKOFF)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct DurableFixture {
        root: std::path::PathBuf,
        queue: Arc<crate::activity_outbox::ActivityOutbox>,
    }
    impl DurableFixture {
        fn new() -> Self {
            static NEXT_FIXTURE: std::sync::atomic::AtomicU64 =
                std::sync::atomic::AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "vestus-delivery-{}-{}-{}",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let queue = Arc::new(crate::activity_outbox::ActivityOutbox::open(&root).unwrap());
            Self { root, queue }
        }
        fn stage(&self, owner: &ActivityOwner, clicks: u32) {
            let mut row = large_row(1);
            row.clicks = clicks;
            row.input_snapshot = None;
            let mut report = activity_report(
                &SessionKey {
                    browser_id: 1,
                    platform_id: 2,
                    direct_mode: false,
                },
                "stable-session",
                now_ms(),
                0,
                vec![row],
            );
            report.client_version = "0.1.7".into();
            self.queue
                .stage(&owner.namespace, &serde_json::to_value(report).unwrap())
                .unwrap();
        }
    }
    impl Drop for DurableFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn response_loss_and_restart_replay_the_exact_batch_before_new_observations() {
        rt::runtime().block_on(async {
            let fixture = DurableFixture::new();
            let owner = ActivityOwner::new("https://server.test", "user-7", 7);
            fixture.stage(&owner, 2);
            let received = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
            let attempts = received.clone();
            let failed = deliver_with_sender(fixture.queue.clone(), &owner, move |payload| {
                attempts.lock().unwrap().push(payload);
                async { Err("server committed, response was lost".into()) }
            })
            .await;
            assert!(failed.is_err());
            let original = fixture.queue.next(&owner.namespace).unwrap().unwrap();
            fixture.stage(&owner, 3);
            let reopened =
                Arc::new(crate::activity_outbox::ActivityOutbox::open(&fixture.root).unwrap());
            let attempts = received.clone();
            deliver_with_sender(reopened.clone(), &owner, move |payload| {
                attempts.lock().unwrap().push(payload);
                async { Ok(()) }
            })
            .await
            .unwrap();
            let received = received.lock().unwrap();
            assert_eq!(received.len(), 3);
            assert_eq!(received[0], original);
            assert_eq!(
                received[1], original,
                "retry payload/ID cannot merge new events"
            );
            assert_ne!(received[1]["batchId"], received[2]["batchId"]);
            assert_eq!(received[0]["pages"][0]["clicks"], 2);
            assert_eq!(received[2]["pages"][0]["clicks"], 3);
            assert_eq!(
                received[2]["clientVersion"], "0.1.7",
                "upgrading must not relabel captured data"
            );
            assert!(reopened.next(&owner.namespace).unwrap().is_none());
        });
    }

    #[test]
    fn other_account_cannot_drain_pending_activity() {
        rt::runtime().block_on(async {
            let fixture = DurableFixture::new();
            let owner = ActivityOwner::new("https://server.test", "user-7", 7);
            let other = ActivityOwner::new("https://server.test", "user-8", 8);
            let other_server = ActivityOwner::new("https://another.test", "user-7", 7);
            fixture.stage(&owner, 2);
            for wrong in [other, other_server] {
                deliver_with_sender(fixture.queue.clone(), &wrong, |_| async {
                    panic!("another owner's record was sent")
                })
                .await
                .unwrap();
            }
            let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let sent = count.clone();
            deliver_with_sender(fixture.queue.clone(), &owner, move |payload| {
                assert_eq!(payload["ownerUserId"], 7);
                sent.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                async { Ok(()) }
            })
            .await
            .unwrap();
            assert_eq!(count.load(std::sync::atomic::Ordering::Relaxed), 1);
        });
    }

    #[test]
    fn ready_batches_are_delivered_even_when_new_staging_is_unreadable() {
        rt::runtime().block_on(async {
            let fixture = DurableFixture::new();
            let owner = ActivityOwner::new("https://server.test", "user-7", 7);
            fixture.stage(&owner, 2);
            fixture
                .queue
                .prepare(&owner.namespace, |values| build_ready_reports(values, 7))
                .unwrap();
            fixture
                .queue
                .stage(&owner.namespace, &serde_json::json!({"futureFormat": true}))
                .unwrap();
            let result =
                deliver_with_sender(fixture.queue.clone(), &owner, |_| async { Ok(()) }).await;
            assert!(result.is_err(), "unreadable staging must be retained");
            assert!(
                fixture.queue.next(&owner.namespace).unwrap().is_none(),
                "valid ready batch must be acknowledged first"
            );
            assert!(fixture
                .queue
                .prepare(&owner.namespace, |values| build_ready_reports(values, 7))
                .is_err());
        });
    }

    #[test]
    fn reliable_batches_include_metadata_without_exceeding_body_limit() {
        let key = SessionKey {
            browser_id: 1,
            platform_id: 2,
            direct_mode: false,
        };
        let events = (0..MAX_TRACKED_PAGES)
            .map(|index| {
                serde_json::to_value(activity_report(
                    &key,
                    "size-session",
                    now_ms(),
                    0,
                    vec![large_row(index)],
                ))
                .unwrap()
            })
            .collect();
        let ready = build_ready_reports(events, i64::MAX).unwrap();
        assert!(ready.len() > 1);
        assert_eq!(
            ready
                .iter()
                .map(|p| p["pages"].as_array().unwrap().len())
                .sum::<usize>(),
            MAX_TRACKED_PAGES
        );
        for payload in ready {
            assert!(serde_json::to_vec(&payload).unwrap().len() <= MAX_ACTIVITY_REPORT_BYTES);
            assert_eq!(payload["batchId"].as_str().unwrap().len(), 64);
            assert_eq!(payload["protocolVersion"], 2);
        }
    }

    #[test]
    fn oversized_counter_totals_are_partitioned_without_losing_increments() {
        let key = SessionKey {
            browser_id: 1,
            platform_id: 2,
            direct_mode: false,
        };
        let events = (0..500)
            .map(|index| {
                let mut row = large_row(0);
                row.visits = 10_000;
                row.clicks = 10_000;
                row.inputs = 10_000;
                row.submits = 10_000;
                row.scrolls = 10_000;
                row.dwell_ms = 7 * 24 * 60 * 60 * 1000;
                row.first_seen_at_ms = index + 1;
                row.last_seen_at_ms = index + 1;
                row.input_snapshot_at_ms = index + 1;
                serde_json::to_value(activity_report(&key, "oversized", index + 1, 0, vec![row]))
                    .unwrap()
            })
            .collect();
        let batches = build_ready_reports(events, 7).unwrap();
        assert_eq!(batches.len(), 3500);
        let mut ids = std::collections::HashSet::new();
        let mut totals = [0u64; 6];
        let mut snapshots = 0;
        for payload in batches {
            assert!(serde_json::to_vec(&payload).unwrap().len() <= MAX_ACTIVITY_REPORT_BYTES);
            let batch: ReliableReport = serde_json::from_value(payload).unwrap();
            assert!(ids.insert(batch.batch_id));
            assert_eq!(batch.report.pages.len(), 1);
            let row = &batch.report.pages[0];
            for (index, count) in [row.visits, row.clicks, row.inputs, row.submits, row.scrolls]
                .into_iter()
                .enumerate()
            {
                assert!(count <= 1_000_000);
                totals[index] += u64::from(count);
            }
            assert!(row.dwell_ms <= 24 * 60 * 60 * 1000);
            totals[5] += row.dwell_ms;
            assert_eq!((row.first_seen_at_ms, row.last_seen_at_ms), (1, 500));
            if row.input_snapshot.is_some() {
                snapshots += 1;
                assert_eq!(row.input_snapshot_at_ms, 500);
            } else {
                assert_eq!(row.input_snapshot_at_ms, 0);
            }
        }
        assert_eq!(&totals[..5], &[5_000_000; 5]);
        assert_eq!(totals[5], 500 * 7 * 24 * 60 * 60 * 1000);
        assert_eq!(snapshots, 1);
    }

    #[test]
    fn page_partition_retains_zero_count_snapshots_and_both_snapshot_timestamps() {
        let mut row = large_row(0);
        row.visits = 0;
        let unchanged = split_page_counters(row.clone());
        assert_eq!(unchanged, vec![row.clone()]);
        row.dwell_ms = 24 * 60 * 60 * 1000 + 1;
        row.submit_snapshot = row.input_snapshot.clone();
        row.submit_snapshot_at_ms = 99;
        let parts = split_page_counters(row);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].submit_snapshot.is_none());
        assert_eq!(parts[0].submit_snapshot_at_ms, 0);
        assert!(parts[1].submit_snapshot.is_some());
        assert_eq!(parts[1].submit_snapshot_at_ms, 99);
        assert_eq!(parts[1].input_snapshot_at_ms, 1);
    }

    #[test]
    fn report_partition_enforces_page_count_limit() {
        let key = SessionKey {
            browser_id: 1,
            platform_id: 2,
            direct_mode: false,
        };
        let rows = (0..501)
            .map(|index| {
                let mut row = large_row(index);
                row.input_snapshot = None;
                row
            })
            .collect();
        let reports = split_activity_reports(&key, "many-pages", 1, 0, rows).unwrap();
        assert_eq!(
            reports
                .iter()
                .map(|report| report.pages.len())
                .collect::<Vec<_>>(),
            vec![500, 1]
        );
    }

    /// 上报的版本号必须是安装包自己的版本号。换回 `CARGO_PKG_VERSION` 会在这里
    /// 失败：那个值不随发布标签走，会让每个版本都报同一个数字。
    #[test]
    fn reported_client_version_is_the_packaged_version() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            CLIENT_VERSION,
            config["version"]
                .as_str()
                .expect("tauri.conf.json 缺少字符串字段 version")
        );
    }

    fn visit(url: &str) -> PageReport {
        PageReport {
            url: url.to_string(),
            visits: 1,
            ..PageReport::default()
        }
    }

    fn clicks(url: &str, clicks: u32, dwell_ms: u64) -> PageReport {
        PageReport {
            url: url.to_string(),
            clicks,
            dwell_ms,
            ..PageReport::default()
        }
    }

    fn wire_rows(rows: Vec<PageRow>) -> serde_json::Value {
        serde_json::to_value(ActivityReport {
            session_key: "session".into(),
            browser_id: 1,
            platform_id: 2,
            direct_mode: false,
            reported_at_ms: 3,
            dropped_pages: 0,
            client_version: "0.1.8".into(),
            device_id: None,
            pages: rows,
        })
        .unwrap()
    }

    fn large_row(index: usize) -> PageRow {
        PageRow {
            url: format!("https://a.test/{index}"),
            url_params: None,
            visits: 1,
            clicks: 0,
            inputs: 0,
            submits: 0,
            scrolls: 0,
            dwell_ms: 0,
            first_seen_at_ms: 1,
            last_seen_at_ms: 1,
            input_snapshot: Some(FormSnapshot::from([(
                "note".into(),
                vec!["x".repeat(512); 20],
            )])),
            input_snapshot_at_ms: 1,
            submit_snapshot: None,
            submit_snapshot_at_ms: 0,
        }
    }

    #[test]
    fn wire_batches_never_exceed_the_backend_four_mebibyte_cap() {
        let reports = split_activity_reports(
            &SessionKey {
                browser_id: 1,
                platform_id: 2,
                direct_mode: false,
            },
            "session",
            3,
            7,
            (0..MAX_TRACKED_PAGES).map(large_row).collect(),
        )
        .expect("each valid page fits below the backend cap");

        assert!(
            reports.len() > 1,
            "the fixture must require more than one request"
        );
        assert_eq!(
            reports
                .iter()
                .map(|report| report.pages.len())
                .sum::<usize>(),
            MAX_TRACKED_PAGES
        );
        assert!(reports.iter().all(|report| {
            serde_json::to_vec(report).unwrap().len() <= MAX_ACTIVITY_REPORT_BYTES
        }));
        assert!(reports.iter().all(|report| report.dropped_pages == 7));
    }

    #[test]
    fn merging_failed_and_unsent_wire_batches_never_replays_successful_pages() {
        let key = SessionKey {
            browser_id: 1,
            platform_id: 2,
            direct_mode: false,
        };
        let mut reports = split_activity_reports(
            &key,
            "session",
            3,
            0,
            (0..MAX_TRACKED_PAGES).map(large_row).collect(),
        )
        .expect("each valid page fits below the backend cap");
        let successful = reports.remove(0);
        let failed = reports.remove(0);
        let expected_unsent = failed.pages.len()
            + reports
                .iter()
                .map(|report| report.pages.len())
                .sum::<usize>();

        let mut aggregate = Aggregate::default();
        merge_unsent_reports(&mut aggregate, failed, reports);

        assert_eq!(aggregate.pages.len(), expected_unsent);
        assert!(aggregate
            .pages
            .keys()
            .all(|(url, _)| !successful.pages.iter().any(|row| &row.url == url)));
        assert_eq!(
            aggregate.pages.values().map(|row| row.visits).sum::<u32>(),
            expected_unsent as u32
        );
    }

    /// 同一个地址的多条上报累加，而不是互相覆盖：导航事件和注入脚本是两个来源，
    /// 覆盖就会让「访问了但没操作」或「操作了但不算访问」。
    #[test]
    fn absorbing_the_same_url_accumulates_every_counter() {
        let mut aggregate = Aggregate::default();
        aggregate.absorb(visit("https://a.test/p"), 1_000);
        aggregate.absorb(clicks("https://a.test/p", 3, 500), 2_000);
        aggregate.absorb(clicks("https://a.test/p", 2, 700), 3_000);

        let rows = aggregate.take();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].visits, 1);
        assert_eq!(rows[0].clicks, 5);
        // 停留时长是增量，所以相加
        assert_eq!(rows[0].dwell_ms, 1_200);
        assert_eq!(rows[0].first_seen_at_ms, 1_000);
        assert_eq!(rows[0].last_seen_at_ms, 3_000);
        assert!(aggregate.is_empty(), "take 之后聚合表要清空");
    }

    /// 上报失败的那一批要合回来继续重试，而且必须和退避期间新攒的量相加——
    /// 直接覆盖就等于丢掉退避那几十秒里的操作。
    #[test]
    fn merging_a_failed_batch_back_adds_instead_of_overwriting() {
        let mut aggregate = Aggregate::default();
        aggregate.absorb(clicks("https://a.test/p", 4, 900), 1_000);
        let failed = aggregate.take();

        // 退避期间又攒了新的
        aggregate.absorb(clicks("https://a.test/p", 1, 100), 5_000);
        aggregate.merge_back(failed);

        let rows = aggregate.take();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].clicks, 5);
        assert_eq!(rows[0].dwell_ms, 1_000);
        assert_eq!(rows[0].first_seen_at_ms, 1_000);
        assert_eq!(rows[0].last_seen_at_ms, 5_000);
    }

    #[test]
    fn distinct_url_parameters_remain_distinct_rows_on_the_wire() {
        let mut aggregate = Aggregate::default();
        aggregate.absorb(
            cdp::parse_payload(
                &serde_json::json!({ "url": "https://a.test/p?order=1" }).to_string(),
            )
            .unwrap(),
            1_000,
        );
        aggregate.absorb(
            cdp::parse_payload(
                &serde_json::json!({ "url": "https://a.test/p?order=2" }).to_string(),
            )
            .unwrap(),
            2_000,
        );

        let json = wire_rows(aggregate.take());
        assert_eq!(json["pages"].as_array().unwrap().len(), 2);
        assert_eq!(json["pages"][0]["url"], "https://a.test/p");
        assert_eq!(json["pages"][0]["urlParams"], "order=1");
        assert_eq!(json["pages"][1]["urlParams"], "order=2");
    }

    #[test]
    fn merging_a_failed_batch_keeps_the_newer_pending_snapshot() {
        let mut aggregate = Aggregate::default();
        aggregate.absorb(
            cdp::parse_payload(
                &serde_json::json!({
                    "url": "https://a.test/p",
                    "inputSnapshot": { "email": ["old@example.test"] },
                })
                .to_string(),
            )
            .unwrap(),
            1_000,
        );
        let failed = aggregate.take();
        aggregate.absorb(
            cdp::parse_payload(
                &serde_json::json!({
                    "url": "https://a.test/p",
                    "inputSnapshot": { "email": ["new@example.test"] },
                })
                .to_string(),
            )
            .unwrap(),
            5_000,
        );
        aggregate.merge_back(failed);

        let json = wire_rows(aggregate.take());
        assert_eq!(
            json["pages"][0]["inputSnapshot"]["email"][0],
            "new@example.test"
        );
        assert_eq!(json["pages"][0]["inputSnapshotAtMs"], 5_000);
    }

    /// 合回来的地址在期间已经被清空过时，整行原样放回去。
    #[test]
    fn merging_a_failed_batch_back_restores_unseen_urls() {
        let mut aggregate = Aggregate::default();
        aggregate.absorb(visit("https://a.test/x"), 1_000);
        let failed = aggregate.take();
        aggregate.merge_back(failed);

        let rows = aggregate.take();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].url, "https://a.test/x");
        assert_eq!(rows[0].visits, 1);
    }

    /// 一个跑循环、不停改地址的页面不能把内存吃光：到顶之后新地址丢掉，
    /// 已经在表里的地址仍然继续计数。
    #[test]
    fn the_table_stops_growing_at_the_cap_but_keeps_counting_known_urls() {
        let mut aggregate = Aggregate::default();
        for index in 0..MAX_TRACKED_PAGES + 50 {
            aggregate.absorb(visit(&format!("https://a.test/{index}")), 1_000);
        }
        assert_eq!(aggregate.pages.len(), MAX_TRACKED_PAGES);
        assert_eq!(aggregate.dropped, 50);

        aggregate.absorb(clicks("https://a.test/0", 2, 0), 2_000);
        assert_eq!(
            aggregate.pages[&(String::from("https://a.test/0"), None)].clicks,
            2
        );
    }

    /// 空表不发请求：没有增量就没有必要打扰服务端。
    #[test]
    fn an_empty_aggregate_has_nothing_to_send() {
        assert!(Aggregate::default().is_empty());
    }

    /// 失败越多等越久，但有上限——否则一次长时间断网之后就再也不重试了。
    #[test]
    fn backoff_grows_linearly_and_stops_at_the_cap() {
        assert_eq!(next_delay(0), FLUSH_INTERVAL);
        assert_eq!(next_delay(1), RETRY_BACKOFF);
        assert_eq!(next_delay(3), RETRY_BACKOFF * 3);
        assert_eq!(next_delay(9_999), MAX_RETRY_BACKOFF);
    }

    /// 线格式的字段名就是后端的契约，改了要同时改后端。
    #[test]
    fn the_wire_shape_is_camel_case() {
        let report = ActivityReport {
            session_key: "0000000000000001000000010000000a".into(),
            browser_id: 7,
            platform_id: 3,
            direct_mode: true,
            client_version: "0.1.8".into(),
            device_id: Some("a1b2c3d4e5f67890abcdef1234567890".into()),
            reported_at_ms: 1_700_000_000_000,
            dropped_pages: 0,
            pages: vec![PageRow {
                url: "https://a.test/p".into(),
                url_params: Some("order=42".into()),
                visits: 1,
                clicks: 2,
                inputs: 3,
                submits: 4,
                scrolls: 5,
                dwell_ms: 6,
                first_seen_at_ms: 1_700_000_000_000,
                last_seen_at_ms: 1_700_000_000_001,
                input_snapshot: Some(FormSnapshot::from([(
                    "email".into(),
                    vec!["buyer@example.test".into()],
                )])),
                input_snapshot_at_ms: 1_700_000_000_000,
                submit_snapshot: None,
                submit_snapshot_at_ms: 0,
            }],
        };

        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["sessionKey"], "0000000000000001000000010000000a");
        assert_eq!(json["browserId"], 7);
        assert_eq!(json["platformId"], 3);
        assert_eq!(json["directMode"], true);
        assert_eq!(json["clientVersion"], "0.1.8");
        assert_eq!(json["reportedAtMs"], 1_700_000_000_000_u64);
        assert_eq!(json["droppedPages"], 0);
        assert_eq!(json["pages"][0]["dwellMs"], 6);
        assert_eq!(json["pages"][0]["urlParams"], "order=42");
        assert_eq!(
            json["pages"][0]["inputSnapshot"]["email"][0],
            "buyer@example.test"
        );
        assert_eq!(json["pages"][0]["inputSnapshotAtMs"], 1_700_000_000_000_u64);
        assert_eq!(json["pages"][0]["submitSnapshot"], serde_json::Value::Null);
        assert_eq!(json["pages"][0]["submitSnapshotAtMs"], 0);
        assert_eq!(json["pages"][0]["firstSeenAtMs"], 1_700_000_000_000_u64);
        assert_eq!(json["pages"][0]["lastSeenAtMs"], 1_700_000_000_001_u64);
    }

    /// 去重键必须一眼能放进服务端的列里，而且同一进程里两个会话不能撞。
    ///
    /// 注意 `wire_key` 每次调用都读一次时钟，所以「同一次会话的每一批用同一个键」
    /// 是靠 [`run_session`] 只算一次来保证的，不是靠这个函数本身幂等。
    #[test]
    fn the_wire_key_is_hex_and_distinguishes_sessions() {
        let first = SessionKey {
            browser_id: 1,
            platform_id: 3,
            direct_mode: false,
        }
        .wire_key();
        let second = SessionKey {
            browser_id: 2,
            platform_id: 3,
            direct_mode: false,
        }
        .wire_key();

        assert_eq!(first.len(), 32, "16 位纳秒 + 8 位进程号 + 8 位会话号");
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }
}
