//! Stage 36c1: Electron's delete clocks and its queued record pushes, through the core outbox.

use memry_core::storage::import::DATA_FILE;
use memry_desktop::electron_import::ImportError;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::{Vault, assert_refused, electron_db, import};

fn text(value: &str) -> Value {
    Value::Text(value.into())
}

fn seed_folder(conn: &Connection, path: &str) {
    electron_db::seed(
        conn,
        "folder_configs",
        &[
            ("path", text(path)),
            ("clock", text(r#"{"dev-A":2}"#)),
            ("created_at", text("2026-01-02T03:04:05.000Z")),
            ("modified_at", text("2026-01-03T03:04:05.000Z")),
        ],
    );
}

fn seed_note(vault: &Vault, id: &str, path: &str, journal_date: Option<&str>, local_only: bool) {
    electron_db::seed(
        &vault.data_conn(),
        "note_metadata",
        &[
            ("id", text(id)),
            ("path", text(path)),
            ("title", text(id)),
            ("journal_date", journal_date.map_or(Value::Null, text)),
            ("local_only", Value::Integer(i64::from(local_only))),
            ("clock", text(r#"{"dev-A":5}"#)),
            ("synced_at", text("2026-01-05T10:00:00.000Z")),
            ("created_at", text("2026-01-05T08:00:00.000Z")),
            ("modified_at", text("2026-01-05T09:00:00.000Z")),
        ],
    );
    let file = vault.root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, "---\ntags: daily\n---\n\nToday.\n\n").unwrap();
}

/// One `sync_queue` row, `created_at` in epoch seconds.
fn queue(conn: &Connection, item_type: &str, id: &str, op: &str, payload: &str, at: i64) {
    queue_with(conn, item_type, id, op, payload, at, 0);
}

fn queue_with(
    conn: &Connection,
    item_type: &str,
    id: &str,
    op: &str,
    payload: &str,
    at: i64,
    attempts: i64,
) {
    electron_db::seed(
        conn,
        "sync_queue",
        &[
            ("type", text(item_type)),
            ("item_id", text(id)),
            ("operation", text(op)),
            ("payload", text(payload)),
            ("attempts", Value::Integer(attempts)),
            ("created_at", Value::Integer(at)),
        ],
    );
}

fn rows<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> Vec<(String, String, T)> {
    let mut stmt = conn.prepare(sql).unwrap();
    stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn queued_pushes_become_one_outbox_row_each_and_deletes_keep_their_tombstone() {
    const GONE: &str =
        r#"{"path":"Gone","clock":{"dev-A":3},"createdAt":"2026-01-02T03:04:05.000Z"}"#;
    let vault = Vault::new();
    let data = vault.data_conn();
    for path in ["Kept", "Created", "Revived"] {
        seed_folder(&data, path);
    }
    seed_note(
        &vault,
        "j2026-01-05",
        "journal/2026-01-05.md",
        Some("2026-01-05"),
        false,
    );
    seed_note(&vault, "Local-note-1", "Local.md", None, true);
    // Electron's push order is priority, then created_at; each item folds oldest first.
    queue(&data, "folder_config", "Created", "create", "{}", 100);
    queue_with(&data, "folder_config", "Kept", "update", "{}", 101, 5);
    queue(&data, "folder_config", "Kept", "update", "{}", 102);
    queue(&data, "folder_config", "Created", "update", "{}", 103);
    queue(&data, "folder_config", "Gone", "update", "{}", 104);
    queue(&data, "folder_config", "Gone", "delete", GONE, 105);
    queue(&data, "folder_config", "Revived", "delete", GONE, 106);
    queue(&data, "folder_config", "Missing", "update", "{}", 107);
    // Queued as a note, a journal day now.
    queue(&data, "note", "j2026-01-05", "create", "{}", 108);
    queue(&data, "note", "Local-note-1", "update", "{}", 109);
    electron_db::seed(
        &data,
        "sync_tombstone_clocks",
        &[
            ("type", text("note")),
            ("item_id", text("gone-note-1")),
            ("clock", text(r#"{"dev-A":2,"dev-B":1}"#)),
            ("updated_at", Value::Integer(50)),
        ],
    );
    electron_db::seed(
        &data,
        "sync_tombstone_clocks",
        &[
            ("type", text("folder_config")),
            ("item_id", text("Gone")),
            ("clock", text(r#"{"dev-A":3}"#)),
            ("updated_at", Value::Integer(51)),
        ],
    );
    drop(data);

    let report = import(&vault);
    assert_eq!(report.checks_passed, vec![1, 2, 4, 5, 6]);
    let queue_report = &report.tables["data.db/sync_queue"];
    assert_eq!(
        (queue_report.source_count, queue_report.target_count),
        (10, 7)
    );
    assert_eq!(report.dropped["staleQueueDeletes"], 1);
    assert_eq!(report.dropped["queueRowsWithoutRecord"], 1);
    assert_eq!(report.dropped["localOnlyQueueRows"], 1);
    assert_eq!(report.notices["deadLetterQueueRows"], 1);
    assert_eq!(
        report.tables["data.db/sync_tombstone_clocks"].target_count,
        2
    );

    let core = Connection::open(vault.core().join(DATA_FILE)).unwrap();
    assert_eq!(
        rows::<String>(
            &core,
            "SELECT item_type, item_id, op FROM outbox ORDER BY id"
        ),
        [
            ("folder_config", "Created", "create"),
            ("folder_config", "Kept", "upsert"),
            ("folder_config", "Gone", "delete"),
            ("journal", "j2026-01-05", "create"),
        ]
        .map(|(t, i, o)| (t.to_owned(), i.to_owned(), o.to_owned()))
    );
    assert_eq!(
        rows::<i64>(
            &core,
            "SELECT clock, payload, deleted_at FROM sync_items WHERE item_id = 'Gone'"
        ),
        vec![(r#"{"dev-A":3}"#.to_owned(), GONE.to_owned(), 105_000)]
    );
    let outbox_payloads: i64 = core
        .query_row(
            "SELECT count(*) FROM outbox WHERE payload IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(outbox_payloads, 0, "record rows carry no payload");
    // The fold is a create, so the day's payload carries its body.
    let day: String = core
        .query_row(
            "SELECT payload FROM sync_items WHERE item_type = 'journal' AND item_id = 'j2026-01-05'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let day: serde_json::Value = serde_json::from_str(&day).unwrap();
    assert_eq!(day["content"], "Today.");
    assert_eq!(
        rows::<String>(
            &core,
            "SELECT item_type, item_id, clock FROM sync_tombstone_clocks ORDER BY item_type"
        ),
        [
            ("folder_config", "Gone", r#"{"dev-A":3}"#),
            ("journal", "gone-note-1", r#"{"dev-A":2,"dev-B":1}"#),
            ("note", "gone-note-1", r#"{"dev-A":2,"dev-B":1}"#),
        ]
        .map(|(t, i, c)| (t.to_owned(), i.to_owned(), c.to_owned()))
    );
}

#[test]
fn a_note_body_queue_row_is_refused_with_a_message_the_user_can_act_on() {
    let vault = Vault::new();
    queue(
        &vault.data_conn(),
        "note_body",
        "-0QKFMSbJ-18",
        "update",
        "",
        100,
    );
    assert_refused(&vault, |e| {
        matches!(e, ImportError::NotReady { area: "note edit history", detail }
            if detail.contains("note_body"))
            && e.to_string().starts_with(
                "This version of MemryNote cannot move this vault's note edit history yet. \
                 Nothing was changed.",
            )
    });
}

#[test]
fn a_delete_payload_that_is_not_an_object_fails_naming_the_row() {
    let vault = Vault::new();
    queue(&vault.data_conn(), "task", "task-1", "delete", "[1]", 100);
    assert_refused(&vault, |e| {
        matches!(
            e,
            ImportError::MalformedRow {
                table: "sync_queue",
                ..
            }
        )
    });
}

/// Red without the size cap in `queue::delete_clock`: the padded body parses, and the import
/// stages.
#[test]
fn a_delete_payload_over_the_cap_fails_before_it_is_parsed() {
    let vault = Vault::new();
    let pad = "x".repeat(8 * 1024 * 1024);
    let payload = format!(r#"{{"clock":{{"dev-A":1}},"pad":"{pad}"}}"#);
    queue(
        &vault.data_conn(),
        "task",
        "task-1",
        "delete",
        &payload,
        100,
    );
    assert_refused(&vault, |e| {
        matches!(e, ImportError::MalformedRow { table: "sync_queue", what, .. }
            if what.contains("8 MiB"))
    });
}

/// A delete body nested far past serde_json's recursion limit (128) fails the import naming the
/// row, on a 2 MiB thread. The limit is the dependency's, so it cannot be shown red here.
#[test]
fn a_deeply_nested_delete_payload_fails_on_a_small_stack() {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            let vault = Vault::new();
            let payload = format!("{}{}", "{\"a\":".repeat(100_000), "}".repeat(100_000));
            queue(
                &vault.data_conn(),
                "task",
                "task-1",
                "delete",
                &payload,
                100,
            );
            assert_refused(&vault, |e| {
                matches!(
                    e,
                    ImportError::MalformedRow {
                        table: "sync_queue",
                        ..
                    }
                )
            });
        })
        .unwrap()
        .join()
        .unwrap();
}
