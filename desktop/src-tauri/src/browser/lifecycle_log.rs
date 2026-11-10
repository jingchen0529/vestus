//! Best-effort, local-only browser close diagnostics. No free-form payloads.

use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::BrowserError;

const LOG_FILE: &str = "browser-lifecycle.log";
const MAX_LOG_BYTES: u64 = 256 * 1024;
const QUEUE_CAPACITY: usize = 64;
const EXIT_FLUSH_TIMEOUT: Duration = Duration::from_millis(200);

#[derive(Debug, Clone, Copy)]
pub(crate) enum CloseReason {
    #[cfg(test)]
    Unspecified,
    AppExit,
    DesktopLogout,
    AccountSwitch,
    SessionRestore,
    PasswordChanged,
    ConfigChanged,
    AuthenticationInvalid,
    LeaseValidationFailed,
    ManagedLogout,
    MonitorDisconnected,
    UserReset,
    ManagedInitializationFailed,
    ManagedCredentialRotated,
    MonitorStartupFailed,
    ProcessExited,
}

impl CloseReason {
    fn labels(self) -> (&'static str, &'static str) {
        match self {
            #[cfg(test)]
            Self::Unspecified => ("browser_manager", "unspecified"),
            Self::AppExit => ("application", "app_exit"),
            Self::DesktopLogout => ("authentication", "desktop_logout"),
            Self::AccountSwitch => ("authentication", "account_switch"),
            Self::SessionRestore => ("authentication", "session_restore"),
            Self::PasswordChanged => ("authentication", "password_changed"),
            Self::ConfigChanged => ("configuration", "config_changed"),
            Self::AuthenticationInvalid => ("configuration", "authentication_invalid"),
            Self::LeaseValidationFailed => ("configuration", "lease_validation_failed"),
            Self::ManagedLogout => ("managed_watch", "managed_logout"),
            Self::MonitorDisconnected => ("managed_watch", "monitor_disconnected"),
            Self::UserReset => ("browser_command", "user_reset"),
            Self::ManagedInitializationFailed => {
                ("browser_launch", "managed_initialization_failed")
            }
            Self::ManagedCredentialRotated => ("browser_launch", "managed_credential_rotated"),
            Self::MonitorStartupFailed => ("browser_manager", "monitor_startup_failed"),
            Self::ProcessExited => ("process_monitor", "process_exited"),
        }
    }
}

#[derive(serde::Serialize)]
struct CloseRecord {
    timestamp_unix_ms: u64,
    source: &'static str,
    reason: &'static str,
    session_id: u64,
    result: &'static str,
}

enum LogMessage {
    Record(CloseRecord),
    Flush(mpsc::SyncSender<()>),
}

#[derive(Default)]
pub(super) struct LifecycleLog {
    sender: OnceLock<Option<mpsc::SyncSender<LogMessage>>>,
}

impl LifecycleLog {
    pub(super) fn initialize(&self, root: &Path) {
        self.sender.get_or_init(|| {
            let root = root.to_path_buf();
            let (sender, receiver) = mpsc::sync_channel::<LogMessage>(QUEUE_CAPACITY);
            std::thread::Builder::new()
                .name("vestus-browser-log".into())
                .spawn(move || {
                    for message in receiver {
                        match message {
                            LogMessage::Record(record) => {
                                // Disk errors and unavailable locks never affect browser cleanup.
                                let _ = append_record(&root, &record);
                            }
                            LogMessage::Flush(done) => {
                                let _ = done.try_send(());
                            }
                        }
                    }
                })
                .ok()
                .map(|_| sender)
        });
    }

    /// Acknowledge queued write attempts with a short upper bound at app exit.
    pub(super) fn flush(&self) -> bool {
        let Some(Some(sender)) = self.sender.get() else {
            return false;
        };
        let (done, finished) = mpsc::sync_channel(1);
        sender.try_send(LogMessage::Flush(done)).is_ok()
            && finished.recv_timeout(EXIT_FLUSH_TIMEOUT).is_ok()
    }

    pub(super) fn record_requested(&self, session_id: u64, reason: CloseReason) {
        self.record(session_id, reason, "requested");
    }

    pub(super) fn record_result(
        &self,
        session_id: u64,
        reason: CloseReason,
        result: &Result<(), BrowserError>,
    ) {
        let result = match result {
            Ok(()) => "completed",
            Err(BrowserError::ProfileCleanup(_)) => "profile_cleanup_failed",
            Err(BrowserError::ProfileBusy) => "profile_busy",
            Err(BrowserError::ProfileCheckFailed) => "profile_check_failed",
            Err(BrowserError::ProcessTermination(_)) => "process_termination_failed",
            Err(_) => "cleanup_failed",
        };
        self.record(session_id, reason, result);
    }

    fn record(&self, session_id: u64, reason: CloseReason, result: &'static str) {
        let Some(Some(sender)) = self.sender.get() else {
            return;
        };
        let (source, reason) = reason.labels();
        // Only fixed codes and numbers enter the queue; never stringify errors.
        let _ = sender.try_send(LogMessage::Record(CloseRecord {
            timestamp_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|time| time.as_millis() as u64)
                .unwrap_or(0),
            source,
            reason,
            session_id,
            result,
        }));
    }
}

fn append_record(root: &Path, record: &CloseRecord) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(record)?;
    bytes.push(b'\n');
    std::fs::create_dir_all(root)?;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(root.join(LOG_FILE))?;
    // Other desktop instances use the same file; never wait on their writer.
    fs2::FileExt::try_lock_exclusive(&file)?;
    if file.metadata()?.len().saturating_add(bytes.len() as u64) > MAX_LOG_BYTES {
        // A single bounded file, no archive that can accumulate indefinitely.
        file.set_len(0)?;
    }
    // Seek under the same lock; write permission also allows Windows truncation.
    file.seek(SeekFrom::End(0))?;
    file.write_all(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(0);
    struct LogDirectory(PathBuf);

    impl LogDirectory {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "vestus-close-log-{}-{}-{}",
                std::process::id(),
                NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            ));
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn read_until(
            &self,
            ready: impl Fn(&[serde_json::Value]) -> bool,
        ) -> Vec<serde_json::Value> {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let records = std::fs::read_to_string(self.0.join("browser-lifecycle.log"))
                    .ok()
                    .and_then(|text| {
                        text.lines()
                            .map(serde_json::from_str)
                            .collect::<Result<Vec<_>, _>>()
                            .ok()
                    })
                    .unwrap_or_default();
                if ready(&records) {
                    return records;
                }
                assert!(
                    Instant::now() < deadline,
                    "local close diagnostic was not persisted"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for LogDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn exit_flush_waits_for_queued_local_write_attempts() {
        let directory = LogDirectory::new();
        let log = LifecycleLog::default();
        log.initialize(&directory.0);
        log.record_result(44, CloseReason::AppExit, &Ok(()));
        assert!(
            log.flush(),
            "exit must give the writer a bounded chance to finish"
        );
        let text = std::fs::read_to_string(directory.0.join("browser-lifecycle.log")).unwrap();
        let record: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(record["reason"], "app_exit");
        assert_eq!(record["session_id"], 44);
        assert_eq!(record["result"], "completed");
    }

    #[test]
    fn close_diagnostic_keeps_latest_records_within_256_kib() {
        let directory = LogDirectory::new();
        let path = directory.0.join("browser-lifecycle.log");
        // A previous full file must be reset before the next append, not grow forever.
        std::fs::write(&path, vec![b'x'; 256 * 1024]).unwrap();
        let log = LifecycleLog::default();
        log.initialize(&directory.0);
        log.record_result(43, CloseReason::DesktopLogout, &Ok(()));
        let records = directory.read_until(|records| {
            records
                .last()
                .is_some_and(|record| record["session_id"] == 43)
        });
        assert_eq!(records.len(), 1);
        assert!(std::fs::metadata(&path).unwrap().len() <= 256 * 1024);
        assert_eq!(std::fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn close_diagnostic_persists_only_allowlisted_fields_and_error_codes() {
        let directory = LogDirectory::new();
        let log = LifecycleLog::default();
        log.initialize(&directory.0);
        log.record_result(
            42,
            CloseReason::DesktopLogout,
            &Err(BrowserError::ProfileCleanup(
                "Cookie=private-cookie JWT=private-jwt proxy-password=private-password https://secret.example/path /private/full/profile".into(),
            )),
        );

        let records = directory.read_until(|records| records.len() == 1);
        let record = records[0].as_object().unwrap();
        let keys: std::collections::BTreeSet<_> = record.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "timestamp_unix_ms",
                "source",
                "reason",
                "session_id",
                "result"
            ]
            .into_iter()
            .collect(),
        );
        assert!(record["timestamp_unix_ms"].as_u64().unwrap() > 0);
        assert_eq!(record["source"], "authentication");
        assert_eq!(record["reason"], "desktop_logout");
        assert_eq!(record["session_id"], 42);
        assert_eq!(record["result"], "profile_cleanup_failed");
        let rendered = records[0].to_string();
        for secret in [
            "Cookie",
            "JWT",
            "private-cookie",
            "private-jwt",
            "private-password",
            "https://secret.example",
            "/private/full/profile",
        ] {
            assert!(!rendered.contains(secret));
        }
    }
}
