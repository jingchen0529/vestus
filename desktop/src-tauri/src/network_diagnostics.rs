//! Bounded, privacy-preserving network diagnostics.
use crate::browser::DevToolsEndpoint;
use crate::probe::{probe_browser, probe_via_upstream_http_timed};
use crate::upstream::UpstreamProxy;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_PROBE_DURATION_MS: u64 = 8000;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
static SAMPLE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSample {
    pub sample_id: String,
    pub route: String,
    pub target_kind: String,
    pub network_mode: String,
    pub platform_id: Option<String>,
    pub browser_id: Option<String>,
    pub started_at_ms: u64,
    pub duration_ms: Option<u64>,
    pub connect_ms: Option<u64>,
    pub ttfb_ms: Option<u64>,
    pub total_ms: Option<u64>,
    pub response_bytes: Option<u64>,
    pub download_kbps: Option<u64>,
    pub status: String,
    pub error_code: Option<String>,
    pub client_version: Option<String>,
}
impl NetworkSample {
    pub fn success(
        sample_id: impl Into<String>,
        route: impl Into<String>,
        target_kind: impl Into<String>,
        network_mode: impl Into<String>,
        total_ms: u64,
        response_bytes: u64,
    ) -> Self {
        let total_ms = total_ms.min(MAX_PROBE_DURATION_MS);
        let bytes = response_bytes.min(MAX_RESPONSE_BYTES as u64);
        Self {
            sample_id: sample_id.into(),
            route: route.into(),
            target_kind: target_kind.into(),
            network_mode: network_mode.into(),
            platform_id: None,
            browser_id: None,
            started_at_ms: now_ms(),
            duration_ms: Some(total_ms),
            connect_ms: None,
            ttfb_ms: None,
            total_ms: Some(total_ms),
            response_bytes: Some(bytes),
            download_kbps: Some(if total_ms == 0 {
                0
            } else {
                bytes.saturating_mul(8) / total_ms
            }),
            status: "ok".into(),
            error_code: None,
            client_version: None,
        }
    }
    fn with_download(mut self, body_ms: u64) -> Self {
        let bytes = self.response_bytes.unwrap_or(0);
        self.download_kbps = Some(if body_ms == 0 {
            0
        } else {
            bytes.saturating_mul(8) / body_ms
        });
        self
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnosticsReport {
    pub protocol_version: u8,
    pub samples: Vec<NetworkSample>,
    pub device_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnosticsSnapshot {
    pub samples: Vec<NetworkSample>,
    pub device_id: Option<String>,
    pub upload_status: String,
    pub queued_count: usize,
    pub dropped_count: u64,
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn sample_id() -> String {
    format!(
        "{:016x}",
        SAMPLE_COUNTER.fetch_add(1, Ordering::Relaxed) ^ now_ms()
    )
}
fn failed_sample(
    route: &str,
    target_kind: &str,
    network_mode: &str,
    started: u64,
    elapsed: u64,
    error: &str,
) -> NetworkSample {
    NetworkSample {
        sample_id: sample_id(),
        route: route.into(),
        target_kind: target_kind.into(),
        network_mode: network_mode.into(),
        platform_id: None,
        browser_id: None,
        started_at_ms: started,
        duration_ms: Some(elapsed.min(MAX_PROBE_DURATION_MS)),
        connect_ms: None,
        ttfb_ms: None,
        total_ms: Some(elapsed.min(MAX_PROBE_DURATION_MS)),
        response_bytes: None,
        download_kbps: None,
        status: "error".into(),
        error_code: Some(error.into()),
        client_version: None,
    }
}

pub async fn measure_management(url: &str) -> NetworkSample {
    measure_management_until(
        url,
        tokio::time::Instant::now() + Duration::from_millis(MAX_PROBE_DURATION_MS),
    )
    .await
}
pub async fn measure_management_until(url: &str, deadline: tokio::time::Instant) -> NetworkSample {
    measure_http_until(url, "management", "api", "direct", deadline).await
}

pub async fn measure_proxy(upstream: Option<&UpstreamProxy>, url: &str) -> NetworkSample {
    measure_proxy_until(
        upstream,
        url,
        tokio::time::Instant::now() + Duration::from_millis(MAX_PROBE_DURATION_MS),
    )
    .await
}

pub async fn measure_proxy_until(
    upstream: Option<&UpstreamProxy>,
    url: &str,
    deadline: tokio::time::Instant,
) -> NetworkSample {
    let Some(upstream) = upstream else {
        return failed_sample(
            "vpn",
            "proxy_probe",
            "unavailable",
            now_ms(),
            0,
            "proxy_disabled",
        );
    };
    let started = now_ms();
    let start = Instant::now();
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    match tokio::time::timeout(remaining, probe_via_upstream_http_timed(upstream, url)).await {
        Ok(Ok((bytes, body_ms))) => NetworkSample::success(
            sample_id(),
            "vpn",
            "proxy_probe",
            "proxy",
            start.elapsed().as_millis() as u64,
            bytes,
        )
        .with_download(body_ms),
        Ok(Err(error)) => failed_sample(
            "vpn",
            "proxy_probe",
            "proxy",
            started,
            start.elapsed().as_millis() as u64,
            match error.code() {
                "auth_failed" => "proxy_auth",
                "connect_timeout" | "handshake_timeout" => "timeout",
                "connect_failed" => "proxy_unavailable",
                "probe_status" => "http_status",
                _ => "connect",
            },
        ),
        Err(_) => failed_sample(
            "vpn",
            "proxy_probe",
            "proxy",
            started,
            MAX_PROBE_DURATION_MS,
            "timeout",
        ),
    }
}
#[allow(dead_code)]
pub async fn measure_browser_cdp(endpoint: Option<&DevToolsEndpoint>) -> NetworkSample {
    measure_browser_cdp_with_deadline(
        endpoint,
        tokio::time::Instant::now() + Duration::from_millis(MAX_PROBE_DURATION_MS),
    )
    .await
}

pub async fn measure_browser_cdp_with_deadline(
    endpoint: Option<&DevToolsEndpoint>,
    deadline: tokio::time::Instant,
) -> NetworkSample {
    let Some(endpoint) = endpoint else {
        return failed_sample(
            "browser",
            "cdp",
            "unavailable",
            now_ms(),
            0,
            "cdp_unavailable",
        );
    };
    measure_browser_cdp_until(endpoint, deadline).await
}

pub async fn measure_browser_cdp_until(
    endpoint: &DevToolsEndpoint,
    deadline: tokio::time::Instant,
) -> NetworkSample {
    let started = now_ms();
    let start = Instant::now();
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    match tokio::time::timeout(remaining, probe_browser(endpoint)).await {
        Ok(Ok(_)) => NetworkSample::success(
            sample_id(),
            "browser",
            "cdp",
            "direct",
            start.elapsed().as_millis() as u64,
            0,
        ),
        Ok(Err(error)) => failed_sample(
            "browser",
            "cdp",
            "unavailable",
            started,
            start.elapsed().as_millis() as u64,
            if error == "cdp_closed" {
                "browser_closed"
            } else {
                "cdp_unavailable"
            },
        ),
        Err(_) => failed_sample(
            "browser",
            "cdp",
            "unavailable",
            started,
            MAX_PROBE_DURATION_MS,
            "timeout",
        ),
    }
}
async fn measure_http_until(
    url: &str,
    route: &str,
    target_kind: &str,
    network_mode: &str,
    deadline: tokio::time::Instant,
) -> NetworkSample {
    let started = now_ms();
    let start = Instant::now();
    let client = match reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(MAX_PROBE_DURATION_MS))
        .build()
    {
        Ok(c) => c,
        Err(_) => return failed_sample(route, target_kind, network_mode, started, 0, "connect"),
    };
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    let response = match tokio::time::timeout(remaining, client.get(url).send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => {
            return failed_sample(
                route,
                target_kind,
                network_mode,
                started,
                start.elapsed().as_millis() as u64,
                classify_error(&e),
            )
        }
        Err(_) => {
            return failed_sample(
                route,
                target_kind,
                network_mode,
                started,
                MAX_PROBE_DURATION_MS,
                "timeout",
            )
        }
    };
    let elapsed = start.elapsed().as_millis() as u64;
    let status = response.status();
    let body_started = Instant::now();
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    let body = match tokio::time::timeout(remaining, read_limited(response)).await {
        Ok(Ok(b)) => b,
        Ok(Err(_)) => {
            return failed_sample(
                route,
                target_kind,
                network_mode,
                started,
                MAX_PROBE_DURATION_MS,
                "connect",
            )
        }
        Err(_) => {
            return failed_sample(
                route,
                target_kind,
                network_mode,
                started,
                MAX_PROBE_DURATION_MS,
                "timeout",
            )
        }
    };
    if !status.is_success() {
        return failed_sample(
            route,
            target_kind,
            network_mode,
            started,
            elapsed,
            "http_status",
        );
    }
    let bytes = body.len().min(MAX_RESPONSE_BYTES) as u64;
    let total = start.elapsed().as_millis() as u64;
    NetworkSample {
        sample_id: sample_id(),
        route: route.into(),
        target_kind: target_kind.into(),
        network_mode: network_mode.into(),
        platform_id: None,
        browser_id: None,
        started_at_ms: started,
        duration_ms: Some(total),
        connect_ms: None,
        ttfb_ms: None,
        total_ms: Some(total),
        response_bytes: Some(bytes),
        download_kbps: Some(if body_started.elapsed().as_millis() == 0 {
            0
        } else {
            bytes.saturating_mul(8) / body_started.elapsed().as_millis() as u64
        }),
        status: "ok".into(),
        error_code: None,
        client_version: None,
    }
}
async fn read_limited(mut response: reqwest::Response) -> Result<Vec<u8>, reqwest::Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let remaining = MAX_RESPONSE_BYTES.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if body.len() >= MAX_RESPONSE_BYTES {
            break;
        }
    }
    Ok(body)
}
fn classify_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_status() {
        "http_status"
    } else if error.is_connect() {
        "connect"
    } else if error.to_string().to_ascii_lowercase().contains("dns") {
        "dns"
    } else {
        "tls"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;
    #[test]
    fn sample_serializes_camel_case_without_sensitive_fields() {
        let sample =
            NetworkSample::success("0123456789abcdef", "management", "api", "direct", 12, 3);
        let value = serde_json::to_value(&sample).unwrap();
        assert_eq!(value["sampleId"], "0123456789abcdef");
        assert!(value.get("sample_id").is_none());
        let text = value.to_string();
        for secret in ["http://", "token", "header", "response body"] {
            assert!(!text.contains(secret));
        }
    }
    #[test]
    fn snapshot_serializes_upload_counters_for_ipc() {
        let snapshot = NetworkDiagnosticsSnapshot {
            samples: Vec::new(),
            device_id: Some("device".into()),
            upload_status: "retrying".into(),
            queued_count: 3,
            dropped_count: 2,
        };
        let value = serde_json::to_value(snapshot).unwrap();
        assert_eq!(value["uploadStatus"], "retrying");
        assert_eq!(value["queuedCount"], 3);
        assert_eq!(value["droppedCount"], 2);
    }
    #[test]
    fn timeout_is_bounded_to_eight_seconds() {
        assert_eq!(MAX_PROBE_DURATION_MS, 8000);
    }
    #[test]
    fn timeout_sample_has_no_partial_stages() {
        let sample = failed_sample(
            "management",
            "api",
            "direct",
            1,
            MAX_PROBE_DURATION_MS,
            "timeout",
        );
        assert_eq!(sample.total_ms, Some(8000));
        assert!(sample.connect_ms.is_none() && sample.ttfb_ms.is_none());
    }
    #[tokio::test]
    async fn proxy_disabled_is_classified_without_network_access() {
        let sample = measure_proxy(None, "http://127.0.0.1/").await;
        assert_eq!(sample.error_code.as_deref(), Some("proxy_disabled"));
    }

    #[tokio::test(start_paused = true)]
    async fn an_expired_shared_deadline_returns_an_eight_second_timeout_sample() {
        let deadline = tokio::time::Instant::now() - Duration::from_millis(1);
        let sample = measure_management_until("http://127.0.0.1:9/", deadline).await;
        assert_eq!(sample.error_code.as_deref(), Some("timeout"));
        assert_eq!(sample.total_ms, Some(MAX_PROBE_DURATION_MS));
    }

    #[tokio::test]
    async fn management_probe_records_timing_and_bytes() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = crate::httpio::read_head(&mut stream).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                )
                .await
                .unwrap();
        });
        let sample = measure_management(&format!("http://{address}/")).await;
        assert_eq!(sample.status, "ok");
        assert_eq!(sample.response_bytes, Some(5));
        assert!(
            sample.connect_ms.is_none() && sample.ttfb_ms.is_none() && sample.total_ms.is_some()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn management_total_includes_slow_body_read() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = crate::httpio::read_head(&mut stream).await.unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nhello",
                )
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(25)).await;
            stream.write_all(b"world").await.unwrap();
        });
        let sample = measure_management(&format!("http://{address}/")).await;
        assert_eq!(sample.status, "ok");
        assert!(sample.total_ms.unwrap_or_default() >= 20);
        server.await.unwrap();
    }
}
