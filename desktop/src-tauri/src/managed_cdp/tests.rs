//! Opt-in real Chromium regression; all pages, cookies and profiles are local.

use super::*;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct TestBrowser {
    child: Child,
    dir: PathBuf,
}

impl Drop for TestBrowser {
    fn drop(&mut self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while matches!(self.child.try_wait(), Ok(None)) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn launch_test_browser() -> (TestBrowser, DevToolsEndpoint) {
    let executable = std::env::var_os("VESTUS_TEST_CHROMIUM_PATH")
        .map(PathBuf::from)
        .expect("set VESTUS_TEST_CHROMIUM_PATH to an existing Chromium binary");
    assert!(executable.is_file(), "test Chromium executable must exist");
    let dir = std::env::temp_dir().join(format!(
        "vestus-managed-cdp-regression-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir(&dir).unwrap();
    let child = Command::new(executable)
        .arg(format!("--user-data-dir={}", dir.display()))
        .args([
            "--headless=new",
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-crash-reporter",
            "--disable-breakpad",
            "--password-store=basic",
            "--use-mock-keychain",
            "--no-proxy-server",
            "about:blank",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut browser = TestBrowser { child, dir };
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let endpoint = loop {
        if let Ok(contents) = std::fs::read_to_string(browser.dir.join("DevToolsActivePort")) {
            if let Some(endpoint) = crate::browser::parse_devtools_active_port(&contents) {
                break endpoint;
            }
        }
        assert!(
            browser.child.try_wait().unwrap().is_none(),
            "browser exited during startup"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "DevTools port timeout"
        );
        std::thread::sleep(Duration::from_millis(30));
    };
    (browser, endpoint)
}

async fn test_page_server() -> (String, Arc<AtomicBool>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let cookie_seen = Arc::new(AtomicBool::new(false));
    let seen = cookie_seen.clone();
    let server = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                loop {
                    let mut buf = [0; 2048];
                    let count = stream.read(&mut buf).await.unwrap_or(0);
                    if count == 0 {
                        return;
                    }
                    request.extend_from_slice(&buf[..count]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        break;
                    }
                    if request.len() > 16 * 1024 {
                        return;
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let body = match path {
                    "/immediate" => {
                        seen.store(request.contains("regression_session=local-only"), Ordering::Release);
                        "<!doctype html><script>location.replace('/sso_logout?test=redirect')</script>"
                    }
                    "/spa" => "<!doctype html><script>history.replaceState({}, '', '/sso_logout?test=spa')</script>",
                    _ => "<!doctype html><title>Local session fixture</title><p>Local only</p>",
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len(),
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (base, cookie_seen, server)
}

fn local_session(target: String) -> ManagedSession {
    validate_session(
        serde_json::from_value(json!({
            "targetUrl": target, "allowedHosts": ["127.0.0.1"],
            "cookies": [{"name": "regression_session", "value": "local-only", "domain": "127.0.0.1",
                         "path": "/", "secure": false, "httpOnly": true}]
        }))
        .unwrap(),
    )
    .unwrap()
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; fresh headless browser and loopback fixture only"]
fn real_chromium_observes_immediate_redirect_and_same_document_logout() {
    crate::rt::runtime().block_on(async {
        let (base, cookie_seen, server) = test_page_server().await;
        let policy = LogoutPolicy {
            endpoint: Url::parse(&format!("{base}/sso_logout")).unwrap(),
        };
        for path in ["/immediate", "/spa"] {
            let (_browser, endpoint) = launch_test_browser();
            let session = local_session(format!("{base}{path}"));
            let watch =
                prepare_logout_watch_with_policy(&endpoint, policy.clone())
                    .await
                    .unwrap();
            let waiter = tokio::spawn(watch.wait());
            inject_session(&endpoint, &session).await.unwrap();
            assert!(
                timeout(Duration::from_secs(10), waiter)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
                "missing event for {path}"
            );
            crate::cdp::request_exit(&endpoint).await.unwrap();
        }
        assert!(
            cookie_seen.load(Ordering::Acquire),
            "cookie must be installed before the first navigation"
        );
        server.abort();
    });
}
