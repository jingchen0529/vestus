//! Opt-in acceptance tests: real headed Chromium, production launch/close/profile paths.
//! All website data is synthetic and confined to a newly created temporary directory.
use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::{client_async, tungstenite::Message};

const DEADLINE: Duration = Duration::from_secs(30);
type Socket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

fn executable(variable: &str) -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os(variable)
            .unwrap_or_else(|| panic!("{variable} must name a real Chromium executable")),
    );
    assert!(
        path.is_absolute() && path.is_file(),
        "{variable} must be an existing absolute executable: {path:?}"
    );
    path
}

struct Fixture {
    manager: BrowserSessionManager,
    root: PathBuf,
    server: tokio::task::JoinHandle<()>,
    url: String,
    next_id: u64,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Also runs on assertion failure; never leave test browser processes running.
        self.manager.shutdown();
        self.server.abort();
        if let Err(error) = std::fs::remove_dir_all(&self.root) {
            eprintln!("test profile cleanup failed at {:?}: {error}", self.root);
        }
    }
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "vestus-persistence-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        Self::with_listener(root, listener).await
    }

    async fn with_listener(root: PathBuf, listener: tokio::net::TcpListener) -> Self {
        let url = format!(
            "http://127.0.0.1:{}/",
            listener.local_addr().unwrap().port()
        );
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0; 2048];
                    while !request.windows(4).take(8192).any(|w| w == b"\r\n\r\n") {
                        let size =
                            match tokio::time::timeout(DEADLINE, stream.read(&mut buffer)).await {
                                Ok(Ok(n)) if n > 0 => n,
                                _ => return,
                            };
                        request.extend_from_slice(&buffer[..size]);
                        if request.len() > 16384 {
                            return;
                        }
                    }
                    let request = String::from_utf8_lossy(&request);
                    let path = request.split_whitespace().nth(1).unwrap_or("/");
                    let (body, cookie) = if path == "/set" {
                        ("ok".to_owned(), "Set-Cookie: httpOnly=baseline; HttpOnly; Max-Age=86400; SameSite=Lax; Path=/\r\n")
                    } else if path == "/echo" {
                        (
                            request
                                .lines()
                                .find_map(|line| {
                                    line.split_once(':')
                                        .filter(|(name, _)| name.eq_ignore_ascii_case("cookie"))
                                        .map(|(_, value)| value.trim().to_owned())
                                })
                                .unwrap_or_default(),
                            "",
                        )
                    } else {
                        ("<!doctype html><title>Vestus persistence fixture</title><p>Local persistence test</p>".to_owned(), "")
                    };
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n{cookie}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self {
            manager: BrowserSessionManager::default(),
            root,
            server,
            url,
            next_id: 0,
        }
    }

    fn path(&self, key: &str, platform_id: i64, direct_mode: bool) -> PathBuf {
        profile::profile_dir(
            &self.root,
            &ProfileSpec {
                api_base: "https://persistence.test",
                profile_key: key,
                platform_id,
                direct_mode,
            },
        )
    }

    async fn launch(&mut self, exe: &Path, path: PathBuf) -> Cdp {
        self.next_id += 1;
        let (tx, rx) = tokio::sync::oneshot::channel();
        // Namespace isolation only: proxy/direct keys vary, actual requests stay local.
        self.manager
            .launch_process(
                self.next_id,
                exe,
                path,
                None,
                &self.url,
                None,
                false,
                move |endpoint| {
                    let _ = tx.send(endpoint);
                },
                || {},
            )
            .expect("production Chromium launch failed");
        let endpoint = tokio::time::timeout(DEADLINE, rx)
            .await
            .expect("Chromium did not publish CDP within 30 seconds")
            .expect("Chromium exited before CDP ready");
        let (socket, _) = client_async(
            endpoint.websocket_url(),
            tokio::net::TcpStream::connect(("127.0.0.1", endpoint.port))
                .await
                .expect("connect CDP socket"),
        )
        .await
        .expect("connect browser CDP");
        let mut cdp = Cdp {
            socket,
            id: 0,
            session: None,
            version: String::new(),
        };
        let version = cdp.call("Browser.getVersion", json!({})).await;
        cdp.version = version["product"]
            .as_str()
            .expect("browser product version")
            .to_owned();
        eprintln!("Chromium version: {version}");
        let deadline = tokio::time::Instant::now() + DEADLINE;
        loop {
            let targets = cdp.call("Target.getTargets", json!({})).await;
            let pages: Vec<_> = targets["targetInfos"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|v| v["type"] == "page")
                .collect();
            if pages.iter().any(|v| v["url"] == self.url) {
                assert_eq!(
                    pages.len(),
                    1,
                    "cold launch restored extra page targets: {targets}"
                );
                let target = pages[0]["targetId"].as_str().unwrap();
                let attached = cdp
                    .call(
                        "Target.attachToTarget",
                        json!({"targetId": target, "flatten": true}),
                    )
                    .await;
                cdp.session = Some(attached["sessionId"].as_str().unwrap().to_owned());
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "entry page was not loaded: {targets}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        loop {
            let ready = cdp
                .eval("({href: location.href, ready: document.readyState})")
                .await;
            if ready["href"] == self.url && ready["ready"] == "complete" {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "entry document not ready: {ready}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        cdp
    }

    async fn stopped(&self) {
        let deadline = tokio::time::Instant::now() + DEADLINE;
        while self.manager.active_count() != 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "browser monitor did not release session/lease"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn close(&self) {
        assert_eq!(self.manager.close_all().await, 1);
        self.stopped().await;
    }
}

struct Cdp {
    socket: Socket,
    id: u64,
    session: Option<String>,
    version: String,
}
impl Cdp {
    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        let mut message = json!({"id": self.id, "method": method, "params": params});
        if let Some(session) = &self.session {
            message["sessionId"] = json!(session);
        }
        self.socket
            .send(Message::Text(message.to_string().into()))
            .await
            .expect("send CDP command");
        tokio::time::timeout(DEADLINE, async {
            while let Some(message) = self.socket.next().await {
                let message = message.expect("read CDP response");
                if let Message::Text(text) = message {
                    let result: Value = serde_json::from_str(&text).unwrap();
                    if result["id"] == self.id {
                        assert!(result.get("error").is_none(), "{method} failed: {result}");
                        return result["result"].clone();
                    }
                }
            }
            panic!("CDP disconnected waiting for {method}");
        })
        .await
        .unwrap_or_else(|_| panic!("CDP timed out: {method}"))
    }

    async fn eval(&mut self, expression: &str) -> Value {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({"expression": expression, "awaitPromise": true, "returnByValue": true}),
            )
            .await;
        assert!(
            result.get("exceptionDetails").is_none(),
            "JavaScript failed: {result}"
        );
        result["result"]["value"].clone()
    }

    async fn write(&mut self) {
        assert_eq!(self.eval(r#"(async () => {
            await fetch('/set');
            document.cookie='persistent=baseline; Max-Age=86400; SameSite=Lax; Path=/';
            document.cookie='sessionOnly=observed; SameSite=Lax; Path=/';
            localStorage.setItem('baseline','saved'); sessionStorage.setItem('pageOnly','saved');
            await new Promise((resolve,reject)=>{const r=indexedDB.open('vestus',1);
                r.onupgradeneeded=()=>r.result.createObjectStore('state');
                r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;
                    const t=db.transaction('state','readwrite');t.objectStore('state').put('saved','baseline');
                    t.oncomplete=()=>{db.close();resolve()};t.onerror=()=>reject(t.error);};});
            return true;
        })()"#).await, true);
        self.check(true, true, "same page after write").await;
        let session = self.session.take();
        self.call(
            "Target.createTarget",
            json!({"url": "about:blank#must-not-restore"}),
        )
        .await;
        self.session = session;
    }

    async fn check(&mut self, persisted: bool, same_page: bool, label: &str) {
        let data = self.eval(r#"(async () => ({
            cookie:document.cookie, httpCookie:await (await fetch('/echo')).text(),
            local:localStorage.getItem('baseline'), session:sessionStorage.getItem('pageOnly'),
            idb:await new Promise((resolve,reject)=>{const r=indexedDB.open('vestus',1);
                r.onupgradeneeded=()=>r.result.createObjectStore('state');
                r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;
                    if(!db.objectStoreNames.contains('state')){db.close();resolve(null);return;}
                    const t=db.transaction('state');const get=t.objectStore('state').get('baseline');
                    get.onsuccess=()=>{const value=get.result ?? null;db.close();resolve(value)};get.onerror=()=>reject(get.error);};})
        }))()"#).await;
        eprintln!(
            "{label}: session-cookie observed={} (not a persistence guarantee)",
            data["cookie"]
                .as_str()
                .unwrap()
                .contains("sessionOnly=observed")
        );
        let expected = if persisted {
            json!("saved")
        } else {
            Value::Null
        };
        assert_eq!(data["local"], expected, "{label}: localStorage {data}");
        assert_eq!(data["idb"], expected, "{label}: IndexedDB {data}");
        assert_eq!(
            data["session"],
            if same_page {
                json!("saved")
            } else {
                Value::Null
            },
            "{label}: sessionStorage {data}"
        );
        assert_eq!(
            data["cookie"]
                .as_str()
                .unwrap()
                .contains("persistent=baseline"),
            persisted,
            "{label}: persistent Cookie {data}"
        );
        assert_eq!(
            data["httpCookie"]
                .as_str()
                .unwrap()
                .contains("httpOnly=baseline"),
            persisted,
            "{label}: server HttpOnly Cookie {data}"
        );
        assert!(
            !data["cookie"].as_str().unwrap().contains("httpOnly="),
            "HttpOnly exposed to JS"
        );
    }
}

#[test]
#[ignore = "requires explicit Chromium executable; opens real browser windows"]
fn real_chromium_persistence_matrix() {
    let exe = executable("VESTUS_PERSISTENCE_CHROMIUM");
    rt::runtime().block_on(async {
        let mut f = Fixture::new().await;
        let baseline = f.path("account-a", 1, false);
        let mut page = f.launch(&exe, baseline.clone()).await;
        page.check(false, false, "new environment").await;
        page.write().await;
        // Browser.close models a user-requested clean browser exit.
        page.session = None;
        page.call("Browser.close", json!({})).await;
        f.stopped().await;
        drop(page);
        let mut page = f.launch(&exe, baseline.clone()).await;
        page.check(true, false, "user close/reopen").await;
        f.close().await;
        drop(page);
        // Simulate the application's final shutdown from outside the async runtime.
        let manager = f.manager.clone();
        let mut page = f.launch(&exe, baseline.clone()).await;
        page.check(true, false, "close_all/reopen").await;
        assert_eq!(
            tokio::task::spawn_blocking(move || manager.shutdown())
                .await
                .unwrap(),
            1
        );
        drop(page);
        f.manager = BrowserSessionManager::default();
        let mut page = f.launch(&exe, baseline.clone()).await;
        page.check(true, false, "new app manager").await;
        // Already-flushed baseline survives kill; freshly written unflushed data is NOT guaranteed.
        let process = {
            f.manager
                .inner
                .sessions
                .lock()
                .unwrap()
                .get(&f.next_id)
                .unwrap()
                .process
                .clone()
        };
        stop_process(&process);
        f.stopped().await;
        drop(page);
        let mut page = f.launch(&exe, baseline.clone()).await;
        page.check(true, false, "crash/reopen of flushed baseline")
            .await;
        f.close().await;
        drop(page);
        for (key, platform, direct, label) in [
            ("account-b", 1, false, "other account"),
            ("account-a", 2, false, "other platform"),
            ("account-a", 1, true, "direct namespace"),
        ] {
            let path = f.path(key, platform, direct);
            let mut page = f.launch(&exe, path).await;
            page.check(false, false, label).await;
            if key == "account-b" {
                page.write().await;
            }
            f.close().await;
        }
        let mut page = f.launch(&exe, baseline.clone()).await;
        page.check(true, false, "switch back").await;
        f.close().await;
        drop(page);
        let account = profile::account_dir(&f.root, "https://persistence.test", "account-a");
        assert_eq!(
            profile::remove_account(&account).expect("reset account-a"),
            3
        );
        let mut page = f.launch(&exe, baseline).await;
        page.check(false, false, "reset account").await;
        f.close().await;
        drop(page);
        let other = f.path("account-b", 1, false);
        let mut page = f.launch(&exe, other).await;
        page.check(true, false, "other account survives reset")
            .await;
        f.close().await;
    });
}

#[test]
#[ignore = "requires explicit current AND previous Chromium executables; opens real browser windows"]
fn real_browser_upgrade_round_trip() {
    let current = executable("VESTUS_PERSISTENCE_CHROMIUM");
    let previous = executable("VESTUS_PERSISTENCE_PREVIOUS_CHROMIUM");
    assert_ne!(
        current, previous,
        "upgrade acceptance requires two different executable paths"
    );
    rt::runtime().block_on(async {
        let mut f = Fixture::new().await;
        // Deliberately reuse bundled-style namespace across versions. External executable namespaces
        // would isolate profiles and hide upgrade/rollback incompatibility.
        let path = f.path("upgrade", 1, false);
        let mut page = f.launch(&previous, path.clone()).await;
        let previous_version = page.version.clone();
        page.write().await;
        f.close().await;
        drop(page);
        for (exe, label) in [(&current, "upgrade"), (&previous, "rollback")] {
            let mut page = f.launch(exe, path.clone()).await;
            if label == "upgrade" {
                assert_ne!(
                    page.version, previous_version,
                    "two paths to the same version do not test an upgrade"
                );
            } else {
                assert_eq!(
                    page.version, previous_version,
                    "rollback executable changed version during test"
                );
            }
            page.check(true, false, label).await;
            f.close().await;
        }
    });
}
