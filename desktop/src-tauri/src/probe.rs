//! 出口 IP 探测。
//!
//! 两级验证的 Rust 侧：
//! 1. 先用 [`UpstreamProxy::open_tunnel`] 做一次显式 CONNECT，这样 407 能和
//!    「连不上」「超时」区分开，界面才能给出准确提示；
//! 2. 再用 reqwest 走完整 HTTPS 请求拿到出口 IP。
//!
//! reqwest 客户端一律带 `.no_proxy()`：关掉系统代理自动读取，
//! 保证除了我们显式指定的这一条，不存在第二条出口。

use std::time::Duration;

use crate::upstream::{TunnelError, UpstreamProxy};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, thiserror::Error)]
pub enum ProbeError {
    #[error("{0}")]
    Tunnel(#[from] TunnelError),
    #[error("探测地址无法解析：{0}")]
    BadUrl(String),
    #[error("探测请求失败：{0}")]
    Request(String),
    #[error("探测服务返回 HTTP {0}")]
    Status(u16),
    #[error("无法从探测结果中解析出口 IP")]
    Unparsable,
}

impl ProbeError {
    /// 供前端归类展示的短代码。
    pub fn code(&self) -> &'static str {
        match self {
            ProbeError::Tunnel(e) => e.code(),
            ProbeError::BadUrl(_) => "bad_probe_url",
            ProbeError::Request(_) => "probe_failed",
            ProbeError::Status(_) => "probe_status",
            ProbeError::Unparsable => "probe_unparsable",
        }
    }
}

/// 通过上游代理探测出口 IP。
pub async fn probe_via_upstream(
    upstream: &UpstreamProxy,
    probe_url: &str,
) -> Result<String, ProbeError> {
    let parsed = url::Url::parse(probe_url).map_err(|e| ProbeError::BadUrl(e.to_string()))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| ProbeError::BadUrl("缺少主机名".into()))?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| ProbeError::BadUrl("无法确定端口".into()))?;

    // 第一步：显式握手，把 407 单独识别出来
    let (_stream, _leftover) = upstream.open_tunnel(&host, port).await?;

    // 第二步：完整请求，凭据交给 reqwest 处理
    let proxy = reqwest::Proxy::all(upstream.proxy_url_without_credentials())
        .map_err(|e| ProbeError::Request(sanitize(&e.to_string())))?
        .basic_auth(upstream.username(), upstream.expose_password());

    let client = reqwest::Client::builder()
        .proxy(proxy)
        // 关闭系统代理自动读取，避免出现我们没指定的第二条出口
        .no_proxy()
        .timeout(PROBE_TIMEOUT)
        .build()
        .map_err(|e| ProbeError::Request(sanitize(&e.to_string())))?;

    let resp = client
        .get(probe_url)
        .send()
        .await
        .map_err(|e| ProbeError::Request(sanitize(&e.to_string())))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(ProbeError::Status(status.as_u16()));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| ProbeError::Request(sanitize(&e.to_string())))?;

    parse_ip(&body).ok_or(ProbeError::Unparsable)
}

/// 从响应体中取出 IP。支持裸 IP 文本，以及常见的 JSON 字段。
fn parse_ip(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 裸 IP，例如 api.ipify.org 的默认响应
    if trimmed.parse::<std::net::IpAddr>().is_ok() {
        return Some(trimmed.to_string());
    }

    // JSON：ipify 的 ?format=json、httpbin 的 /ip 等
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        for key in ["ip", "origin", "clientIp", "client_ip"] {
            if let Some(raw) = value.get(key).and_then(|v| v.as_str()) {
                // httpbin 的 origin 可能是 "1.2.3.4, 5.6.7.8"
                let first = raw.split(',').next().unwrap_or(raw).trim();
                if first.parse::<std::net::IpAddr>().is_ok() {
                    return Some(first.to_string());
                }
            }
        }
    }

    None
}

/// 清洗错误文本。reqwest 有时会把带凭据的 URL 拼进错误信息里，
/// 这里把任何形似「含 @ 的地址」的片段替换掉。
fn sanitize(message: &str) -> String {
    message
        .split_whitespace()
        .map(|token| {
            if token.contains('@') && (token.contains("://") || token.contains(':')) {
                "<redacted-url>"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_ip() {
        assert_eq!(parse_ip("203.0.113.7\n").as_deref(), Some("203.0.113.7"));
    }

    #[test]
    fn parses_json_ip_field() {
        assert_eq!(
            parse_ip(r#"{"ip":"203.0.113.7"}"#).as_deref(),
            Some("203.0.113.7")
        );
    }

    #[test]
    fn parses_httpbin_origin_chain() {
        assert_eq!(
            parse_ip(r#"{"origin":"203.0.113.7, 198.51.100.2"}"#).as_deref(),
            Some("203.0.113.7")
        );
    }

    #[test]
    fn rejects_html_error_page() {
        assert!(parse_ip("<html>Bad Gateway</html>").is_none());
    }

    #[test]
    fn rejects_empty_body() {
        assert!(parse_ip("   ").is_none());
    }

    #[test]
    fn sanitize_removes_credentials_from_urls() {
        let dirty = "error connecting to http://user:s3cret@1.2.3.4:8080 failed";
        let clean = sanitize(dirty);
        assert!(!clean.contains("s3cret"));
        assert!(clean.contains("<redacted-url>"));
    }

    #[test]
    fn sanitize_keeps_plain_text() {
        let msg = "connection timed out after 20s";
        assert_eq!(sanitize(msg), msg);
    }
}
