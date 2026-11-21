//! Stage 36b1: the record tables whose payload Electron builds from the row, and the vault id.

use memry_core::storage::import::DATA_FILE;
use memry_desktop::electron_import::ImportError;
use memry_desktop::electron_import::vault_db::stage_vault_import;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::{Vault, electron_db, import};

const UUID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

/// Ids as real profiles hold them: uppercase, `_`, `-`, a 21 character nanoid, and a
/// decomposed `é` that must not be normalised.
const IDS: [&str; 4] = [
    "-0QKFMSbJ-18",
    "Projects/NvXCU8_x4cv9",
    "V1StGXR8_Z5jdHi6B-myT",
    "Cafe\u{301}/Notes",
];

fn seed_vault_metadata(conn: &Connection, uuid: &str) {
    electron_db::seed(
        conn,
        "vault_metadata",
        &[
            ("id", Value::Text("singleton".into())),
            ("vault_uuid", Value::Text(uuid.into())),
        ],
    );
}

fn seed_folder(conn: &Connection, path: &str, clock: Option<&str>) {
    electron_db::seed(
        conn,
        "folder_configs",
        &[
            ("path", Value::Text(path.into())),
            ("icon", Value::Text("star".into())),
            (
                "clock",
                clock.map_or(Value::Null, |c| Value::Text(c.into())),
            ),
            ("created_at", Value::Text("2026-01-02T03:04:05.000Z".into())),
            (
                "modified_at",
                Value::Text("2026-01-03T03:04:05.000Z".into()),
            ),
        ],
    );
}

fn seed_property(conn: &Connection, name: &str, clock: Option<&str>, synced_at: Option<&str>) {
    electron_db::seed(
        conn,
        "property_definitions",
        &[
            ("name", Value::Text(name.into())),
            ("type", Value::Text("select".into())),
            ("options", Value::Text(r#"["a","b"]"#.into())),
            (
                "clock",
                clock.map_or(Value::Null, |c| Value::Text(c.into())),
            ),
            ("created_at", Value::Text("2026-01-02T03:04:05.000Z".into())),
            (
                "synced_at",
                synced_at.map_or(Value::Null, |s| Value::Text(s.into())),
            ),
        ],
    );
}

fn installed(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

#[test]
fn records_and_the_vault_id_import_byte_for_byte() {
    let vault = Vault::new();
    let conn = vault.data_conn();
    seed_vault_metadata(&conn, UUID);
    for (n, id) in IDS.iter().enumerate() {
        let clock = format!(r#"{{"dev-B":{},"a":1}}"#, n + 1);
        seed_folder(&conn, id, Some(&clock));
        seed_property(&conn, id, Some(&clock), Some("2026-01-04T00:00:00.000Z"));
    }
    seed_folder(&conn, "unclocked", None);
    seed_property(&conn, "unclocked", Some("null"), None);
    drop(conn);

    let mut input = vault.input();
    input.vault_id = UUID.into();
    let staged = super::staged(stage_vault_import(input).unwrap());
    let report = staged.report().clone();
    staged.install().unwrap();
    assert_eq!(report.checks_passed, vec![1, 2, 5, 6]);
    for (table, written) in [
        ("data.db/folder_configs", 5),
        ("data.db/property_definitions", 5),
        ("data.db/vault_metadata", 1),
    ] {
        assert_eq!(report.tables[table].target_count, written, "{table}");
    }

    let core = installed(&vault);
    let ids = |item_type: &str| -> Vec<String> {
        core.prepare("SELECT item_id FROM sync_items WHERE item_type = ?1 ORDER BY item_id")
            .unwrap()
            .query_map([item_type], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    let mut expected: Vec<String> = IDS.iter().map(|id| (*id).to_owned()).collect();
    expected.push("unclocked".into());
    expected.sort();
    assert_eq!(ids("folder_config"), expected);
    assert_eq!(ids("property_definition"), expected);

    // The payload Electron pushes, key for key and in its order.
    let (payload, clock): (String, String) = core
        .query_row(
            "SELECT payload, clock FROM sync_items WHERE item_type = 'folder_config' AND item_id = ?1",
            [IDS[0]],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        payload,
        r#"{"icon":"star","clock":{"dev-B":1,"a":1},"createdAt":"2026-01-02T03:04:05.000Z","modifiedAt":"2026-01-03T03:04:05.000Z"}"#
    );
    assert_eq!(clock, r#"{"dev-B":1,"a":1}"#);
    let (payload, synced_at): (String, i64) = core
        .query_row(
            "SELECT s.payload, p.synced_at FROM sync_items s JOIN property_definitions p \
             ON p.name = s.item_id WHERE s.item_type = 'property_definition' AND s.item_id = ?1",
            [IDS[3]],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        payload,
        format!(
            r#"{{"name":"{}","type":"select","options":"[\"a\",\"b\"]","defaultValue":null,"color":null,"clock":{{"dev-B":4,"a":1}},"createdAt":"2026-01-02T03:04:05.000Z"}}"#,
            IDS[3]
        )
    );
    assert_eq!(synced_at, 1_767_484_800_000);
    let unclocked: Option<String> = core
        .query_row(
            "SELECT clock FROM sync_items WHERE item_type = 'property_definition' AND item_id = 'unclocked'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unclocked, None);
    // `clock ?? undefined`: an unclocked row carries no `clock` key, `null` included.
    for (item_type, expected) in [
        (
            "folder_config",
            r#"{"icon":"star","createdAt":"2026-01-02T03:04:05.000Z","modifiedAt":"2026-01-03T03:04:05.000Z"}"#,
        ),
        (
            "property_definition",
            r#"{"name":"unclocked","type":"select","options":"[\"a\",\"b\"]","defaultValue":null,"color":null,"createdAt":"2026-01-02T03:04:05.000Z"}"#,
        ),
    ] {
        let payload: String = core
            .query_row(
                "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = 'unclocked'",
                [item_type],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(payload, expected, "{item_type}");
    }
    let folders: i64 = core
        .query_row("SELECT count(*) FROM folders", [], |row| row.get(0))
        .unwrap();
    assert_eq!(folders, 5);
    drop(core);

    // The core reads the vault id back as its own.
    let db = memry_core::storage::open_data(&vault.core().join(DATA_FILE)).unwrap();
    let id = db
        .call_blocking(memry_core::storage::vault_identity::resolve)
        .unwrap();
    assert_eq!(id, UUID);
}

#[test]
fn a_vault_uuid_other_than_the_run_id_fails_before_install() {
    let vault = Vault::new();
    seed_vault_metadata(&vault.data_conn(), UUID);
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::CheckFailed { check: 5, .. })
    ));
    assert!(!vault.staging().exists());
    assert!(!vault.core().exists());
}

#[test]
fn a_clock_that_is_not_json_fails_the_import_naming_the_row() {
    let vault = Vault::new();
    seed_folder(&vault.data_conn(), "a", Some("{not json"));
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::MalformedRow {
            table: "folder_configs",
            ..
        })
    ));
    assert!(!vault.staging().exists());
}

/// Check 5 compares the staged clock with the source text: a clock JSON Electron would not
/// have written (`JSON.stringify` writes no spaces) re-serialises differently and stops the run.
#[test]
fn a_clock_that_does_not_round_trip_fails_check_5() {
    let vault = Vault::new();
    seed_property(&vault.data_conn(), "p", Some(r#"{"a": 1}"#), None);
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::CheckFailed { check: 5, .. })
    ));
    assert!(!vault.staging().exists());
}

#[test]
fn an_empty_vault_metadata_leaves_the_vault_id_to_the_first_open() {
    let vault = Vault::new();
    import(&vault);
    let has_id: bool = installed(&vault)
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key = 'vault.id')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!has_id);
}
