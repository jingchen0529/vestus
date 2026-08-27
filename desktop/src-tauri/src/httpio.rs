//! 最小 HTTP 报文头读取与解析。
//!
//! 适配器只需要看懂请求行和头部字段，报文体一律按字节透传，
//! 因此这里不引入完整 HTTP 实现，避免改写 body 造成语义偏差。

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt};

/// 头部上限，防止恶意客户端用超长头部耗尽内存。
pub const MAX_HEAD: usize = 64 * 1024;

/// 请求行 + 头部字段。
#[derive(Debug, Clone)]
pub struct RequestHead {
    pub method: String,
    pub target: String,
    pub version: String,
    /// 原始头部行，保持顺序与大小写，转发时尽量少改动。
    pub header_lines: Vec<String>,
}

impl RequestHead {
    /// 判断某个头部字段是否存在（大小写不敏感）。仅测试断言使用。
    #[cfg(test)]
    pub fn has_header(&self, name: &str) -> bool {
        self.header_lines
            .iter()
            .any(|line| match line.split_once(':') {
                Some((key, _)) => key.trim().eq_ignore_ascii_case(name),
                None => false,
            })
    }
}

/// 读取到第一个 `\r\n\r\n` 为止。
///
/// 返回 `(head, leftover)`：`head` 含结尾空行，`leftover` 是同一次读取中
/// 多读到的后续字节（例如 CONNECT 之后紧跟的 TLS ClientHello）。
/// 这部分必须由调用方继续转发，否则握手会卡死。
pub async fn read_head<R>(reader: &mut R) -> io::Result<(Vec<u8>, Vec<u8>)>
where
    R: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];

    loop {
        if let Some(pos) = find_head_end(&buf) {
            let leftover = buf.split_off(pos);
            return Ok((buf, leftover));
        }

        if buf.len() > MAX_HEAD {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP 头部超过长度上限",
            ));
        }

        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "读取 HTTP 头部时连接已关闭",
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

/// 解析请求行与头部。
pub fn parse_request_head(head: &[u8]) -> Result<RequestHead, String> {
    let text = std::str::from_utf8(head).map_err(|_| "请求头不是合法 UTF-8".to_string())?;
    let mut lines = text.split("\r\n");

    let request_line = lines.next().ok_or_else(|| "缺少请求行".to_string())?;
    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "请求行缺少方法".to_string())?
        .to_string();
    let target = parts
        .next()
        .ok_or_else(|| "请求行缺少目标".to_string())?
        .to_string();
    let version = parts.next().unwrap_or("HTTP/1.1").to_string();

    let header_lines = lines
        .take_while(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect();

    Ok(RequestHead {
        method,
        target,
        version,
        header_lines,
    })
}

/// 从响应头中取出状态码。
pub fn parse_status_code(head: &[u8]) -> Result<u16, String> {
    let text = std::str::from_utf8(head).map_err(|_| "响应头不是合法 UTF-8".to_string())?;
    let status_line = text.split("\r\n").next().unwrap_or_default();
    let mut parts = status_line.split_whitespace();
    let _version = parts.next().ok_or_else(|| "响应行缺少版本".to_string())?;
    let code = parts.next().ok_or_else(|| "响应行缺少状态码".to_string())?;
    code.parse::<u16>()
        .map_err(|_| format!("无法解析状态码：{code}"))
}

/// 从 `http://host:port/path?query` 中取出 `host:port`。
///
/// 只保留 authority，路径和查询串一律丢弃，避免写进日志。
pub fn authority_from_absolute_target(target: &str) -> Option<String> {
    let rest = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() {
        return None;
    }
    // 去掉 userinfo，日志里不需要
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    Some(authority.to_string())
}

/// 拆分 `host:port`，CONNECT 的目标形式。
pub fn split_host_port(authority: &str) -> Option<(String, u16)> {
    // IPv6 字面量：[::1]:443
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = tail.strip_prefix(':')?.parse().ok()?;
        return Some((host.to_string(), port));
    }
    let (host, port) = authority.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

/// 从 `http://host/path?query` 中取出 `/path?query`。
///
/// 目标站点直连时需要 origin-form 请求行；缺少路径时按 `/` 处理。
pub fn path_from_absolute_target(target: &str) -> Option<String> {
    let rest = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("https://"))?;
    match rest.find(['/', '?', '#']) {
        Some(index) => {
            let path = &rest[index..];
            if path.starts_with('/') {
                Some(path.to_string())
            } else {
                // `http://host?query` 这种写法补上根路径
                Some(format!("/{path}"))
            }
        }
        None => Some("/".to_string()),
    }
}

/// 直连目标站点时改写请求头。
///
/// 与 [`crate::upstream::UpstreamProxy::rewrite_plain_head`] 的区别是：请求行
/// 改成 origin-form，并且不注入任何代理认证——直连路径上绝不出现上游凭据。
pub fn rewrite_origin_form_head(req: &RequestHead) -> String {
    let path = path_from_absolute_target(&req.target).unwrap_or_else(|| "/".to_string());
    let mut out = format!("{} {} {}\r\n", req.method, path, req.version);

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

    // 与代理路径一致：一请求一连接，响应边界最清晰。
    out.push_str("Connection: close\r\n");
    out.push_str("\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_connect_request() {
        let head = b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n";
        let req = parse_request_head(head).unwrap();
        assert_eq!(req.method, "CONNECT");
        assert_eq!(req.target, "example.com:443");
        assert!(req.has_header("host"));
        assert!(!req.has_header("proxy-authorization"));
    }

    #[test]
    fn strips_path_from_absolute_target() {
        let authority =
            authority_from_absolute_target("http://example.com:8080/a/b?token=secret").unwrap();
        assert_eq!(authority, "example.com:8080");
    }

    #[test]
    fn splits_ipv6_authority() {
        let (host, port) = split_host_port("[::1]:443").unwrap();
        assert_eq!(host, "::1");
        assert_eq!(port, 443);
    }

    #[test]
    fn extracts_origin_form_path() {
        assert_eq!(
            path_from_absolute_target("http://example.com/a/b?x=1").unwrap(),
            "/a/b?x=1"
        );
        assert_eq!(
            path_from_absolute_target("http://example.com").unwrap(),
            "/"
        );
        assert_eq!(
            path_from_absolute_target("http://example.com?x=1").unwrap(),
            "/?x=1"
        );
        assert!(path_from_absolute_target("example.com/a").is_none());
    }

    #[test]
    fn direct_rewrite_uses_origin_form_and_injects_no_credentials() {
        let head = b"GET http://direct.example.com/a?x=1 HTTP/1.1\r\nHost: direct.example.com\r\nProxy-Authorization: Basic spoofed\r\nAccept: */*\r\n\r\n";
        let req = parse_request_head(head).unwrap();
        let out = rewrite_origin_form_head(&req);

        assert!(out.starts_with("GET /a?x=1 HTTP/1.1\r\n"));
        assert!(out.contains("Host: direct.example.com"));
        assert!(out.contains("Accept: */*"));
        assert!(!out.to_ascii_lowercase().contains("proxy-authorization"));
        assert!(!out.contains("Basic"));
        assert!(out.ends_with("\r\n\r\n"));
    }

    #[test]
    fn reads_head_and_keeps_leftover() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            let raw = b"CONNECT a.com:443 HTTP/1.1\r\n\r\n\x16\x03\x01ABC";
            let mut cursor = std::io::Cursor::new(raw.to_vec());
            let (head, leftover) = read_head(&mut cursor).await.unwrap();
            assert!(head.ends_with(b"\r\n\r\n"));
            assert_eq!(leftover, b"\x16\x03\x01ABC");
        });
    }
}
