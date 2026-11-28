//! Stage 36c1: queued deletes. Each one reaches the core outbox with a tombstone the core push
//! sends, as Electron's push coordinator sends it.

use memry_core::storage::import::DATA_FILE;
use memry_desktop::electron_import::ImportError;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::queue::{queue, rows, seed_note, text};
use super::{ELECTRON_DEVICE, Vault, assert_refused, electron_db, import};

fn core(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

fn outbox(core: &Connection) -> Vec<(String, String, String)> {
    rows(
        core,
        "SELECT item_type, item_id, op FROM outbox ORDER BY id",
    )
}

fn owned(rows: &[(&str, &str, &str)]) -> Vec<(String, String, String)> {
    rows.iter()
        .map(|(a, b, c)| ((*a).to_owned(), (*b).to_owned(), (*c).to_owned()))
        .collect()
}

/// `(payload, clock, deleted_at)` of the `sync_items` row of `item_id`.
fn tombstone(core: &Connection, item_id: &str) -> (String, String, Option<i64>) {
    core.query_row(
        "SELECT payload, clock, deleted_at FROM sync_items WHERE item_id = ?1",
        [item_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .unwrap()
}

/// Electron's `deleteTagCategory` keeps the row with `deleted_at` and queues a delete; no
/// pending-delete row backs it. A tag category is not re-creatable, so its row is no re-create.
#[test]
fn a_soft_deleted_tag_category_keeps_its_queued_delete() {
    const DELETE: &str = r#"{"id":"cat-1","clock":{"dev-A":4}}"#;
    let vault = Vault::new();
    let data = vault.data_conn();
    electron_db::seed(
        &data,
        "tag_categories",
        &[
            ("id", text("cat-1")),
            ("name", text("Work")),
            ("sort_order", Value::Integer(0)),
            ("clock", text(r#"{"dev-A":3}"#)),
            ("deleted_at", text("2026-01-05T00:00:00.000Z")),
            ("created_at", text("2026-01-02T03:04:05.000Z")),
            ("updated_at", text("2026-01-05T00:00:00.000Z")),
        ],
    );
    queue(&data, "tag_category", "cat-1", "delete", DELETE, 200);
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    assert!(!report.dropped.contains_key("staleQueueDeletes"));
    assert_eq!(report.tables["data.db/sync_queue"].target_count, 1);
    let core = core(&vault);
    assert_eq!(outbox(&core), owned(&[("tag_category", "cat-1", "delete")]));
    assert_eq!(
        tombstone(&core, "cat-1"),
        (
            DELETE.to_owned(),
            r#"{"dev-A":4}"#.to_owned(),
            Some(200_000)
        )
    );
    let projected: Option<i64> = core
        .query_row(
            "SELECT deleted_at FROM tag_categories WHERE id = 'cat-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(projected.is_some());
}

/// The kept fields of an item whose queued delete made it a tombstone have no record to merge
/// into; Electron's push sends the frozen delete body.
#[test]
fn unknown_fields_of_a_queued_delete_count_as_without_record() {
    const DELETE: &str = r#"{"path":"Gone","clock":{"dev-A":3}}"#;
    let vault = Vault::new();
    let data = vault.data_conn();
    queue(&data, "folder_config", "Gone", "delete", DELETE, 105);
    electron_db::seed(
        &data,
        "sync_unknown_fields",
        &[
            ("type", text("folder_config")),
            ("item_id", text("Gone")),
            ("fields", text(r#"{"future":1}"#)),
            ("updated_at", Value::Integer(1_767_000_000)),
        ],
    );
    drop(data);

    let report = import(&vault);
    assert_eq!(report.dropped["unknownFieldsWithoutRecord"], 1);
    assert_eq!(tombstone(&core(&vault), "Gone").0, DELETE);
}

/// Electron's `ensureRequiredClock` stamps `{deviceId: 1}` on a delete body without a usable
/// clock (pre-#1223 payloads), and rebuilds a body that is no JSON object as `{id, clock}`.
/// The core push retires a delete with no clock, so the import stamps it the same way.
#[test]
fn a_delete_without_a_clock_is_stamped_as_electron_pushes_it() {
    let vault = Vault::new();
    let data = vault.data_conn();
    queue(
        &data,
        "folder_config",
        "NoClock",
        "delete",
        r#"{"path":"NoClock"}"#,
        100,
    );
    queue(
        &data,
        "folder_config",
        "Empty",
        "delete",
        r#"{"clock":{},"path":"Empty"}"#,
        101,
    );
    queue(&data, "task", "task-1", "delete", "[1]", 102);
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    let core = core(&vault);
    let stamped = format!(r#"{{"{ELECTRON_DEVICE}":1}}"#);
    for (id, payload, at) in [
        (
            "NoClock",
            format!(r#"{{"path":"NoClock","clock":{stamped}}}"#),
            100_000,
        ),
        (
            "Empty",
            format!(r#"{{"clock":{stamped},"path":"Empty"}}"#),
            101_000,
        ),
        (
            "task-1",
            format!(r#"{{"id":"task-1","clock":{stamped}}}"#),
            102_000,
        ),
    ] {
        assert_eq!(
            tombstone(&core, id),
            (payload, stamped.clone(), Some(at)),
            "{id}"
        );
    }
    assert_eq!(
        outbox(&core),
        owned(&[
            ("folder_config", "NoClock", "delete"),
            ("folder_config", "Empty", "delete"),
            ("task", "task-1", "delete"),
        ])
    );
}

#[test]
fn a_delete_without_a_clock_and_no_electron_device_is_refused() {
    let mut vault = Vault::new();
    vault.device_id = None;
    queue(
        &vault.data_conn(),
        "folder_config",
        "NoClock",
        "delete",
        r#"{"path":"NoClock"}"#,
        100,
    );
    assert_refused(&vault, |e| {
        matches!(e, ImportError::DeleteWithoutDevice)
            && e.to_string().contains("Nothing was changed")
    });
}

/// `coalesceSyncOperations`: a delete after a create wins, so an item created and deleted
/// before it ever synced still sends its delete.
#[test]
fn a_create_then_a_delete_of_a_gone_item_queues_the_delete() {
    const DELETE: &str = r#"{"path":"Temp","clock":{"dev-A":2}}"#;
    let vault = Vault::new();
    let data = vault.data_conn();
    queue(&data, "folder_config", "Temp", "create", "{}", 100);
    queue(&data, "folder_config", "Temp", "delete", DELETE, 101);
    drop(data);

    let report = import(&vault);
    assert_eq!(report.tables["data.db/sync_queue"].target_count, 2);
    let core = core(&vault);
    assert_eq!(outbox(&core), owned(&[("folder_config", "Temp", "delete")]));
    assert_eq!(
        tombstone(&core, "Temp"),
        (
            DELETE.to_owned(),
            r#"{"dev-A":2}"#.to_owned(),
            Some(101_000)
        )
    );
}

/// A journal day deleted and written again: the create after the delete wins, and the day is
/// pushed with its body, not deleted.
#[test]
fn a_delete_then_a_create_of_a_journal_day_queues_the_create() {
    let vault = Vault::new();
    seed_note(
        &vault,
        "j2026-01-05",
        "journal/2026-01-05.md",
        Some("2026-01-05"),
        false,
    );
    let data = vault.data_conn();
    queue(
        &data,
        "journal",
        "j2026-01-05",
        "delete",
        r#"{"id":"j2026-01-05","clock":{"dev-A":4}}"#,
        100,
    );
    queue(&data, "journal", "j2026-01-05", "create", "{}", 101);
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    let core = core(&vault);
    assert_eq!(
        outbox(&core),
        owned(&[("journal", "j2026-01-05", "create")])
    );
    let (payload, _, deleted_at) = tombstone(&core, "j2026-01-05");
    assert_eq!(deleted_at, None);
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["content"], "Today.");
}
