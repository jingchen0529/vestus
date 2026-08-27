//! 上游 HTTP 代理连接。
//!
//! 安全不变量：
//! 1. 本模块的 `UpstreamProxy::connect` 是**默认路径上唯一**的出站 TCP 连接点
//!    （reqwest 的探测客户端同样被强制绑定到该代理）；唯一的另一个出站点是
//!    [`crate::bypass::DirectHosts::connect`]，它只服务于管理员显式下发的直连域名。
//! 2. 任何“上游失败就直连目标站点”的代码路径都不允许出现，出错一律向上返回错误；
//!    反方向同理，直连失败也不会退回代理。路由在
//!    [`crate::adapter`] 里一次决定，不做任何兜底切换。
//! 3. 直连路径不携带本模块的任何凭据。

use std::fmt;
use std::time::Duration;

use base64::Engine;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::httpio;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// 上游代理及其认证信息。
///
/// 口令只存在于内存，`Debug` 实现里被替换掉，避免随日志或 panic 信息外泄。
#[derive(Clone)]
pub struct UpstreamProxy {
    pub host: String,
    pub port: u16,
    pub username: String,
    password: String,
}

impl fmt::Debug for UpstreamProxy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("UpstreamProxy")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .finish()
    }
}

impl UpstreamProxy {
    pub fn new(
        host: impl Into<String>,
        port: u16,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        Self {
            host: host.into(),
            port,
            username: username.into(),
            password: password.into(),
        }
    }

    /// 供 reqwest 使用的代理 URL，不含任何凭据。
    pub fn proxy_url_without_credentials(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    /// 仅在拼装请求头时调用，调用点不得写入日志。
    pub fn expose_password(&self) -> &str {
        &self.password
    }

    /// `Proxy-Authorization` 头部值。
    fn authorization_value(&self) -> String {
        let raw = format!("{}:{}", self.username, self.password);
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
        format!("Basic {encoded}")
    }

    /// 建立到上游代理的 TCP 连接。整个应用唯一的出站连接点。
    pub async fn connect(&self) -> Result<TcpStream, TunnelError> {
        let addr = (self.host.as_str(), self.port);
        let stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
            .await
            .map_err(|_| TunnelError::ConnectTimeout)?
            .map_err(|e| TunnelError::ConnectFailed(e.to_string()))?;
        stream.set_nodelay(true).ok();
        Ok(stream)
    }

    /// 通过上游代理为 `host:port` 打开 CONNECT 隧道。
    ///
    /// 返回隧道流，以及读取响应头时多读到的服务端字节。
    pub async fn open_tunnel(
        &self,
        target_host: &str,
        target_port: u16,
    ) -> Result<(TcpStream, Vec<u8>), TunnelError> {
        let mut stream = self.connect().await?;
        let authority = format_authority(target_host, target_port);

        let request = format!(
            "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\nProxy-Authorization: {}\r\nProxy-Connection: Keep-Alive\r\n\r\n",
            self.authorization_value()
        );

        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|e| TunnelError::Io(e.to_string()))?;
        stream
            .flush()
            .await
            .map_err(|e| TunnelError::Io(e.to_string()))?;

        let (head, leftover) = timeout(HANDSHAKE_TIMEOUT, httpio::read_head(&mut stream))
            .await
            .map_err(|_| TunnelError::HandshakeTimeout)?
            .map_err(|e| TunnelError::Io(e.to_string()))?;

        let status = httpio::parse_status_code(&head).map_err(TunnelError::Protocol)?;

        match status {
            200 => Ok((stream, leftover)),
            407 => Err(TunnelError::AuthFailed),
            other => Err(TunnelError::Rejected(other)),
        }
    }

    /// 为普通 HTTP 请求准备发往上游的请求头。
    ///
    /// 保留请求行的绝对形式（代理需要），剔除逐跳头部，注入我们自己的认证。
    pub fn rewrite_plain_head(&self, req: &httpio::RequestHead) -> String {
        let mut out = format!("{} {} {}\r\n", req.method, req.target, req.version);

        for line in &req.header_lines {
            let name = line.split_once(':').map(|(k, _)| k.trim()).unwrap_or("");
            let drop = matches!(
                name.to_ascii_lowercase().as_str(),
                "proxy-authorization" | "proxy-connection" | "connection" | "keep-alive"
            );
            if !drop {
                out.push_str(line);
                out.push_str("\r\n");
            }
        }

        out.push_str(&format!(
            "Proxy-Authorization: {}\r\n",
            self.authorization_value()
        ));
        // 本阶段普通 HTTP 不复用连接：一请求一上游连接，响应边界最清晰。
        out.push_str("Connection: close\r\n");
        out.push_str("\r\n");
        out
    }
}

fn format_authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 隧道建立过程中的失败原因，映射为界面上可读的提示。
#[derive(Debug, Clone, thiserror::Error)]
pub enum TunnelError {
    #[error("无法连接代理服务器：{0}")]
    ConnectFailed(String),
    #[error("连接代理服务器超时")]
    ConnectTimeout,
    #[error("等待代理响应超时")]
    HandshakeTimeout,
    #[error("代理账号或密码错误（HTTP 407）")]
    AuthFailed,
    #[error("代理拒绝 CONNECT，返回状态码 {0}")]
    Rejected(u16),
    #[error("代理响应无法解析：{0}")]
    Protocol(String),
    #[error("与代理通信失败：{0}")]
    Io(String),
}

impl TunnelError {
    /// 供前端归类展示的短代码。
    pub fn code(&self) -> &'static str {
        match self {
            TunnelError::ConnectFailed(_) => "connect_failed",
            TunnelError::ConnectTimeout => "connect_timeout",
            TunnelError::HandshakeTimeout => "handshake_timeout",
            TunnelError::AuthFailed => "auth_failed",
            TunnelError::Rejected(_) => "rejected",
            TunnelError::Protocol(_) => "protocol_error",
            TunnelError::Io(_) => "io_error",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy() -> UpstreamProxy {
        UpstreamProxy::new("203.0.113.10", 8080, "user", "s3cret")
    }

    #[test]
    fn debug_never_leaks_password() {
        let text = format!("{:?}", proxy());
        assert!(text.contains("<redacted>"));
        assert!(!text.contains("s3cret"));
    }

    #[test]
    fn proxy_url_has_no_credentials() {
        let url = proxy().proxy_url_without_credentials();
        assert_eq!(url, "http://203.0.113.10:8080");
        assert!(!url.contains("user"));
    }

    #[test]
    fn authorization_is_basic_base64() {
        // base64("user:s3cret")
        assert_eq!(proxy().authorization_value(), "Basic dXNlcjpzM2NyZXQ=");
    }

    #[test]
    fn rewrite_drops_hop_by_hop_and_injects_auth() {
        let head = b"GET http://example.com/x HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\nProxy-Authorization: Basic spoofed\r\nAccept: */*\r\n\r\n";
        let req = httpio::parse_request_head(head).unwrap();
        let out = proxy().rewrite_plain_head(&req);

        assert!(out.starts_with("GET http://example.com/x HTTP/1.1\r\n"));
        assert!(out.contains("Accept: */*"));
        assert!(!out.contains("Basic spoofed"));
        assert!(!out.to_lowercase().contains("proxy-connection"));
        assert_eq!(out.matches("Proxy-Authorization:").count(), 1);
        assert!(out.contains("Connection: close"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn formats_ipv6_authority() {
        assert_eq!(format_authority("::1", 443), "[::1]:443");
        assert_eq!(format_authority("example.com", 443), "example.com:443");
    }
}
