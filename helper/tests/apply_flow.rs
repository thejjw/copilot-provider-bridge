//! Integration coverage for the helper's apply sequence against a fixture
//! profile: rows commit before the JSON check, a hash mismatch leaves the file
//! untouched, and no secret value reaches the reported outcome.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::Value;

use cpb_credential_helper::configfile::sha256_hex;
use cpb_credential_helper::crypto::open;
use cpb_credential_helper::vault::MARKER_KEY;
use cpb_credential_helper::apply_core;

const KEY: [u8; 32] = [42u8; 32];
const SECRET: &str = "sk-live-must-not-leak";
const ROW_KEY: &str = "secret://chat.lm.secret.cpb-fixture";

fn fixture(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let user_dir = dir.join("User");
    fs::create_dir_all(user_dir.join("globalStorage")).unwrap();

    let db_path = user_dir.join("globalStorage").join("state.vscdb");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);
         INSERT INTO ItemTable VALUES ('__$__targetStorageMarker', '{\"keep-me\":1}');",
    )
    .unwrap();
    drop(conn);

    let config_path = user_dir.join("chatLanguageModels.json");
    fs::write(&config_path, "[]").unwrap();
    (user_dir, db_path, config_path)
}

fn secrets() -> BTreeMap<String, String> {
    [("fixture".to_string(), SECRET.to_string())]
        .into_iter()
        .collect()
}

fn stored_row(db_path: &Path) -> Vec<u8> {
    let conn = Connection::open(db_path).unwrap();
    let raw: String = conn
        .query_row("SELECT value FROM ItemTable WHERE key = ?1", [ROW_KEY], |row| {
            row.get(0)
        })
        .unwrap();
    let value: Value = serde_json::from_str(&raw).unwrap();
    value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|byte| byte.as_u64().unwrap() as u8)
        .collect()
}

fn marker(db_path: &Path) -> Value {
    let conn = Connection::open(db_path).unwrap();
    let raw: String = conn
        .query_row("SELECT value FROM ItemTable WHERE key = ?1", [MARKER_KEY], |row| {
            row.get(0)
        })
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn hash_mismatch_commits_rows_but_leaves_config_and_leaks_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let (user_dir, db_path, config_path) = fixture(tmp.path());
    let next = "[{\"name\":\"Next\"}]";

    let outcome = apply_core(
        &user_dir,
        KEY,
        next,
        &sha256_hex(b"a different snapshot"),
        &secrets(),
        false,
    );

    assert!(!outcome.ok);
    let error = outcome.error.clone().unwrap();
    assert!(error.contains("refusing to overwrite"), "{error}");
    assert_eq!(fs::read_to_string(&config_path).unwrap(), "[]");

    let blob = stored_row(&db_path);
    assert_eq!(open(&KEY, &blob).unwrap(), SECRET.as_bytes());
    assert_eq!(marker(&db_path)[ROW_KEY], 1);

    let reported = serde_json::to_string(&outcome).unwrap();
    assert!(!reported.contains(SECRET));
}

#[test]
fn apply_replaces_config_and_reports_only_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let (user_dir, db_path, config_path) = fixture(tmp.path());
    let next = "[{\"apiKey\":\"${input:chat.lm.secret.cpb-fixture}\"}]";

    let outcome = apply_core(&user_dir, KEY, next, &sha256_hex(b"[]"), &secrets(), false);

    assert!(outcome.ok, "{:?}", outcome.error);
    assert_eq!(outcome.updated, vec!["chat.lm.secret.cpb-fixture"]);
    assert_eq!(fs::read_to_string(&config_path).unwrap(), next);
    assert_eq!(marker(&db_path)[ROW_KEY], 1);

    let blob = stored_row(&db_path);
    assert_eq!(open(&KEY, &blob).unwrap(), SECRET.as_bytes());

    let reported = serde_json::to_string(&outcome).unwrap();
    assert!(!reported.contains(SECRET));
    assert!(!reported.contains("sk-live"));
}
