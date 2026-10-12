//! Durable, account-scoped activity delivery. Payloads must never contain credentials.
//! Staging and batch preparation are separate so a crash cannot discard observations.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const VERSION: i64 = 1;
const MAX_ROWS: i64 = 10_000;
const MAX_BYTES: i64 = 128 * 1024 * 1024;
// A CDP observation can contain seven days of dwell time; v2 accepts one day
// per row. Reserve bounded conversion space without rejecting existing data at
// the admission limit. Never recursively prepare ready records.
const CONVERSION_FACTOR: usize = 8;
const CONVERSION_METADATA_BYTES: usize = 1024;

#[derive(Debug, thiserror::Error)]
pub enum OutboxError {
    #[error("activity queue IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("activity queue database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("activity queue payload error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported activity queue version: {0}")]
    UnsupportedVersion(i64),
    #[error("activity queue capacity exceeded; existing records retained")]
    Capacity,
    #[error("invalid activity queue batch: {0}")]
    InvalidBatch(String),
}

#[derive(Clone, Debug)]
pub struct ActivityOutbox {
    path: PathBuf,
}

impl ActivityOutbox {
    pub fn open(root: &Path) -> Result<Self, OutboxError> {
        let directory = root.join("activity-outbox");
        fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
            let path = directory.join("queue.sqlite3");
            fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(false)
                .mode(0o600)
                .open(&path)?;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        let queue = Self {
            path: directory.join("queue.sqlite3"),
        };
        let mut connection = Connection::open(&queue.path)?;
        connection.busy_timeout(Duration::from_secs(3))?;
        // Serialize first-open schema creation across client instances.
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = transaction.pragma_query_value(None, "user_version", |r| r.get(0))?;
        match version {
            0 => {
                let tables: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                    [],
                    |r| r.get(0),
                )?;
                if tables != 0 {
                    return Err(OutboxError::UnsupportedVersion(0));
                }
                transaction.execute_batch("CREATE TABLE staged (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX staged_owner ON staged(owner, id); CREATE TABLE ready (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, batch_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL); CREATE INDEX ready_owner ON ready(owner, id); PRAGMA user_version=1;")?;
            }
            VERSION => {}
            _ => return Err(OutboxError::UnsupportedVersion(version)),
        }
        transaction.commit()?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        Ok(queue)
    }

    fn connection(&self) -> Result<Connection, OutboxError> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(3))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version != VERSION {
            return Err(OutboxError::UnsupportedVersion(version));
        }
        connection.pragma_update(None, "synchronous", "FULL")?;
        Ok(connection)
    }

    pub fn stage(&self, owner: &str, payload: &Value) -> Result<(), OutboxError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO staged(owner,payload) VALUES (?1,?2)",
            params![owner, serde_json::to_string(payload)?],
        )?;
        check_capacity(&transaction)?;
        transaction.commit()?;
        Ok(())
    }

    /// Builds immutable outgoing batches within one transaction. The callback must
    /// not do network IO. Failure preserves every staged observation for retry.
    pub fn prepare(
        &self,
        owner: &str,
        build: impl FnOnce(Vec<Value>) -> Result<Vec<Value>, String>,
    ) -> Result<(), OutboxError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let has_ready: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM ready WHERE owner=?1)",
            [owner],
            |row| row.get(0),
        )?;
        if has_ready {
            return Ok(());
        }
        let rows = {
            let mut statement = transaction
                .prepare("SELECT id,payload FROM staged WHERE owner=?1 ORDER BY id LIMIT 500")?;
            let result = statement
                .query_map([owner], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            result
        };
        if rows.is_empty() {
            return Ok(());
        }
        let values = rows
            .iter()
            .map(|(_, value)| serde_json::from_str(value))
            .collect::<Result<Vec<Value>, _>>()?;
        let batches = build(values).map_err(OutboxError::InvalidBatch)?;
        if batches.is_empty() {
            return Err(OutboxError::InvalidBatch("empty batch output".into()));
        }
        let source_bytes: usize = rows.iter().map(|(_, payload)| payload.len()).sum();
        let byte_budget = source_bytes
            .saturating_mul(CONVERSION_FACTOR)
            .saturating_add(rows.len().saturating_mul(CONVERSION_METADATA_BYTES));
        if batches.len() > rows.len().saturating_mul(CONVERSION_FACTOR) {
            return Err(OutboxError::InvalidBatch(
                "conversion exceeds bounded row expansion".into(),
            ));
        }
        let mut output_bytes = 0usize;
        for payload in batches {
            let batch_id = payload
                .get("batchId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| OutboxError::InvalidBatch("missing batchId".into()))?;
            let encoded = serde_json::to_string(&payload)?;
            output_bytes = output_bytes.saturating_add(encoded.len());
            if output_bytes > byte_budget {
                return Err(OutboxError::InvalidBatch(
                    "conversion exceeds bounded byte expansion".into(),
                ));
            }
            transaction.execute(
                "INSERT INTO ready(owner,batch_id,payload) VALUES (?1,?2,?3)",
                params![owner, batch_id, encoded],
            )?;
        }
        for (id, _) in rows {
            transaction.execute("DELETE FROM staged WHERE id=?1", [id])?;
        }
        // Admission quota applies to stage, not conversion: splitting a full
        // queue must be able to create ACK-able records. The per-source bounds
        // above cap global expansion even across owners and client instances:
        // ready_rows + 8*staged_rows <= 8*MAX_ROWS, and the analogous byte bound
        // includes 1024 bytes per source. stage refuses additions above quota.
        transaction.commit()?;
        Ok(())
    }

    pub fn next(&self, owner: &str) -> Result<Option<Value>, OutboxError> {
        let connection = self.connection()?;
        let payload: Option<String> = connection
            .query_row(
                "SELECT payload FROM ready WHERE owner=?1 ORDER BY id LIMIT 1",
                [owner],
                |row| row.get(0),
            )
            .optional()?;
        payload
            .map(|value| serde_json::from_str(&value).map_err(OutboxError::from))
            .transpose()
    }

    pub fn acknowledge(&self, owner: &str, batch_id: &str) -> Result<(), OutboxError> {
        self.connection()?.execute(
            "DELETE FROM ready WHERE owner=?1 AND batch_id=?2",
            params![owner, batch_id],
        )?;
        Ok(())
    }
}

fn check_capacity(connection: &Connection) -> Result<(), OutboxError> {
    check_capacity_with_limits(connection, MAX_ROWS, MAX_BYTES)
}

fn check_capacity_with_limits(
    connection: &Connection,
    max_rows: i64,
    max_bytes: i64,
) -> Result<(), OutboxError> {
    let (rows, bytes): (i64,i64) = connection.query_row("SELECT COUNT(*), COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM (SELECT payload FROM staged UNION ALL SELECT payload FROM ready)", [], |row| Ok((row.get(0)?,row.get(1)?)))?;
    if rows > max_rows || bytes > max_bytes {
        return Err(OutboxError::Capacity);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "vestus-outbox-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn batch(id: &str, reports: Vec<Value>) -> Vec<Value> {
        vec![json!({"batchId":id,"reports":reports})]
    }

    #[test]
    fn reopen_retry_ack_and_owner_isolation() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        queue.stage("a", &json!({"event":1})).unwrap();
        queue.stage("b", &json!({"event":2})).unwrap();
        drop(queue);
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        queue.prepare("a", |v| Ok(batch("one", v))).unwrap();
        let expected = queue.next("a").unwrap().unwrap();
        assert_eq!(expected["reports"], json!([{"event":1}]));
        assert!(queue.next("b").unwrap().is_none());
        queue.acknowledge("b", "one").unwrap();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        assert_eq!(queue.next("a").unwrap(), Some(expected));
        queue.acknowledge("a", "one").unwrap();
        assert!(queue.next("a").unwrap().is_none());
        queue.prepare("b", |v| Ok(batch("two", v))).unwrap();
        assert_eq!(
            queue.next("b").unwrap().unwrap()["reports"],
            json!([{"event":2}])
        );
    }

    #[test]
    fn failed_prepare_rolls_back_all_changes() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        queue.stage("a", &json!(1)).unwrap();
        assert!(queue.prepare("a", |_| Err("failed".into())).is_err());
        assert!(queue
            .prepare("a", |v| Ok(vec![
                json!({"batchId":"same","reports":v}),
                json!({"batchId":"same"})
            ]))
            .is_err());
        assert!(queue.next("a").unwrap().is_none());
        queue.prepare("a", |v| Ok(batch("good", v))).unwrap();
        assert_eq!(queue.next("a").unwrap().unwrap()["reports"], json!([1]));
    }

    #[test]
    fn unknown_version_is_preserved() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        queue.stage("a", &json!(1)).unwrap();
        let connection = queue.connection().unwrap();
        connection.pragma_update(None, "user_version", 42).unwrap();
        assert!(matches!(
            ActivityOutbox::open(&dir.0),
            Err(OutboxError::UnsupportedVersion(42))
        ));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM staged", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            42
        );
    }

    #[test]
    fn capacity_failure_preserves_existing_records() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        let connection = queue.connection().unwrap();
        connection.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO staged(owner,payload) SELECT 'a','1' FROM n").unwrap();
        assert!(matches!(
            queue.stage("a", &json!(2)),
            Err(OutboxError::Capacity)
        ));
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM staged", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            MAX_ROWS
        );
    }

    #[test]
    fn concurrent_instances_prepare_each_record_once() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        for n in 0..40 {
            queue.stage("a", &json!(n)).unwrap();
        }
        let handles: Vec<_> = (0..4)
            .map(|n| {
                let path = dir.0.clone();
                std::thread::spawn(move || {
                    let queue = ActivityOutbox::open(&path).unwrap();
                    queue
                        .prepare("a", |v| Ok(batch(&format!("batch-{n}"), v)))
                        .unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            queue.next("a").unwrap().unwrap()["reports"]
                .as_array()
                .unwrap()
                .len(),
            40
        );
        let connection = queue.connection().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ready", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM staged", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn byte_capacity_counts_utf8_and_both_queue_states() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        queue.stage("a", &json!("中文")).unwrap();
        queue.prepare("a", |v| Ok(batch("one", v))).unwrap();
        queue.stage("b", &json!("中文")).unwrap();
        let connection = queue.connection().unwrap();
        let bytes = serde_json::to_vec(&queue.next("a").unwrap().unwrap())
            .unwrap()
            .len() as i64
            + 8;
        assert!(check_capacity_with_limits(&connection, 2, bytes).is_ok());
        assert!(matches!(
            check_capacity_with_limits(&connection, 2, bytes - 1),
            Err(OutboxError::Capacity)
        ));
    }

    #[test]
    fn unversioned_existing_schema_is_not_overwritten() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        let connection = queue.connection().unwrap();
        connection.pragma_update(None, "user_version", 0).unwrap();
        assert!(matches!(
            ActivityOutbox::open(&dir.0),
            Err(OutboxError::UnsupportedVersion(0))
        ));
        assert!(connection.prepare("SELECT * FROM staged").is_ok());
    }
    #[test]
    fn full_queue_can_expand_to_deliverable_batches_for_multiple_owners() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        let connection = queue.connection().unwrap();
        connection.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO staged(owner,payload) SELECT CASE WHEN x<=5000 THEN 'a' ELSE 'b' END,'1' FROM n").unwrap();
        for owner in ["a", "b"] {
            queue
                .prepare(owner, |values| {
                    assert_eq!(values.len(), 500);
                    Ok((0..3500)
                        .map(|index| json!({"batchId":format!("{owner}-{index}"), "pages":[1]}))
                        .collect())
                })
                .unwrap();
            assert!(queue.next(owner).unwrap().is_some());
            queue
                .prepare(owner, |_| {
                    panic!("must drain this owner's ready batches first")
                })
                .unwrap();
        }
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM ready", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            7000
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM staged", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            9000
        );
        assert!(matches!(
            queue.stage("a", &json!(2)),
            Err(OutboxError::Capacity)
        ));
        queue.acknowledge("a", "a-0").unwrap();
        assert_eq!(queue.next("a").unwrap().unwrap()["batchId"], "a-1");
    }

    #[test]
    fn excessive_conversion_expansion_rolls_back_without_losing_sources() {
        let dir = Directory::new();
        let queue = ActivityOutbox::open(&dir.0).unwrap();
        queue.stage("a", &json!(1)).unwrap();
        assert!(matches!(
            queue.prepare("a", |_| Ok((0..9)
                .map(|index| json!({"batchId":format!("b-{index}")}))
                .collect())),
            Err(OutboxError::InvalidBatch(_))
        ));
        assert!(matches!(
            queue.prepare("a", |_| Ok(vec![
                json!({"batchId":"huge", "data":"x".repeat(2048)})
            ])),
            Err(OutboxError::InvalidBatch(_))
        ));
        assert!(queue.next("a").unwrap().is_none());
        queue
            .prepare("a", |values| {
                assert_eq!(values, vec![json!(1)]);
                Ok(batch("good", values))
            })
            .unwrap();
        assert_eq!(queue.next("a").unwrap().unwrap()["batchId"], "good");
    }
}
