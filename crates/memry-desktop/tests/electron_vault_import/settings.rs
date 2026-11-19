//! Stage 36b4: Electron's `settings` table. The synced part becomes the core `settings`
//! record with its per-path clocks, the key verifier, account binding and tag keys go to `meta`,
//! and every other row stays device-local in `local_settings`.

use memry_core::storage::import::DATA_FILE;
use memry_desktop::electron_import::ImportError;
use memry_desktop::electron_import::vault_db::stage_vault_import;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::{Vault, electron_db, import};

const MODIFIED: &str = "2026-01-03T03:04:05.123Z";
const MODIFIED_MS: i64 = 1_767_409_445_123;

pub(super) fn seed(conn: &Connection, key: &str, value: &str) {
    electron_db::seed(
        conn,
        "settings",
        &[
            ("key", Value::Text(key.into())),
            ("value", Value::Text(value.into())),
            ("modified_at", Value::Text(MODIFIED.into())),
        ],
    );
}

fn installed(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

#[test]
fn settings_rows_reach_their_owners() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    seed(
        &conn,
        "synced_settings",
        r#"{"general":{"theme":"dark"},"experimental":{"x":1}}"#,
    );
    seed(
        &conn,
        "synced_settings_clocks",
        r#"{"general.theme":{"dev":2}}"#,
    );
    seed(&conn, "vault.crypto.verifier.v1", "verifier-text");
    seed(
        &conn,
        "sync.account-binding.v1",
        r#"{"userId":"u-1","mode":"bound"}"#,
    );
    seed(&conn, "general", r#"{"theme":"light"}"#);
    seed(&conn, "editor", "{}");
    seed(&conn, "lastSyncAt", "1767000000000");
    let ai = r#"{"enabled":true,"provider":"openai","model":"m","apiKey":"sk-1","baseUrl":""}"#;
    seed(&conn, "ai-inline", ai);
    seed(&conn, "journal.defaultTemplate", "daily");
    seed(&conn, "someFutureKey", "[1]");
    drop(conn);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    let table = &report.tables["data.db/settings"];
    assert_eq!(
        (table.source_count, table.dropped, table.target_count),
        (10, 1, 9)
    );
    assert_eq!(report.dropped.get("settingsSessionStatus"), Some(&1));
    assert_eq!(report.notices.get("unknownSettingsKeys"), Some(&1));

    let core = installed(&vault);
    let payload: String = core
        .query_row(
            "SELECT payload FROM sync_items WHERE item_type = 'settings' AND item_id = 'synced_settings'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        payload,
        r#"{"settings":{"general":{"theme":"dark"},"experimental":{"x":1}},"fieldClocks":{"general.theme":{"dev":2}}}"#
    );
    let clock: String = core
        .query_row(
            "SELECT clock FROM settings_field_clocks WHERE path = 'general.theme'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(clock, r#"{"dev":2}"#);

    let meta = |key: &str| -> String {
        core.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .unwrap()
    };
    assert_eq!(meta("vault.crypto.verifier.v1"), "verifier-text");
    assert_eq!(
        meta("sync.account-binding.v1"),
        r#"{"userId":"u-1","mode":"bound"}"#
    );

    let mut stmt = core
        .prepare("SELECT key, value, updated_at FROM local_settings ORDER BY key")
        .unwrap();
    let local: Vec<(String, String, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        local,
        vec![
            ("ai-inline".to_owned(), ai.to_owned(), MODIFIED_MS),
            ("editor".to_owned(), "{}".to_owned(), MODIFIED_MS),
            (
                "general".to_owned(),
                r#"{"theme":"light"}"#.to_owned(),
                MODIFIED_MS
            ),
            (
                "journal.defaultTemplate".to_owned(),
                "daily".to_owned(),
                MODIFIED_MS
            ),
            ("someFutureKey".to_owned(), "[1]".to_owned(), MODIFIED_MS),
        ]
    );
}

#[test]
fn unreadable_synced_settings_read_as_empty_as_electron_reads_them() {
    let vault = Vault::new();
    seed(&vault.data_conn(), "synced_settings", "{not json");
    let report = import(&vault);
    assert_eq!(report.notices.get("unreadableSyncedSettings"), Some(&1));
    let payload: String = installed(&vault)
        .query_row(
            "SELECT payload FROM sync_items WHERE item_type = 'settings'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(payload, r#"{"settings":{},"fieldClocks":{}}"#);
}

#[test]
fn readwise_run_state_is_not_ready_before_anything_is_written() {
    let vault = Vault::new();
    seed(&vault.data_conn(), "readwise.cursor", "\"c\"");
    let Err(error) = stage_vault_import(vault.input()) else {
        panic!("the import was not refused");
    };
    assert!(
        matches!(
            error,
            ImportError::NotReady {
                area: "attachments, whiteboards or Readwise highlights",
                ..
            }
        ),
        "{error:?}"
    );
    assert!(!vault.staging().exists());
}

/// Electron's tag rename cut off mid-run: the core's job needs a plan this import cannot derive,
/// so the vault is refused until Electron has finished it.
#[test]
fn an_unfinished_tag_rename_is_not_ready_before_anything_is_written() {
    let vault = Vault::new();
    seed(
        &vault.data_conn(),
        "tags.renameJob",
        r#"{"from":"a","to":"b","runId":"r1"}"#,
    );
    let Err(error) = stage_vault_import(vault.input()) else {
        panic!("the import was not refused");
    };
    assert!(
        matches!(
            &error,
            ImportError::NotReady {
                area: "tag rename that has not finished",
                detail,
            } if detail.contains("tags.renameJob")
        ),
        "{error:?}"
    );
    assert!(!vault.staging().exists());
}
