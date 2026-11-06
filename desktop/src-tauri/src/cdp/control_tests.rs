//! Control acceptance uses only a loopback page and a fresh temporary profile.
use super::*;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{timeout_at, Instant as TokioInstant};

const READY_TIMEOUT: Duration = Duration::from_secs(30);

async fn readiness_attempt(endpoint: &DevToolsEndpoint, url: &str) -> Result<bool, CdpError> {
    let started = Instant::now();
    eprintln!("CDP readiness phase: Browser.getVersion (connect/handshake/reply)");
    let version = control_command(endpoint, "Browser.getVersion", json!({})).await?;
    if version.get("product").and_then(Value::as_str).is_none() {
        return Err(CdpError::Command(
            "Browser.getVersion returned no product".into(),
        ));
    }
    eprintln!(
        "CDP version response after {:?}: {version}",
        started.elapsed()
    );
    let started = Instant::now();
    eprintln!("CDP readiness phase: Target.getTargets (connect/handshake/reply)");
    let targets = page_targets(endpoint).await?;
    eprintln!(
        "CDP target response after {:?}: {targets:?}",
        started.elapsed()
    );
    Ok(targets.iter().any(|(_, target)| target == url))
}

async fn wait_until_ready(
    endpoint: &DevToolsEndpoint,
    url: &str,
    budget: Duration,
) -> Result<(), CdpError> {
    let deadline = TokioInstant::now() + budget;
    let started = Instant::now();
    loop {
        let result = timeout_at(deadline, readiness_attempt(endpoint, url)).await;
        match result {
            Ok(Ok(true)) => {
                eprintln!(
                    "CDP readiness: version and target ready after {:?}",
                    started.elapsed()
                );
                return Ok(());
            }
            Ok(Ok(false)) => eprintln!("CDP readiness: waiting for local page target"),
            Ok(Err(error)) => eprintln!(
                "CDP readiness attempt after {:?}: {error:?}",
                started.elapsed()
            ),
            Err(_) => return Err(CdpError::Timeout),
        }
        if TokioInstant::now() >= deadline {
            return Err(CdpError::Timeout);
        }
        tokio::time::sleep_until((TokioInstant::now() + Duration::from_millis(50)).min(deadline))
            .await;
    }
}

async fn protocol_fixture(
    delayed_first_connection: bool,
) -> (DevToolsEndpoint, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let mut first = true;
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let delay = delayed_first_connection && first;
            first = false;
            tokio::spawn(async move {
                if delay {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    return;
                }
                let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                    return;
                };
                let Some(Ok(Message::Text(text))) = socket.next().await else {
                    return;
                };
                let request: Value = serde_json::from_str(&text).unwrap();
                let result = if request["method"] == "Browser.getVersion" {
                    json!({"product": "Fixture/1"})
                } else if request["method"] == "Target.getTargets" {
                    json!({"targetInfos": [{"targetId": "local", "type": "page", "url": "http://127.0.0.1/"}]})
                } else {
                    json!({})
                };
                // The real exchange must ignore events and unrelated command replies.
                for response in [
                    json!({"method": "Target.targetCreated", "params": {}}),
                    json!({"id": 999, "result": {}}),
                    json!({"id": request["id"], "result": result}),
                ] {
                    if socket
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    };
                }
            });
        }
    });
    (
        DevToolsEndpoint {
            port,
            browser_path: "/devtools/browser/fixture".into(),
        },
        server,
    )
}

#[tokio::test]
async fn control_exchange_ignores_events_and_unrelated_replies() {
    let (endpoint, server) = protocol_fixture(false).await;
    let result = page_targets(&endpoint).await;
    server.abort();
    assert_eq!(
        result.unwrap(),
        vec![("local".into(), "http://127.0.0.1/".into())]
    );
}

#[tokio::test]
async fn readiness_requires_a_responsive_cdp_connection_not_a_listening_port() {
    let (endpoint, server) = protocol_fixture(true).await;
    let result = wait_until_ready(&endpoint, "http://127.0.0.1/", Duration::from_secs(2)).await;
    server.abort();
    assert_eq!(result, Ok(()));
}

#[tokio::test]
async fn readiness_never_passes_for_a_missing_target() {
    let (endpoint, server) = protocol_fixture(false).await;
    let result = wait_until_ready(
        &endpoint,
        "http://127.0.0.1/missing",
        Duration::from_millis(150),
    )
    .await;
    server.abort();
    assert_eq!(result, Err(CdpError::Timeout));
}

#[tokio::test]
async fn an_endpoint_that_never_completes_the_handshake_still_times_out() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = DevToolsEndpoint {
        port: listener.local_addr().unwrap().port(),
        browser_path: "/devtools/browser/stalled".into(),
    };
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(stream);
    });
    let started = Instant::now();
    let result = wait_until_ready(&endpoint, "http://127.0.0.1/", Duration::from_millis(150)).await;
    server.abort();
    assert_eq!(result, Err(CdpError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn production_control_deadline_still_rejects_a_stalled_handshake() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = DevToolsEndpoint {
        port: listener.local_addr().unwrap().port(),
        browser_path: "/devtools/browser/stalled".into(),
    };
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(stream);
    });
    let started = Instant::now();
    let result = open_or_activate_page(&endpoint, "http://127.0.0.1/").await;
    server.abort();
    assert_eq!(result, Err(CdpError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(5));
}

struct Fixture {
    root: PathBuf,
    url: String,
    stderr: File,
    process: Option<crate::browser::TestBrowserProcess>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let cleaned = self
            .process
            .as_mut()
            .is_none_or(|process| match process.terminate() {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("Control fixture process cleanup failed: {error}");
                    false
                }
            });
        self.server.abort();
        if std::thread::panicking() {
            if let Ok(mut log) = File::open(self.root.join("chromium.log")) {
                let size = log.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                let _ = log.seek(SeekFrom::Start(size.saturating_sub(16 * 1024)));
                let mut text = String::new();
                let _ = log.read_to_string(&mut text);
                eprintln!("Isolated Chromium log (last 16 KiB):\n{text}");
            }
        }
        if cleaned {
            if let Err(error) = std::fs::remove_dir_all(&self.root) {
                eprintln!("Control fixture directory cleanup failed: {error}");
            }
        } else {
            eprintln!("Control fixture profile retained because process cleanup was not verified");
        }
    }
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "vestus-control-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let stderr = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(root.join("chromium.log"))
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        );
        let server = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut request = [0; 8192];
                    let Ok(Ok(_)) =
                        timeout(Duration::from_secs(5), stream.read(&mut request)).await
                    else {
                        return;
                    };
                    let body = "<!doctype html><title>Vestus control fixture</title><p>Local test only</p>";
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            root,
            url,
            stderr,
            process: None,
            server,
        }
    }

    async fn launch(&mut self, executable: &std::path::Path, url: &str) -> DevToolsEndpoint {
        let mut command = Command::new(executable);
        command
            .arg(format!("--user-data-dir={}", self.root.display()))
            .args([
                "--remote-debugging-port=0",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-component-update",
                "--disable-background-mode",
                "--disable-breakpad",
                "--disable-infobars",
                "--disable-quic",
                "--password-store=basic",
                "--use-mock-keychain",
            ])
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(self.stderr.try_clone().unwrap());
        if let Some(directory) = executable.parent() {
            command.current_dir(directory);
        }
        self.process = Some(
            crate::browser::TestBrowserProcess::spawn(&mut command)
                .expect("launch isolated bundled Chromium"),
        );
        eprintln!(
            "Control browser: executable={executable:?}; arch={}; pid={}",
            std::env::consts::ARCH,
            self.process.as_ref().unwrap().id()
        );
        let started = Instant::now();
        let deadline = TokioInstant::now() + READY_TIMEOUT;
        loop {
            assert!(
                !self
                    .process
                    .as_ref()
                    .unwrap()
                    .has_exited()
                    .expect("inspect owned browser"),
                "Chromium exited before endpoint readiness"
            );
            if let Ok(text) = std::fs::read_to_string(self.root.join("DevToolsActivePort")) {
                if let Some(endpoint) = crate::browser::parse_devtools_active_port(&text) {
                    eprintln!(
                        "Port file appeared after {:?}; probing CDP readiness",
                        started.elapsed()
                    );
                    let budget = deadline.saturating_duration_since(TokioInstant::now());
                    wait_until_ready(&endpoint, url, budget)
                        .await
                        .expect("version/target readiness within startup deadline");
                    return endpoint;
                }
            }
            assert!(
                TokioInstant::now() < deadline,
                "Chromium endpoint startup timeout"
            );
            tokio::time::sleep_until(
                (TokioInstant::now() + Duration::from_millis(50)).min(deadline),
            )
            .await;
        }
    }
}

/// Explicit acceptance gate: never silently passes because system Chrome is absent.
#[test]
#[ignore = "requires bundled VESTUS_CONTROL_CHROMIUM; opens isolated real browser windows"]
fn target_commands_work_against_a_real_browser() {
    let executable = PathBuf::from(
        std::env::var_os("VESTUS_CONTROL_CHROMIUM")
            .expect("set VESTUS_CONTROL_CHROMIUM to bundled executable"),
    );
    assert!(
        executable.is_absolute() && executable.is_file(),
        "Chromium must be an existing absolute file"
    );
    crate::rt::runtime().block_on(async {
        let mut fixture = Fixture::new().await;
        let url = fixture.url.clone();
        let endpoint = fixture.launch(&executable, &url).await;
        // No retries around these acceptance assertions; the production deadline stays 3s.
        let started = Instant::now();
        let first = open_or_activate_page(&endpoint, &url).await;
        eprintln!(
            "Initial activation: {first:?}, elapsed={:?}",
            started.elapsed()
        );
        assert_eq!(
            first,
            Ok(PageOutcome::Activated),
            "existing local page must activate"
        );
        assert_eq!(
            open_or_activate_page(&endpoint, "http://other.example.invalid/").await,
            Err(CdpError::NoMatchingPage),
            "no new page for unmatched host"
        );
        assert_eq!(
            open_or_activate_page(&endpoint, &format!("{url}other/path")).await,
            Ok(PageOutcome::Activated),
            "same host reuses existing tab"
        );
        let targets = page_targets(&endpoint).await.unwrap();
        assert_eq!(
            targets.len(),
            1,
            "activation must not create extra pages: {targets:?}"
        );
        fixture
            .process
            .as_mut()
            .unwrap()
            .terminate()
            .expect("verified owned tree cleanup");
        eprintln!("Control browser process tree terminated successfully");
    });
}
