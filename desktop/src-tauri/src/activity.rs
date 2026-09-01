//! 浏览器活动的聚合与上报。
//!
//! [`cdp`](crate::cdp) 只负责把一个 Chromium 进程翻译成一串 [`PageReport`]；这里
//! 负责把它们按地址合并、按批次上报，并保证「采集这件事永远不影响浏览」：
//!
//! - 上报走后台任务，从不阻塞 `open_browser`；
//! - 上报失败会把这一批**合回聚合表**并退避重试，而不是丢掉；
//! - 采集通道连不上、握手失败、中途断开，都只是这次会话没有日志。
//!
//! 每一批发的都是**增量**（次数和停留时长都是自上次上报以来的量），所以服务端只
//! 需要按 `(sessionKey, url)` 累加。这样即使某一批重发或丢失，也不会让历史数据
//! 互相覆盖。

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::task::JoinHandle;

use crate::auth::DesktopAuthState;
use crate::browser::DevToolsEndpoint;
use crate::cdp::{self, FormSnapshot, PageReport};
use crate::rt;

/// 攒够一批就发的间隔。太短会把一次正常浏览打成几十个请求，太长则退出时丢得多。
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

/// 关应用时等各会话把最后一批发完的上限。等不到就放弃，不能让用户卡在退出上。
const SHUTDOWN_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);

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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityReport {
    /// 这次会话的去重键，见 [`SessionKey::wire_key`]。同一次会话的每一批都相同。
    session_key: String,
    browser_id: u64,
    platform_id: i64,
    direct_mode: bool,
    client_version: String,
    /// 客户端本机时钟的毫秒时间戳。服务端不信这个值，只用它排序并夹到「现在」，
    /// 记录时间仍由服务端自己盖。
    reported_at_ms: u64,
    /// 因为聚合表满了而没能记下的地址数。唯一能告诉运维「这次会话的数据不全」
    /// 的信号，所以跟着上报一起走。
    dropped_pages: u64,
    pages: Vec<PageRow>,
}

/// 一个地址在这一批里的增量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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

/// 会话结束后最后一批的重试次数。会话已经没了，不能无限重试下去。
const FINAL_FLUSH_ATTEMPTS: u32 = 3;

/// 浏览器活动采集的入口，注册进 Tauri 托管状态。
#[derive(Clone, Default)]
pub struct ActivityCollector {
    /// 每个会话一个聚合任务。退出时靠它们知道「最后一批发完了没有」。
    sessions: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl ActivityCollector {
    /// 给一个刚就绪的浏览器会话开一条采集通道。
    ///
    /// 立刻返回：连接、采集、上报全在后台任务里。这个函数跑在浏览器监视线程上
    /// （`Browsers::launch` 的 `on_ready`），不能阻塞，也不能出错——采集不成功
    /// 只是这次会话没有日志，浏览器照常使用。
    pub fn start(&self, key: SessionKey, endpoint: DevToolsEndpoint, auth: DesktopAuthState) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let runtime = rt::runtime();
        // 采集任务先于聚合任务结束：浏览器退出 -> 调试通道断开 -> sender 析构 ->
        // receiver 收到 None -> 聚合任务发最后一批。整条链是这个顺序。
        runtime.spawn(async move {
            let _ = cdp::collect(endpoint, sender).await;
        });
        let aggregation = runtime.spawn(async move { run_session(key, receiver, auth).await });
        self.remember(aggregation);
    }

    fn remember(&self, handle: JoinHandle<()>) {
        let mut sessions = self.sessions.lock().expect("活动采集锁已中毒");
        // 已结束的会话在这里回收，于是这张表的长度跟着「在开的浏览器」而不是
        // 「一共开过多少次」。
        sessions.retain(|task| !task.is_finished());
        sessions.push(handle);
    }

    /// 等各会话把最后一批发完，最多等 [`SHUTDOWN_FLUSH_TIMEOUT`]。
    ///
    /// 必须在 `BrowserSessionManager::shutdown()` **之后**调用：只有浏览器进程被
    /// 收走，调试通道才会断，聚合任务才会走到最后一次上报。等不到就放弃——退出
    /// 卡住比丢一批日志严重得多。
    pub fn shutdown(&self) {
        let handles = {
            let mut sessions = self.sessions.lock().expect("活动采集锁已中毒");
            std::mem::take(&mut *sessions)
        };
        if handles.is_empty() {
            return;
        }
        // 这里跑在 Tauri 主线程（`app.run` 的退出回调）上，不在运行时线程里，
        // 所以 block_on 是安全的。
        let _ = rt::runtime().block_on(tokio::time::timeout(SHUTDOWN_FLUSH_TIMEOUT, async move {
            for handle in handles {
                let _ = handle.await;
            }
        }));
    }
}

/// 一个会话的聚合与上报循环，随采集通道结束而结束。
async fn run_session(
    key: SessionKey,
    mut receiver: UnboundedReceiver<PageReport>,
    auth: DesktopAuthState,
) {
    // 去重键只在这里算一次：同一次会话的每一批都必须带同一个值，服务端才能把它们
    // 落到同一行。
    let session_key = key.wire_key();
    let mut aggregate = Aggregate::default();
    let mut failures: u32 = 0;
    let mut next_flush = tokio::time::Instant::now() + FLUSH_INTERVAL;

    loop {
        tokio::select! {
            report = receiver.recv() => match report {
                Some(report) => aggregate.absorb(report, now_ms()),
                // 采集通道结束 = 浏览器已经退出。
                None => break,
            },
            _ = tokio::time::sleep_until(next_flush) => {
                flush(&key, &session_key, &mut aggregate, &auth, &mut failures).await;
                next_flush = tokio::time::Instant::now() + next_delay(failures);
            }
        }
    }

    for attempt in 0..FINAL_FLUSH_ATTEMPTS {
        if aggregate.is_empty() {
            break;
        }
        if attempt > 0 {
            tokio::time::sleep(next_delay(failures)).await;
        }
        flush(&key, &session_key, &mut aggregate, &auth, &mut failures).await;
    }
}

/// 发一批。失败就把它合回聚合表，等下一次连着新增量一起发。
async fn flush(
    key: &SessionKey,
    session_key: &str,
    aggregate: &mut Aggregate,
    auth: &DesktopAuthState,
    failures: &mut u32,
) {
    if aggregate.is_empty() {
        return;
    }
    let reports = match split_activity_reports(
        key,
        session_key,
        now_ms(),
        aggregate.dropped,
        aggregate.take(),
    ) {
        Ok(reports) => reports,
        Err(rows) => {
            *failures = failures.saturating_add(1);
            aggregate.merge_back(rows);
            return;
        }
    };
    // 采集失败不进用户界面：这个 crate 没有日志设施，而把后台上报的网络错误弹给
    // 正在浏览的用户只会造成困扰。数据不会丢——失败的那一批合回聚合表继续重试。
    let mut reports = reports.into_iter();
    while let Some(report) = reports.next() {
        if auth.report_browser_activity(&report).await.is_err() {
            *failures = failures.saturating_add(1);
            merge_unsent_reports(aggregate, report, reports);
            return;
        }
    }
    *failures = 0;
}

fn split_activity_reports(
    key: &SessionKey,
    session_key: &str,
    reported_at_ms: u64,
    dropped_pages: u64,
    rows: Vec<PageRow>,
) -> Result<Vec<ActivityReport>, Vec<PageRow>> {
    let base_len = serde_json::to_vec(&activity_report(
        key,
        session_key,
        reported_at_ms,
        dropped_pages,
        Vec::new(),
    ))
    .expect("ActivityReport 必须可序列化")
    .len();
    let mut reports = Vec::new();
    let mut pages = Vec::new();
    let mut page_bytes = 0;
    let mut rows = rows.into_iter();
    while let Some(row) = rows.next() {
        let row_len = serde_json::to_vec(&row)
            .expect("PageRow 必须可序列化")
            .len();
        let candidate_len = wire_len(base_len, page_bytes, pages.len(), row_len);
        if candidate_len <= MAX_ACTIVITY_REPORT_BYTES {
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
        reports.push(activity_report(
            key,
            session_key,
            reported_at_ms,
            dropped_pages,
            std::mem::take(&mut pages),
        ));
        if wire_len(base_len, 0, 0, row_len) > MAX_ACTIVITY_REPORT_BYTES {
            return Err(restore_rows(reports, pages, row, rows));
        }
        page_bytes = row_len;
        pages.push(row);
    }
    if !pages.is_empty() {
        reports.push(activity_report(
            key,
            session_key,
            reported_at_ms,
            dropped_pages,
            pages,
        ));
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
        client_version: env!("CARGO_PKG_VERSION").to_string(),
        reported_at_ms,
        dropped_pages,
        pages,
    }
}

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
