use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use rusqlite::Connection;
use rusqlite::config::DbConfig;

use super::*;

/// Every file under `dir` with its bytes.
fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap())
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                fs::read(e.path()).unwrap(),
            )
        })
        .collect()
}

/// An Electron vault database in WAL mode whose rows sit only in the `-wal`: the writer neither
/// checkpoints nor checkpoints on close, as after Electron was killed.
fn electron_vault(root: &Path, schema: &str, rows: &str) -> Connection {
    fs::create_dir_all(root.join(".memry")).unwrap();
    let db = Connection::open(root.join(".memry/data.db")).unwrap();
    db.pragma_update(None, "journal_mode", "WAL").unwrap();
    db.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    db.execute_batch(schema).unwrap();
    db.execute_batch(rows).unwrap();
    db.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .unwrap();
    db
}

const SCHEMA: &str = "
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, modified_at TEXT);
    CREATE TABLE vault_metadata (id TEXT PRIMARY KEY, vault_uuid TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sync_devices (id TEXT PRIMARY KEY, name TEXT, is_current_device INTEGER,
        signing_public_key TEXT);";

#[test]
fn reads_the_checked_values_from_a_copy_and_leaves_the_vault_byte_identical() {
    let vault = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let writer = electron_vault(
        vault.path(),
        SCHEMA,
        r#"
        INSERT INTO vault_metadata VALUES ('singleton', 'vault-uuid-1', 1, 1);
        INSERT INTO settings (key, value) VALUES ('vault.crypto.verifier.v1', 'verifier=');
        INSERT INTO settings (key, value) VALUES ('ai-inline', '{"provider":"ollama","apiKey":"sk-1"}');
        INSERT INTO sync_devices VALUES ('other', 'b', 0, 'other-key=');
        INSERT INTO sync_devices VALUES ('me', 'a', 1, 'my-key=');"#,
    );
    drop(writer);
    let memry = vault.path().join(".memry");
    let before = tree(&memry);
    assert!(before.contains_key("data.db-wal"));

    let evidence = read_vault_evidence(vault.path(), scratch.path())
        .unwrap()
        .unwrap();
    assert_eq!(
        evidence,
        VaultEvidence {
            vault_id: Some("vault-uuid-1".to_owned()),
            key_verifier: Some("verifier=".to_owned()),
            device_public_key: Some("my-key=".to_owned()),
            inline_ai_reenter: true,
        }
    );
    assert_eq!(
        tree(&memry),
        before,
        "no byte of the vault's .memry changed"
    );
    assert!(tree(scratch.path()).is_empty(), "the copy is removed");
}

#[test]
fn an_older_schema_and_empty_rows_read_as_absent() {
    let vault = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let _writer = electron_vault(
        vault.path(),
        "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE sync_devices (id TEXT PRIMARY KEY, is_current_device INTEGER);",
        r#"INSERT INTO settings VALUES ('ai-inline', '{"provider":"openai","apiKey":"sk-1"}');
           INSERT INTO sync_devices VALUES ('me', 1);"#,
    );
    let evidence = read_vault_evidence(vault.path(), scratch.path())
        .unwrap()
        .unwrap();
    assert_eq!(evidence, VaultEvidence::default());
}

#[test]
fn a_vault_without_a_database_has_no_evidence() {
    let vault = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    assert_eq!(
        read_vault_evidence(vault.path(), scratch.path()).unwrap(),
        None
    );
    assert!(!vault.path().join(".memry").exists());
}
