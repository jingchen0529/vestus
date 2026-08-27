//! 本地 HTTP 代理适配器。
//!
//! Chromium 只连接 `http://127.0.0.1:<port>`，不接触上游凭据；由本模块
//! 补上 `Proxy-Authorization` 再转发到管理员分配的上游代理。
//!
//! 安全不变量：
//! 1. 只监听 127.0.0.1，不对外暴露。
//! 2. 默认每条连接都必须经过 [`UpstreamProxy`]。唯一例外是命中管理员下发的
//!    直连域名列表 [`DirectHosts`]，此时由 [`DirectHosts::connect`] 直接连接
//!    目标站点，并且该路径上不会出现任何上游凭据。
//! 3. 路由结果固定：代理路径失败一律回 502/407，绝不改为直连；直连路径失败
//!    一律回 502，绝不改走代理。
//! 4. 直连域名列表由服务端下发，桌面端界面和被打开的网页都无法追加。

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::bypass::{DirectError, DirectHosts};
use crate::httpio::{self, RequestHead};
use crate::upstream::{TunnelError, UpstreamProxy};

/// 运行中的适配器句柄。
pub struct AdapterHandle {
    pub port: u16,
    shutdown: watch::Sender<bool>,
}

impl AdapterHandle {
    /// 外置 Chromium 使用的代理 URL，不含凭据。
    #[cfg(test)]
    pub fn local_proxy_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Stop listening and cancel every active client task. The per-connection
    /// shutdown receiver makes established CONNECT tunnels drop immediately
    /// instead of waiting for their next read or write.
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

impl Drop for AdapterHandle {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
    }
}

/// 一条连接的两种去向：上游代理，或管理员允许的直连。
struct Routes {
    upstream: UpstreamProxy,
    direct: DirectHosts,
}

impl Routes {
    /// 只有主机名命中管理员下发的列表时才返回 true。
    fn is_direct(&self, host: &str) -> bool {
        self.direct.matches(host)
    }
}

/// 在 127.0.0.1 的随机端口上启动适配器。
pub async fn start(upstream: UpstreamProxy, direct: DirectHosts) -> std::io::Result<AdapterHandle> {
    // 端口固定为 0，由内核分配；只绑定回环地址。
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
    let port = listener.local_addr()?.port();

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let handle = AdapterHandle {
        port,
        shutdown: shutdown_tx,
    };

    let routes = Arc::new(Routes { upstream, direct });
    tokio::spawn(async move {
        let mut shutdown_rx = shutdown_rx;
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                }
                accepted = listener.accept() => {
                    let (stream, peer) = match accepted {
                        Ok(pair) => pair,
                        Err(_) => continue,
                    };

                    // 双重保险：即使绑定被改动，也只服务回环来源。
                    if !peer.ip().is_loopback() {
                        continue;
                    }

                    let routes = Arc::clone(&routes);
                    let client_shutdown = shutdown_rx.clone();

                    tokio::spawn(async move {
                        handle_client(stream, routes, client_shutdown).await;
                    });
                }
            }
        }
    });

    Ok(handle)
}

async fn handle_client(
    client: TcpStream,
    routes: Arc<Routes>,
    mut shutdown: watch::Receiver<bool>,
) {
    tokio::select! {
        biased;
        _ = wait_for_shutdown(&mut shutdown) => {}
        _ = handle_client_active(client, routes) => {}
    }
}

async fn wait_for_shutdown(shutdown: &mut watch::Receiver<bool>) {
    if *shutdown.borrow() {
        return;
    }
    while shutdown.changed().await.is_ok() {
        if *shutdown.borrow_and_update() {
            return;
        }
    }
}

async fn handle_client_active(mut client: TcpStream, routes: Arc<Routes>) {
    client.set_nodelay(true).ok();

    let (head_bytes, leftover) = match httpio::read_head(&mut client).await {
        Ok(pair) => pair,
        Err(_) => return,
    };

    let req = match httpio::parse_request_head(&head_bytes) {
        Ok(req) => req,
        Err(_) => {
            let _ = write_simple(&mut client, 400, "Bad Request").await;
            return;
        }
    };

    let is_connect = req.method.eq_ignore_ascii_case("CONNECT");
    let authority = if is_connect {
        req.target.clone()
    } else {
        match httpio::authority_from_absolute_target(&req.target) {
            Some(authority) => authority,
            None => {
                // 非绝对形式说明客户端没把我们当代理用，直接拒绝。
                let _ = write_simple(&mut client, 400, "Bad Request").await;
                return;
            }
        }
    };

    let _ = if is_connect {
        serve_connect(&mut client, &req, &routes, leftover).await
    } else {
        serve_plain(&mut client, &req, &authority, &routes, leftover).await
    };
}

/// HTTPS：建立隧道后双向透传。默认经上游代理，命中直连列表时直接连目标站点。
async fn serve_connect(
    client: &mut TcpStream,
    req: &RequestHead,
    routes: &Routes,
    client_leftover: Vec<u8>,
) -> Result<(), TunnelError> {
    let (host, port) = match httpio::split_host_port(&req.target) {
        Some(pair) => pair,
        None => {
            let err = TunnelError::Protocol("CONNECT 目标格式错误".into());
            let _ = write_simple(client, 400, "Bad Request").await;
            return Err(err);
        }
    };

    let opened = if routes.is_direct(&host) {
        // 直连路径：不发 CONNECT，也不携带任何代理凭据。
        match routes.direct.connect(&host, port).await {
            Ok(stream) => Ok((stream, Vec::new())),
            Err(error) => {
                // 直连失败固定回 502，绝不改走代理。
                let _ = write_direct_error(client, &error).await;
                return Err(TunnelError::ConnectFailed(error.to_string()));
            }
        }
    } else {
        routes.upstream.open_tunnel(&host, port).await
    };

    match opened {
        Ok((mut server, server_leftover)) => {
            // 先告知客户端隧道已就绪，之后的字节全部原样透传。
            if client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .is_err()
            {
                return Err(TunnelError::Io("回写 200 失败".into()));
            }

            // 上游在响应头后可能已经带了数据，必须先补给客户端。
            if !server_leftover.is_empty() && client.write_all(&server_leftover).await.is_err() {
                return Err(TunnelError::Io("转发上游残留数据失败".into()));
            }
            // 客户端在 CONNECT 后紧跟的 ClientHello 同理。
            if !client_leftover.is_empty() && server.write_all(&client_leftover).await.is_err() {
                return Err(TunnelError::Io("转发客户端残留数据失败".into()));
            }

            let _ = tokio::io::copy_bidirectional(client, &mut server).await;
            Ok(())
        }
        Err(err) => {
            // 认证失败按 407 回传，其余按 502。两条路径都不互相回退。
            let (code, reason) = match err {
                TunnelError::AuthFailed => (407, "Proxy Authentication Required"),
                _ => (502, "Bad Gateway"),
            };
            let _ = write_simple(client, code, reason).await;
            Err(err)
        }
    }
}

/// 普通 HTTP：改写请求头后转发，响应按字节回传。
async fn serve_plain(
    client: &mut TcpStream,
    req: &RequestHead,
    authority: &str,
    routes: &Routes,
    client_leftover: Vec<u8>,
) -> Result<(), TunnelError> {
    let host = authority_host(authority);
    let direct = routes.is_direct(&host);

    let mut server = if direct {
        let port = authority_port(authority, 80);
        match routes.direct.connect(&host, port).await {
            Ok(stream) => stream,
            Err(error) => {
                let _ = write_direct_error(client, &error).await;
                return Err(TunnelError::ConnectFailed(error.to_string()));
            }
        }
    } else {
        match routes.upstream.connect().await {
            Ok(stream) => stream,
            Err(err) => {
                let _ = write_simple(client, 502, "Bad Gateway").await;
                return Err(err);
            }
        }
    };

    let head = if direct {
        httpio::rewrite_origin_form_head(req)
    } else {
        routes.upstream.rewrite_plain_head(req)
    };
    if server.write_all(head.as_bytes()).await.is_err() {
        let _ = write_simple(client, 502, "Bad Gateway").await;
        return Err(TunnelError::Io("转发请求头失败".into()));
    }

    // 已经读到的 body 起始字节先补上，剩下的交给双向拷贝。
    if !client_leftover.is_empty() && server.write_all(&client_leftover).await.is_err() {
        return Err(TunnelError::Io("转发请求体失败".into()));
    }

    let _ = tokio::io::copy_bidirectional(client, &mut server).await;
    Ok(())
}

/// 从 `host` / `host:port` / `[::1]:80` 中取出主机名。
fn authority_host(authority: &str) -> String {
    match httpio::split_host_port(authority) {
        Some((host, _)) => host,
        None => authority
            .strip_prefix('[')
            .and_then(|rest| rest.split_once(']').map(|(host, _)| host.to_string()))
            .unwrap_or_else(|| authority.to_string()),
    }
}

fn authority_port(authority: &str, fallback: u16) -> u16 {
    httpio::split_host_port(authority)
        .map(|(_, port)| port)
        .unwrap_or(fallback)
}

async fn write_simple(client: &mut TcpStream, code: u16, reason: &str) -> std::io::Result<()> {
    write_response(client, code, reason, None).await
}

/// 直连路径失败时的 502。
///
/// 额外带一个短代码，用来区分 DNS 失败、被安全策略拦下和超时——直连域名
/// 由管理员配置，这三种情况的处理完全不同。短代码只描述直连结果，不含
/// 代理地址、账号或任何配置信息。
async fn write_direct_error(client: &mut TcpStream, error: &DirectError) -> std::io::Result<()> {
    write_response(client, 502, "Bad Gateway", Some(error.code())).await
}

async fn write_response(
    client: &mut TcpStream,
    code: u16,
    reason: &str,
    direct_error: Option<&str>,
) -> std::io::Result<()> {
    // 错误页不含代理地址、账号或任何配置信息。
    let body = format!("{code} {reason}");
    let extra = match direct_error {
        Some(code) => format!("X-Vestus-Direct-Error: {code}\r\n"),
        None => String::new(),
    };
    let response = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
        body.len()
    );
    client.write_all(response.as_bytes()).await?;
    client.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt as _;

    /// 上游不可达时必须回 502，且不得连接目标站点。
    #[test]
    fn upstream_down_returns_502_and_never_direct() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            // 指向一个必然连不上的地址
            let upstream = UpstreamProxy::new("127.0.0.1", 1, "u", "p");
            let handle = start(upstream, DirectHosts::empty()).await.unwrap();

            let mut client = TcpStream::connect(("127.0.0.1", handle.port))
                .await
                .unwrap();
            client
                .write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
                .await
                .unwrap();

            let mut buf = Vec::new();
            client.read_to_end(&mut buf).await.unwrap();
            let text = String::from_utf8_lossy(&buf);
            assert!(text.starts_with("HTTP/1.1 502"), "实际响应：{text}");
        });
    }

    /// 上游返回 407 时要如实透传认证失败，不能降级为直连。
    #[test]
    fn upstream_407_is_surfaced() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            // 假上游：对任何 CONNECT 都回 407
            let fake = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let fake_port = fake.local_addr().unwrap().port();
            tokio::spawn(async move {
                while let Ok((mut s, _)) = fake.accept().await {
                    let _ = httpio::read_head(&mut s).await;
                    let _ = s
                        .write_all(
                            b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
                        )
                        .await;
                }
            });

            let handle = start(UpstreamProxy::new("127.0.0.1", fake_port, "u", "bad"), DirectHosts::empty())
                .await
                .unwrap();

            let mut client = TcpStream::connect(("127.0.0.1", handle.port)).await.unwrap();
            client
                .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
                .await
                .unwrap();

            let mut buf = Vec::new();
            client.read_to_end(&mut buf).await.unwrap();
            let text = String::from_utf8_lossy(&buf);
            assert!(text.starts_with("HTTP/1.1 407"), "实际响应：{text}");
        });
    }

    /// 端到端：假上游接受 CONNECT，隧道内数据双向可达。
    #[test]
    fn tunnel_forwards_bytes_through_upstream() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            let fake = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let fake_port = fake.local_addr().unwrap().port();

            tokio::spawn(async move {
                let (mut s, _) = fake.accept().await.unwrap();
                let (head, leftover) = httpio::read_head(&mut s).await.unwrap();
                let req = httpio::parse_request_head(&head).unwrap();
                assert_eq!(req.method, "CONNECT");
                // 适配器必须已经注入认证头
                assert!(req.has_header("proxy-authorization"));

                s.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .unwrap();

                // 把客户端发来的内容回显，验证双向透传
                if !leftover.is_empty() {
                    s.write_all(&leftover).await.unwrap();
                }
                let mut buf = [0u8; 64];
                if let Ok(n) = s.read(&mut buf).await {
                    if n > 0 {
                        s.write_all(&buf[..n]).await.unwrap();
                    }
                }
            });

            let handle = start(
                UpstreamProxy::new("127.0.0.1", fake_port, "u", "p"),
                DirectHosts::empty(),
            )
            .await
            .unwrap();

            let mut client = TcpStream::connect(("127.0.0.1", handle.port))
                .await
                .unwrap();
            client
                .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
                .await
                .unwrap();

            let mut head = [0u8; 39];
            client.read_exact(&mut head).await.unwrap();
            assert!(String::from_utf8_lossy(&head).starts_with("HTTP/1.1 200"));
            client.write_all(b"PING").await.unwrap();
            let mut echo = [0u8; 4];
            client.read_exact(&mut echo).await.unwrap();
            assert_eq!(&echo, b"PING");
        });
    }

    /// `stop` must cancel an already-established CONNECT tunnel immediately,
    /// even when neither peer would otherwise perform another write.
    #[test]
    fn stop_closes_established_tunnels() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            let fake = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let fake_port = fake.local_addr().unwrap().port();
            tokio::spawn(async move {
                let (mut stream, _) = fake.accept().await.unwrap();
                let _ = httpio::read_head(&mut stream).await.unwrap();
                stream
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .unwrap();
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            });

            let handle = start(
                UpstreamProxy::new("127.0.0.1", fake_port, "u", "p"),
                DirectHosts::empty(),
            )
            .await
            .unwrap();
            let mut client = TcpStream::connect(("127.0.0.1", handle.port))
                .await
                .unwrap();
            client
                .write_all(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let (head, _) = httpio::read_head(&mut client).await.unwrap();
            assert_eq!(httpio::parse_status_code(&head).unwrap(), 200);
            handle.stop();
            let mut byte = [0u8; 1];
            let read =
                tokio::time::timeout(std::time::Duration::from_secs(1), client.read(&mut byte))
                    .await
                    .expect("停止后客户端应立即收到 EOF")
                    .unwrap();
            assert_eq!(read, 0);
        });
    }

    /// 非绝对形式的请求（把适配器当普通服务器用）必须被拒绝。
    #[test]
    fn relative_request_is_rejected() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            let handle = start(
                UpstreamProxy::new("127.0.0.1", 1, "u", "p"),
                DirectHosts::empty(),
            )
            .await
            .unwrap();

            let mut client = TcpStream::connect(("127.0.0.1", handle.port))
                .await
                .unwrap();
            client
                .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .await
                .unwrap();

            let mut buf = Vec::new();
            client.read_to_end(&mut buf).await.unwrap();
            assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 400"));
        });
    }

    #[test]
    fn listener_binds_loopback_only() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            let handle = start(
                UpstreamProxy::new("127.0.0.1", 1, "u", "p"),
                DirectHosts::empty(),
            )
            .await
            .unwrap();
            assert!(handle.local_proxy_url().starts_with("http://127.0.0.1:"));
            // URL 中不得出现凭据
            assert!(!handle.local_proxy_url().contains('@'));
        });
    }

    /// 命中直连列表的 CONNECT 必须完全绕开上游：上游此处不可达，
    /// 一旦走错路径就会收到 502。
    #[test]
    fn direct_host_tunnels_without_touching_upstream() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            let origin = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let origin_addr = origin.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut stream, _) = origin.accept().await.unwrap();
                // 直连不会有 CONNECT 握手，收到的第一批字节就是隧道内容。
                let mut buf = [0u8; 64];
                if let Ok(n) = stream.read(&mut buf).await {
                    if n > 0 {
                        stream.write_all(&buf[..n]).await.unwrap();
                    }
                }
            });

            let handle = start(
                // 上游端口 1 必然连不上：走代理就一定失败。
                UpstreamProxy::new("127.0.0.1", 1, "u", "p"),
                DirectHosts::for_tests(&["lf3-ad-platform.byteadverts.com"], origin_addr),
            )
            .await
            .unwrap();

            let mut client = TcpStream::connect(("127.0.0.1", handle.port))
                .await
                .unwrap();
            client
                .write_all(b"CONNECT lf3-ad-platform.byteadverts.com:443 HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let (head, _) = httpio::read_head(&mut client).await.unwrap();
            assert_eq!(httpio::parse_status_code(&head).unwrap(), 200);

            client.write_all(b"HELLO").await.unwrap();
            let mut echo = [0u8; 5];
            client.read_exact(&mut echo).await.unwrap();
            assert_eq!(&echo, b"HELLO");
        });
    }

    /// 直连的普通 HTTP 必须用 origin-form，并且不携带任何代理凭据。
    #[test]
    fn direct_plain_http_uses_origin_form_and_no_credentials() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            let origin = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let origin_addr = origin.local_addr().unwrap();
            let (tx, rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let (mut stream, _) = origin.accept().await.unwrap();
                let (head, _) = httpio::read_head(&mut stream).await.unwrap();
                let text = String::from_utf8_lossy(&head).into_owned();
                stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
                    .await
                    .unwrap();
                tx.send(text).unwrap();
            });

            let handle = start(
                UpstreamProxy::new("127.0.0.1", 1, "u", "p"),
                DirectHosts::for_tests(&["lf3-ad-platform.byteadverts.com"], origin_addr),
            )
            .await
            .unwrap();

            let mut client = TcpStream::connect(("127.0.0.1", handle.port))
                .await
                .unwrap();
            client
                .write_all(
                    b"GET http://lf3-ad-platform.byteadverts.com/asset?v=1 HTTP/1.1\r\nHost: lf3-ad-platform.byteadverts.com\r\n\r\n",
                )
                .await
                .unwrap();

            let (response, _) = httpio::read_head(&mut client).await.unwrap();
            assert_eq!(httpio::parse_status_code(&response).unwrap(), 204);

            let received = rx.await.unwrap();
            assert!(
                received.starts_with("GET /asset?v=1 HTTP/1.1\r\n"),
                "实际请求行：{received}"
            );
            assert!(!received.to_ascii_lowercase().contains("proxy-authorization"));
        });
    }

    /// 配了直连列表以后，未命中的域名仍然必须走上游并带认证头。
    #[test]
    fn non_matching_host_still_goes_through_upstream() {
        let rt = crate::rt::runtime();
        rt.block_on(async {
            let fake = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let fake_port = fake.local_addr().unwrap().port();
            let (tx, rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let (mut stream, _) = fake.accept().await.unwrap();
                let (head, _) = httpio::read_head(&mut stream).await.unwrap();
                let req = httpio::parse_request_head(&head).unwrap();
                stream
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .unwrap();
                tx.send((req.method.clone(), req.has_header("proxy-authorization")))
                    .unwrap();
            });

            // 直连目标指向一个不会被用到的地址：命中才会连它。
            let unused = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let handle = start(
                UpstreamProxy::new("127.0.0.1", fake_port, "u", "p"),
                DirectHosts::for_tests(
                    &["lf3-ad-platform.byteadverts.com"],
                    unused.local_addr().unwrap(),
                ),
            )
            .await
            .unwrap();

            let mut client = TcpStream::connect(("127.0.0.1", handle.port))
                .await
                .unwrap();
            client
                .write_all(b"CONNECT other.example.test:443 HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let (head, _) = httpio::read_head(&mut client).await.unwrap();
            assert_eq!(httpio::parse_status_code(&head).unwrap(), 200);

            let (method, had_auth) = rx.await.unwrap();
            assert_eq!(method, "CONNECT");
            assert!(had_auth, "未命中直连的请求必须带上游认证头");
        });
    }
}
