//! Managed-profile deletion/lease races. Fixtures never use a user's profile,
//! real credentials, desktop process, or OS credential store.
use super::*;
use std::os::unix::fs::PermissionsExt as _;
use std::sync::mpsc;
use std::time::Instant;

struct Fixture {
    root: PathBuf,
    manager: BrowserSessionManager,
}
impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "vestus-lifecycle-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir(&root).unwrap();
        Self {
            root,
            manager: BrowserSessionManager::default(),
        }
    }

    fn profile(&self, key: &str) -> PathBuf {
        profile::profile_dir(
            &self.root,
            &ProfileSpec {
                api_base: "https://lifecycle.example.test",
                profile_key: key,
                platform_id: 7,
                direct_mode: false,
            },
        )
    }

    fn managed(&self) -> PathBuf {
        self.profile("user-test::managed-account-9::credential-version-1")
    }

    fn script(&self, body: &str) -> PathBuf {
        let path = self.root.join("fake-chromium.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn launch(&self, id: u64, executable: &Path, dir: &Path) -> Result<u64, BrowserError> {
        self.manager.launch_process(
            id,
            executable,
            dir.to_path_buf(),
            None,
            "about:blank",
            None,
            false,
            |_| {},
            || {},
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.manager.shutdown();
        if self.manager.active_count() == 0 {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

fn wait_until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "fixture did not become ready");
        thread::sleep(Duration::from_millis(10));
    }
}

/// Run the real OS lock competitor in a separate executable, not just another
/// Rust mutex or manager in this process.
#[test]
fn lease_probe_subprocess() {
    let Some(path) = std::env::var_os("VESTUS_LIFECYCLE_PROBE_PROFILE") else {
        return;
    };
    let acquired = profile::acquire_profile_lease(&PathBuf::from(path)).is_ok();
    assert_eq!(
        acquired,
        std::env::var_os("VESTUS_LIFECYCLE_PROBE_EXPECT_FREE").is_some()
    );
}

fn probe_lease(profile: &Path, free: bool) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "browser::lifecycle_tests::lease_probe_subprocess",
            "--nocapture",
        ])
        .env("VESTUS_LIFECYCLE_PROBE_PROFILE", profile);
    if free {
        command.env("VESTUS_LIFECYCLE_PROBE_EXPECT_FREE", "1");
    }
    assert!(
        command.status().unwrap().success(),
        "cross-process lease result differed"
    );
}

fn session(manager: &BrowserSessionManager, id: u64) -> Arc<ManagedBrowser> {
    manager.inner.sessions.lock().unwrap()[&id].clone()
}

fn process_is_running(pid: u32) -> bool {
    let output = Command::new("/bin/ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .trim()
            .chars()
            .next()
            .is_some_and(|state| state != 'Z')
}

#[test]
fn cold_managed_launch_discards_old_cookies_but_manual_profiles_keep_them() {
    let f = Fixture::new("cold");
    let executable = f.script("exec sleep 30");
    let managed = f.managed();
    let manual = f.profile("user-test");
    for dir in [&managed, &manual] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("Cookies"), b"old-cookie").unwrap();
    }
    f.launch(1, &executable, &managed).unwrap();
    f.launch(2, &executable, &manual).unwrap();
    assert!(!managed.join("Cookies").exists());
    assert_eq!(
        std::fs::read(manual.join("Cookies")).unwrap(),
        b"old-cookie"
    );
    assert!(f.manager.kill_browser(1).unwrap());
    assert!(!managed.exists());
    assert!(f.manager.kill_browser(2).unwrap());
    assert_eq!(
        std::fs::read(manual.join("Cookies")).unwrap(),
        b"old-cookie"
    );
    probe_lease(&managed, true);
}

#[test]
fn failed_cold_deletion_refuses_spawn_and_cookie_reuse() {
    if unsafe { libc::geteuid() } == 0 {
        // chmod cannot simulate deletion denial for root (e.g. root-only CI).
        return;
    }
    let f = Fixture::new("cold-delete-failure");
    let executable = f.script("exec sleep 30");
    let managed = f.managed();
    std::fs::create_dir_all(&managed).unwrap();
    std::fs::write(managed.join("Cookies"), b"must-not-reuse").unwrap();
    std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = f.launch(1, &executable, &managed);
    std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        matches!(result, Err(BrowserError::ProfileCleanup(_))),
        "{result:?}"
    );
    assert_eq!(f.manager.active_count(), 0);
    assert_eq!(
        std::fs::read(managed.join("Cookies")).unwrap(),
        b"must-not-reuse"
    );
    f.launch(2, &executable, &managed).unwrap();
    assert!(!managed.join("Cookies").exists());
    assert!(f.manager.kill_browser(2).unwrap());
}

#[test]
fn failed_exit_cleanup_retains_lease_and_refuses_reopen_until_retry_completes() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let f = Fixture::new("exit-delete-failure");
    let executable = f.script("exec sleep 30");
    let managed = f.managed();
    let (exit_tx, exit_rx) = mpsc::channel();
    f.manager
        .launch_process(
            1,
            &executable,
            managed.clone(),
            None,
            "about:blank",
            None,
            false,
            |_| {},
            move || {
                let _ = exit_tx.send(());
            },
        )
        .unwrap();
    std::fs::write(managed.join("Cookies"), b"must-delete").unwrap();
    std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o500)).unwrap();
    let result = f.manager.kill_browser(1);
    assert!(
        matches!(result, Err(BrowserError::ProfileCleanup(_))),
        "{result:?}"
    );
    assert_eq!(f.manager.active_count(), 1);
    assert_eq!(f.manager.running_browser(&managed), None);
    probe_lease(&managed, false);
    assert!(matches!(
        f.launch(2, &executable, &managed),
        Err(BrowserError::ProfileBusy)
    ));
    let other = BrowserSessionManager::default();
    assert!(matches!(
        other.launch_process(
            1,
            &executable,
            managed.clone(),
            None,
            "about:blank",
            None,
            false,
            |_| {},
            || {}
        ),
        Err(BrowserError::ProfileBusy)
    ));
    // The monitor also encounters the cleanup failure. It must retain its
    // callback rather than report a closed session (or drop its exit signal).
    assert!(matches!(
        exit_rx.recv_timeout(Duration::from_secs(3)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert_eq!(f.manager.active_count(), 1);
    std::fs::set_permissions(&managed, std::fs::Permissions::from_mode(0o700)).unwrap();
    f.manager.kill_browser(1).unwrap();
    exit_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("successful retry must deliver on_exit");
    assert!(matches!(
        exit_rx.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    wait_until(|| f.manager.active_count() == 0);
    assert!(!managed.exists());
    probe_lease(&managed, true);
}

#[test]
fn unknown_cleanup_does_not_notify_exit_before_successful_retry() {
    let f = Fixture::new("unknown-cleanup-notification");
    let executable = f.script("exec sleep 30");
    let dir = f.managed();
    let (exit_tx, exit_rx) = mpsc::channel();
    f.manager
        .launch_process(
            1,
            &executable,
            dir.clone(),
            None,
            "about:blank",
            None,
            false,
            |_| {},
            move || {
                let _ = exit_tx.send(());
            },
        )
        .unwrap();
    // Root-independent failure injection using real on-disk occupancy state.
    std::fs::write(dir.join("SingletonLock"), b"not-a-link").unwrap();
    assert!(matches!(
        f.manager.kill_browser(1),
        Err(BrowserError::ProfileCheckFailed)
    ));
    assert!(matches!(
        exit_rx.recv_timeout(Duration::from_millis(500)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert_eq!(f.manager.active_count(), 1);
    probe_lease(&dir, false);
    std::fs::remove_file(dir.join("SingletonLock")).unwrap();
    assert!(f.manager.kill_browser(1).unwrap());
    exit_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("retry did not notify completion");
    assert!(matches!(
        exit_rx.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    assert_eq!(f.manager.active_count(), 0);
    assert!(!dir.exists());
    probe_lease(&dir, true);
}

#[test]
fn force_kill_owns_parent_and_children_and_keeps_lease_through_cleanup() {
    let f = Fixture::new("force-tree");
    let parent_ready = f.root.join("parent.ready");
    let child_ready = f.root.join("child.pid");
    let graceful = f.root.join("graceful");
    let executable = f.script(&format!(
        "trap 'touch \"{}\"; exit 0' TERM\n/bin/sleep 30 &\nprintf '%s' $! > \"{}\"\nprintf ready > \"{}\"\nwait",
        graceful.display(), child_ready.display(), parent_ready.display(),
    ));
    let managed = f.managed();
    f.launch(1, &executable, &managed).unwrap();
    wait_until(|| parent_ready.exists());
    let current = session(&f.manager, 1);
    let parent_pid = current.process.lock().unwrap().as_ref().unwrap().id();
    let child_pid: u32 = std::fs::read_to_string(&child_ready)
        .unwrap()
        .parse()
        .unwrap();
    assert!(process_is_running(parent_pid));
    assert!(process_is_running(child_pid));
    // Unrelated child with the same executable must not be killed.
    let mut unrelated = OwnedProcess::spawn(Command::new("/bin/sleep").arg("30")).unwrap();
    let unrelated_pid = unrelated.id();
    probe_lease(&managed, false);
    // Hold the finalizer barrier so the separate killer parks while the lease
    // is still held. No take_session or monitor may prematurely drop it.
    let finish = current.finish.lock().unwrap();
    let manager = f.manager.clone();
    let (tx, rx) = mpsc::channel();
    let killer = thread::spawn(move || {
        tx.send(manager.kill_browser(1)).unwrap();
    });
    wait_until(|| current.closing.load(Ordering::Acquire));
    assert!(rx.try_recv().is_err());
    probe_lease(&managed, false);
    assert!(managed.exists());
    drop(finish);
    assert!(rx.recv_timeout(Duration::from_secs(8)).unwrap().unwrap());
    killer.join().unwrap();
    assert!(!process_is_running(parent_pid));
    assert!(!process_is_running(child_pid));
    assert!(process_is_running(unrelated_pid));
    unrelated.terminate().unwrap();
    assert!(
        !graceful.exists(),
        "force kill sent a polite termination signal"
    );
    assert!(!managed.exists());
    assert_eq!(f.manager.active_count(), 0);
    probe_lease(&managed, true);
}

#[test]
fn normal_exit_cleans_managed_profile_but_not_manual_profile() {
    let f = Fixture::new("normal-exit");
    let release = f.root.join("exit.now");
    let ready = f.root.join("ready");
    let executable = f.script(&format!(
        "printf ready > \"{}\"\nwhile [ ! -e \"{}\" ]; do sleep 0.02; done\nexit 0",
        ready.display(),
        release.display(),
    ));
    for (id, dir, ephemeral) in [(1, f.managed(), true), (2, f.profile("manual-user"), false)] {
        let _ = std::fs::remove_file(&release);
        let _ = std::fs::remove_file(&ready);
        f.launch(id, &executable, &dir).unwrap();
        wait_until(|| ready.exists());
        std::fs::write(dir.join("Cookies"), b"session-cookie").unwrap();
        std::fs::write(&release, b"exit").unwrap();
        wait_until(|| f.manager.active_count() == 0);
        assert_eq!(dir.exists(), !ephemeral);
        if !ephemeral {
            assert_eq!(
                std::fs::read(dir.join("Cookies")).unwrap(),
                b"session-cookie"
            );
        }
        probe_lease(&dir, true);
    }
}

#[test]
fn blocked_old_ready_callback_cannot_delay_kill_or_delete_a_reopened_profile() {
    let f = Fixture::new("rapid-reopen");
    let executable = f.script("profile=${1#--user-data-dir=}\nprintf '51234\\n/devtools/browser/test\\n' > \"$profile/DevToolsActivePort\"\nexec sleep 30");
    let dir = f.managed();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (exit_tx, exit_rx) = mpsc::channel();
    f.manager
        .launch_process(
            1,
            &executable,
            dir.clone(),
            None,
            "about:blank",
            None,
            false,
            move |_| {
                ready_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            },
            move || {
                let _ = exit_tx.send(());
            },
        )
        .unwrap();
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(f.manager.kill_browser(1).unwrap());
    assert!(!dir.exists());
    probe_lease(&dir, true); // monitor is still blocked in on_ready
                             // Reuse the same id as well as path: the old monitor must compare instance
                             // identity, not remove a newer session just because its id is equal.
    f.launch(1, &executable, &dir).unwrap();
    std::fs::write(dir.join("Cookies"), b"new-session-cookie").unwrap();
    release_tx.send(()).unwrap();
    exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(f.manager.running_browser(&dir), Some(1));
    assert_eq!(
        std::fs::read(dir.join("Cookies")).unwrap(),
        b"new-session-cookie"
    );
    assert!(f.manager.kill_browser(1).unwrap());
}

#[test]
fn already_exited_parent_still_holds_lease_until_remaining_child_is_killed() {
    let f = Fixture::new("parent-first-exit");
    let child_ready = f.root.join("child.pid");
    let exit_parent = f.root.join("exit-parent");
    let executable = f.script(&format!(
        "profile=${{1#--user-data-dir=}}\n/bin/sleep 30 &\nprintf '%s' $! > \"{}\"\nprintf '51234\\n/devtools/browser/test\\n' > \"$profile/DevToolsActivePort\"\nwhile [ ! -e \"{}\" ]; do sleep 0.02; done\nexit 0",
        child_ready.display(), exit_parent.display(),
    ));
    let dir = f.managed();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (exit_tx, exit_rx) = mpsc::channel();
    f.manager
        .launch_process(
            1,
            &executable,
            dir.clone(),
            None,
            "about:blank",
            None,
            false,
            move |_| {
                ready_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            },
            move || {
                let _ = exit_tx.send(());
            },
        )
        .unwrap();
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let current = session(&f.manager, 1);
    let child_pid: u32 = std::fs::read_to_string(child_ready)
        .unwrap()
        .parse()
        .unwrap();
    std::fs::write(&exit_parent, b"exit").unwrap();
    wait_until(|| process_has_exited(&current.process));
    assert!(
        process_is_running(child_pid),
        "fixture child exited before parent-first cleanup"
    );
    probe_lease(&dir, false);
    assert!(f.manager.kill_browser(1).unwrap());
    assert!(!process_is_running(child_pid));
    assert!(!dir.exists());
    probe_lease(&dir, true);
    release_tx.send(()).unwrap();
    exit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn occupied_managed_directory_is_never_deleted_even_before_singleton_exists() {
    let f = Fixture::new("external-occupancy");
    let dir = f.managed();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("Cookies"), b"live-owner").unwrap();
    let mut owner = OwnedProcess::spawn(
        Command::new("/bin/sh")
            .args(["-c", "sleep 30; :", "vestus-test"])
            .arg(profile::user_data_dir_argument(&dir)),
    )
    .unwrap();
    // Deliberately no SingletonLock: a previous app could crash just after
    // spawn, leaving Chromium in the interval before its own singleton exists.
    let executable = f.script("exec sleep 30");
    assert!(matches!(
        f.launch(1, &executable, &dir),
        Err(BrowserError::ProfileBusy)
    ));
    assert_eq!(profile::sweep_orphaned_managed_profiles(&f.root), 0);
    assert_eq!(std::fs::read(dir.join("Cookies")).unwrap(), b"live-owner");
    assert!(!owner.has_exited().unwrap());
    owner.terminate().unwrap();
}

#[test]
#[ignore = "requires VESTUS_TEST_CHROMIUM_PATH; headless, isolated temporary profiles only"]
fn real_headless_chromium_force_kill_and_rapid_reopen() {
    let executable = PathBuf::from(
        std::env::var_os("VESTUS_TEST_CHROMIUM_PATH")
            .expect("set isolated test Chromium executable"),
    );
    assert!(executable.is_absolute() && executable.is_file());
    let f = Fixture::new("real-chromium");
    let dir = f.managed();
    let mut previous = Vec::new();
    for id in 1..=2 {
        let (tx, rx) = mpsc::channel();
        f.manager
            .launch_process_with_hook(
                LaunchProcessRequest {
                    session_id: id,
                    executable: &executable,
                    profile_dir: dir.clone(),
                    ephemeral: true,
                    extra_arguments: &[
                        "--headless=new",
                        "--disable-gpu",
                        "--password-store=basic",
                        "--use-mock-keychain",
                        "--disable-background-networking",
                        "--disable-component-update",
                        "--disable-sync",
                    ],
                    local_proxy: None,
                    target_url: "about:blank",
                    window: None,
                    disable_sandbox: false,
                },
                move |endpoint| {
                    let _ = tx.send(endpoint);
                },
                || {},
                || {},
            )
            .unwrap();
        rx.recv_timeout(Duration::from_secs(30))
            .expect("headless Chromium endpoint");
        let current = session(&f.manager, id);
        let parent = current.process.lock().unwrap().as_ref().unwrap().id();
        let snapshot = Command::new("/bin/ps")
            .args(["-axo", "pid=,ppid=,pgid=,stat=,command="])
            .output()
            .unwrap();
        assert!(snapshot.status.success());
        let text = String::from_utf8(snapshot.stdout).unwrap();
        let group: Vec<u32> = text
            .lines()
            .filter_map(|line| {
                let fields: Vec<_> = line.split_whitespace().collect();
                (fields.len() >= 4 && fields[2] == parent.to_string())
                    .then(|| fields[0].parse().unwrap())
            })
            .collect();
        eprintln!("headless owned group {parent}: {group:?}");
        assert!(
            group.len() >= 2,
            "real Chromium must spawn renderer/utility children"
        );
        let profile_argument = profile::user_data_dir_argument(&dir);
        let crash_database = format!("--database={}", dir.join("Crashpad").display());
        for line in text
            .lines()
            .filter(|line| line.contains(&profile_argument) || line.contains(&crash_database))
        {
            assert_eq!(
                line.split_whitespace().nth(2),
                Some(parent.to_string().as_str()),
                "profile user escaped owned process group: {line}"
            );
        }
        assert!(previous.iter().all(|pid| !process_is_running(*pid)));
        probe_lease(&dir, false);
        std::fs::write(dir.join("test-cookie-sentinel"), b"ephemeral").unwrap();
        assert!(f.manager.kill_browser(id).unwrap());
        assert!(
            group.iter().all(|pid| !process_is_running(*pid)),
            "owned process survived force close"
        );
        assert!(!dir.exists());
        probe_lease(&dir, true);
        previous = group;
    }
}
