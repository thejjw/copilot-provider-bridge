//! Minimal writer for VS Code application storage (`ItemTable` in `state.vscdb`).
//!
//! Only `secret://chat.lm.secret.cpb-*` rows and the matching
//! `__$__targetStorageMarker` entries are touched. The journal mode is never
//! changed; callers wait for the editor to exit before opening a transaction.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::{Map, Value};

use crate::crypto::{BufferValue, seal};
use crate::error::{HelperError, Result};
use crate::protocol::secret_id;

pub const MARKER_KEY: &str = "__$__targetStorageMarker";

/// `<userDir>/globalStorage/state.vscdb`.
pub fn db_path(user_dir: &Path) -> PathBuf {
    user_dir.join("globalStorage").join("state.vscdb")
}

/// Storage key for a core secret id: core stores `secret://<id>`.
fn row_key(id: &str) -> String {
    format!("secret://{id}")
}

/// Open an existing database and verify the schema core creates.
pub fn open(db_path: &Path) -> Result<Connection> {
    if !db_path.exists() {
        return Err(HelperError::new(format!(
            "{} does not exist",
            db_path.display()
        )));
    }
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(Duration::from_secs(30))?;
    let table: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='ItemTable'",
        [],
        |row| row.get(0),
    )?;
    if table == 0 {
        return Err(HelperError::new(
            "state.vscdb has no ItemTable; is this a VS Code user-data directory?",
        ));
    }
    Ok(conn)
}

/// Poll `BEGIN IMMEDIATE` until the writer lock is available.
pub fn acquire_write_lock(conn: &mut Connection, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        match conn.transaction_with_behavior(TransactionBehavior::Immediate) {
            Ok(tx) => {
                tx.rollback()?;
                return Ok(());
            }
            Err(err) if is_busy(&err) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(err) => return Err(HelperError::from(err)),
        }
    }
}

fn is_busy(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == rusqlite::ErrorCode::DatabaseBusy
                || failure.code == rusqlite::ErrorCode::DatabaseLocked
    )
}

/// Insert or replace one sealed row per provider and merge marker entries.
pub fn apply_secrets(
    conn: &mut Connection,
    key: &[u8; 32],
    secrets: &BTreeMap<String, String>,
) -> Result<Vec<String>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut marker = read_marker(&tx)?;
    let mut updated = Vec::with_capacity(secrets.len());

    for (provider, value) in secrets {
        let id = secret_id(provider)?;
        let stored_key = row_key(&id);
        let blob = seal(key, value.as_bytes())?;
        let row = serde_json::to_string(&BufferValue::new(blob))?;
        tx.execute(
            "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
            params![stored_key, row],
        )?;
        marker.set(&stored_key, 1);
        updated.push(id);
    }
    write_marker(&tx, marker)?;
    tx.commit()?;
    Ok(updated)
}

/// Delete the given sealed rows and their marker entries only.
pub fn delete_secrets(conn: &mut Connection, ids: &[String]) -> Result<Vec<String>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut marker = read_marker(&tx)?;
    let mut removed = Vec::with_capacity(ids.len());

    for id in ids {
        let stored_key = row_key(id);
        let changed = tx.execute("DELETE FROM ItemTable WHERE key = ?1", params![stored_key])?;
        marker.remove(&stored_key);
        if changed > 0 {
            removed.push(id.clone());
        }
    }
    write_marker(&tx, marker)?;
    tx.commit()?;
    Ok(removed)
}

enum MarkerKind {
    Text,
    Blob,
}

struct Marker {
    kind: MarkerKind,
    entries: Map<String, Value>,
}

impl Marker {
    fn set(&mut self, id: &str, target: i64) {
        self.entries.insert(id.to_string(), Value::from(target));
    }

    fn remove(&mut self, id: &str) {
        self.entries.remove(id);
    }
}

fn read_marker(tx: &rusqlite::Transaction<'_>) -> Result<Marker> {
    use rusqlite::types::ValueRef;

    let raw: Option<(MarkerKind, Vec<u8>)> = tx
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1",
            [MARKER_KEY],
            |row| match row.get_ref(0)? {
                ValueRef::Text(text) => Ok(Some((MarkerKind::Text, text.to_vec()))),
                ValueRef::Blob(blob) => Ok(Some((MarkerKind::Blob, blob.to_vec()))),
                ValueRef::Null => Ok(None),
                other => Err(rusqlite::Error::InvalidColumnType(
                    0,
                    "value".to_string(),
                    other.data_type(),
                )),
            },
        )
        .optional()?
        .flatten();

    let Some((kind, bytes)) = raw else {
        return Ok(Marker {
            kind: MarkerKind::Text,
            entries: Map::new(),
        });
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|err| HelperError::new(format!("{MARKER_KEY} is not valid JSON: {err}")))?;
    let entries = value
        .as_object()
        .cloned()
        .ok_or_else(|| HelperError::new(format!("{MARKER_KEY} is not a JSON object")))?;
    Ok(Marker { kind, entries })
}

fn write_marker(tx: &rusqlite::Transaction<'_>, marker: Marker) -> Result<()> {
    let json = serde_json::to_vec(&Value::Object(marker.entries))?;
    match marker.kind {
        MarkerKind::Text => {
            let text = String::from_utf8(json)
                .map_err(|_| HelperError::new("marker serialization produced invalid UTF-8"))?;
            tx.execute(
                "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
                params![MARKER_KEY, text],
            )?;
        }
        MarkerKind::Blob => {
            tx.execute(
                "INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?1, ?2)",
                params![MARKER_KEY, json],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::open as open_blob;

    const KEY: [u8; 32] = [42u8; 32];

    fn fixture(db_path: &Path) {
        let conn = Connection::open(db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);
             INSERT INTO ItemTable VALUES ('__$__targetStorageMarker', '{\"keep-me\":1}');",
        )
        .unwrap();
    }

    fn secrets(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn row_bytes(conn: &Connection, id: &str) -> Vec<u8> {
        use rusqlite::types::ValueRef;
        conn.query_row("SELECT value FROM ItemTable WHERE key = ?1", [id], |row| {
            match row.get_ref(0)? {
                ValueRef::Text(text) => Ok(text.to_vec()),
                ValueRef::Blob(blob) => Ok(blob.to_vec()),
                _ => Err(rusqlite::Error::InvalidColumnType(
                    0,
                    "value".to_string(),
                    rusqlite::types::Type::Null,
                )),
            }
        })
        .unwrap()
    }

    fn buffer_data(raw: &[u8]) -> Vec<u8> {
        let value: Value = serde_json::from_slice(raw).unwrap();
        value["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect()
    }

    #[test]
    fn writes_rows_and_merges_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("state.vscdb");
        fixture(&db);
        let mut conn = open(&db).unwrap();

        let updated = apply_secrets(&mut conn, &KEY, &secrets(&[("zai", "sk-live-zai")])).unwrap();
        assert_eq!(updated, vec!["chat.lm.secret.cpb-zai"]);

        let blob = buffer_data(&row_bytes(&conn, "secret://chat.lm.secret.cpb-zai"));
        assert_eq!(open_blob(&KEY, &blob).unwrap(), b"sk-live-zai");

        let value_type: String = conn
            .query_row(
                "SELECT typeof(value) FROM ItemTable WHERE key = 'secret://chat.lm.secret.cpb-zai'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(value_type, "text");

        let marker: Value = serde_json::from_slice(&row_bytes(&conn, MARKER_KEY)).unwrap();
        assert_eq!(marker["secret://chat.lm.secret.cpb-zai"], 1);
        assert_eq!(marker["keep-me"], 1);

        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "delete");
    }

    #[test]
    fn delete_removes_only_requested_rows_and_marker_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("state.vscdb");
        fixture(&db);
        let mut conn = open(&db).unwrap();

        apply_secrets(&mut conn, &KEY, &secrets(&[("zai", "a"), ("kimi", "b")])).unwrap();
        let removed =
            delete_secrets(&mut conn, &["chat.lm.secret.cpb-zai".to_string()]).unwrap();
        assert_eq!(removed, vec!["chat.lm.secret.cpb-zai"]);

        let remaining: i64 = conn
            .query_row(
                "SELECT count(*) FROM ItemTable WHERE key = 'secret://chat.lm.secret.cpb-zai'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);

        let marker: Value = serde_json::from_slice(&row_bytes(&conn, MARKER_KEY)).unwrap();
        assert!(marker.get("secret://chat.lm.secret.cpb-zai").is_none());
        assert_eq!(marker["secret://chat.lm.secret.cpb-kimi"], 1);
        assert_eq!(marker["keep-me"], 1);
    }

    #[test]
    fn refuses_missing_database() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(open(&tmp.path().join("state.vscdb")).is_err());
    }
}
