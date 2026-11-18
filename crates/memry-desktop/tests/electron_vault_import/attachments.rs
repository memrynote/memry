//! Stage 36f1: Electron's attachment sync state (`attachment_files`, `attachment_upload_queue`,
//! `attachment_download_failures`, `deleted_asset_releases`) into the Step 18 tables of core data
//! migration 0034, row for row, and read back through the core store the runners use.

use std::path::Path;

use memry_core::storage::import::DATA_FILE;
use memry_core::sync::attachments::store::releases::{ItemType, RecordedIds};
use memry_core::sync::attachments::store::{download_failures, files, releases, upload_queue};
use memry_desktop::electron_import::ImportError;
use memry_desktop::electron_import::vault_db::stage_vault_import;
use rusqlite::Connection;
use rusqlite::types::Value;

use super::{Vault, electron_db, import};

const NOTE: &str = "-0QKFMSbJ-18";
const T: i64 = 1_790_000_000_000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Each table with a query that reads every column in a stable order.
const TABLES: [(&str, &str); 4] = [
    (
        "attachment_files",
        "SELECT note_id, path, attachment_id, recorded_at FROM attachment_files \
         ORDER BY note_id, path",
    ),
    (
        "attachment_upload_queue",
        "SELECT id, note_id, disk_path, attempts, last_error, created_at, updated_at \
         FROM attachment_upload_queue ORDER BY id",
    ),
    (
        "attachment_download_failures",
        "SELECT id, owner_id, attachment_id, reason, attempts, last_error, next_attempt_at, \
         updated_at FROM attachment_download_failures ORDER BY id",
    ),
    (
        "deleted_asset_releases",
        "SELECT item_type, item_id, deleted_at, attachment_ids FROM deleted_asset_releases \
         ORDER BY item_type, item_id",
    ),
];

fn text(s: &str) -> Value {
    Value::Text(s.into())
}

fn opt(s: Option<&str>) -> Value {
    s.map_or(Value::Null, text)
}

fn upload_path(vault: &Vault, name: &str) -> String {
    vault
        .root
        .join("attachments")
        .join(NOTE)
        .join(name)
        .to_string_lossy()
        .into_owned()
}

fn seed_upload(conn: &Connection, id: &str, owner: &str, path: &str, attempts: Value) {
    electron_db::seed(
        conn,
        "attachment_upload_queue",
        &[
            ("id", text(id)),
            ("note_id", text(owner)),
            ("disk_path", text(path)),
            ("attempts", attempts),
            ("last_error", Value::Null),
            ("created_at", Value::Integer(T)),
            ("updated_at", Value::Integer(T + 5)),
        ],
    );
}

fn seed_failure(
    conn: &Connection,
    owner: &str,
    attachment: &str,
    reason: &str,
    attempts: i64,
    next_attempt_at: Option<i64>,
) {
    electron_db::seed(
        conn,
        "attachment_download_failures",
        &[
            ("id", text(&format!("{owner}::{attachment}"))),
            ("owner_id", text(owner)),
            ("attachment_id", text(attachment)),
            ("reason", text(reason)),
            ("attempts", Value::Integer(attempts)),
            ("last_error", text("HTTP 404")),
            ("next_attempt_at", next_attempt_at.map_or(Value::Null, Value::Integer)),
            ("updated_at", Value::Integer(T + attempts)),
        ],
    );
}

/// The state an Electron vault holds mid-sync: a finished upload, a counted older file and an
/// empty-note count; a fresh and a failing queued upload; a reference proven gone, one still
/// being probed, a transient failure and a gone one whose owner still owes an upload; and
/// deletes of each item type, one with an unreadable id list.
fn seed_attachment_state(vault: &Vault) {
    let conn = vault.data_conn();
    for (owner, path, attachment, at) in [
        (NOTE, "attachments/-0QKFMSbJ-18/photo.png", Some("att-up"), T),
        (NOTE, "attachments/-0QKFMSbJ-18/old.pdf", None, T + 1),
        ("NvXCU8_x4cv9", files::COUNTED_EMPTY, None, T + 2),
    ] {
        electron_db::seed(
            &conn,
            "attachment_files",
            &[
                ("note_id", text(owner)),
                ("path", text(path)),
                ("attachment_id", opt(attachment)),
                ("recorded_at", Value::Integer(at)),
            ],
        );
    }
    seed_upload(&conn, "q-1", NOTE, &upload_path(vault, "new.png"), Value::Integer(0));
    electron_db::seed(
        &conn,
        "attachment_upload_queue",
        &[
            ("id", text("q-2")),
            ("note_id", text("canvas-1")),
            ("disk_path", text(&upload_path(vault, "scan.jpg"))),
            ("attempts", Value::Integer(4)),
            ("last_error", text("HTTP 503")),
            ("created_at", Value::Integer(T + 10)),
            ("updated_at", Value::Integer(T + 20)),
        ],
    );
    seed_failure(&conn, "n1", "att-gone", "missing", 3, None);
    seed_failure(&conn, "n1", "att-probe", "missing", 2, Some(T + DAY_MS));
    seed_failure(&conn, "n2", "att-blip", "transient", 5, Some(T + 60_000));
    seed_failure(&conn, NOTE, "att-held", "missing", 3, None);
    for (item_type, item_id, ids) in [
        ("note", "n-del", Some(r#"["a","b"]"#)),
        ("canvas", "c-del", None),
        ("inbox", "i-del", Some(r#"["x"]"#)),
        ("note", "n-bad", Some("not json")),
    ] {
        electron_db::seed(
            &conn,
            "deleted_asset_releases",
            &[
                ("item_type", text(item_type)),
                ("item_id", text(item_id)),
                ("deleted_at", Value::Integer(T)),
                ("attachment_ids", opt(ids)),
            ],
        );
    }
}

fn rows(conn: &Connection, sql: &str) -> Vec<Vec<Value>> {
    let mut stmt = conn.prepare(sql).unwrap();
    let width = stmt.column_count();
    stmt.query_map([], |row| (0..width).map(|i| row.get(i)).collect())
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn installed(vault: &Vault) -> Connection {
    Connection::open(vault.core().join(DATA_FILE)).unwrap()
}

#[test]
fn attachment_tables_import_row_for_row() {
    let vault = Vault::new();
    seed_attachment_state(&vault);
    let report = import(&vault);

    let (source, core) = (vault.data_conn(), installed(&vault));
    for (table, sql) in TABLES {
        let expected = rows(&source, sql);
        assert!(!expected.is_empty(), "{table} seeded");
        assert_eq!(rows(&core, sql), expected, "{table}");
        let t = &report.tables[&format!("data.db/{table}")];
        assert_eq!(
            (t.source_count, t.target_count, t.dropped),
            (expected.len() as u64, expected.len() as u64, 0),
            "{table}"
        );
    }
    assert!(
        !report.dropped.contains_key("downloadFailures"),
        "{:?}",
        report.dropped
    );
}

/// The imported rows drive the core store exactly as Electron left them: a finished file is
/// known (not uploaded again), queued uploads keep their place and retry window, the prune rule
/// sees only the reference Electron had given up on, and each delete keeps its grace.
#[test]
fn imported_attachment_state_reads_back_through_the_core_store() {
    let vault = Vault::new();
    seed_attachment_state(&vault);
    import(&vault);
    let core = installed(&vault);

    let known = files::records(&core, NOTE).unwrap();
    assert_eq!(
        known
            .iter()
            .map(|f| (f.path.as_str(), f.attachment_id.as_deref()))
            .collect::<Vec<_>>(),
        vec![
            ("attachments/-0QKFMSbJ-18/old.pdf", None),
            ("attachments/-0QKFMSbJ-18/photo.png", Some("att-up")),
        ]
    );
    assert!(files::owners_with_records(&core).unwrap().contains("NvXCU8_x4cv9"));

    let pending = upload_queue::list_pending(&core, upload_queue::DRAIN_BATCH_LIMIT).unwrap();
    assert_eq!(
        pending
            .iter()
            .map(|p| (p.owner_id.as_str(), p.attempts, p.retry_opens_at()))
            .collect::<Vec<_>>(),
        // Four failures wait min(1 min * 2^3, 6 h) after the last write.
        vec![(NOTE, 0, 0), ("canvas-1", 4, T + 20 + 8 * 60_000)]
    );
    assert!(upload_queue::has_pending(&core, NOTE, &upload_path(&vault, "new.png")).unwrap());

    let refs = ["att-gone", "att-probe", "att-blip", "att-never"].map(String::from);
    let gone = download_failures::proven_gone(&core, "n1", &refs).unwrap();
    assert_eq!(gone.into_iter().collect::<Vec<_>>(), vec!["att-gone"]);
    // A gone reference of an owner that still owes an upload is not pruned.
    let held = download_failures::proven_gone(&core, NOTE, &["att-held".into()]).unwrap();
    assert!(held.is_empty());
    let may = |owner, id, at| download_failures::may_attempt(&core, owner, id, at).unwrap();
    assert!(!may("n1", "att-probe", T + DAY_MS - 1));
    assert!(may("n1", "att-probe", T + DAY_MS));
    assert!(!may("n1", "att-gone", i64::MAX));
    assert!(may("n2", "att-blip", T + 60_000));

    assert!(releases::due(&core, T - 1).unwrap().is_empty(), "grace runs from the delete");
    let due = releases::due(&core, T).unwrap();
    let mut seen = due
        .iter()
        .map(|d| (d.item_type.clone(), d.item_id.as_str(), d.attachment_ids.clone()))
        .collect::<Vec<_>>();
    seen.sort_by(|a, b| a.1.cmp(b.1));
    assert_eq!(
        seen,
        vec![
            (Ok(ItemType::Canvas), "c-del", RecordedIds::None),
            (Ok(ItemType::Inbox), "i-del", RecordedIds::Ids(vec!["x".into()])),
            (Ok(ItemType::Note), "n-bad", RecordedIds::Unreadable),
            (
                Ok(ItemType::Note),
                "n-del",
                RecordedIds::Ids(vec!["a".into(), "b".into()])
            ),
        ]
    );
}

fn file_bytes(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut found: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (
                e.file_name().to_string_lossy().into_owned(),
                std::fs::read(e.path()).unwrap(),
            )
        })
        .collect();
    found.sort();
    found
}

/// The import carries paths only: attachment files, a partial download and its resume sidecar
/// (`attachments.ts:105-118`, `.<id>.<name>.mrypart` and `<partial>.json`) stay where Electron
/// left them, byte for byte, so the transfer resumes at the first missing chunk.
#[test]
fn attachment_files_and_partial_downloads_stay_in_place() {
    let vault = Vault::new();
    let dir = vault.root.join("attachments").join(NOTE);
    std::fs::create_dir_all(&dir).unwrap();
    let partial = ".att-down.photo.png.mrypart";
    for (name, bytes) in [
        ("new.png", b"\x89PNG queued".as_slice()),
        ("photo.png", b"\x89PNG uploaded"),
        (partial, b"first two chunks"),
        (
            ".att-down.photo.png.mrypart.json",
            br#"{"version":1,"attachmentId":"att-down","checksum":"c","chunkCount":4,"chunksDone":2,"bytesWritten":16}"#,
        ),
    ] {
        std::fs::write(dir.join(name), bytes).unwrap();
    }
    let before = file_bytes(&dir);
    seed_upload(
        &vault.data_conn(),
        "q-1",
        NOTE,
        &upload_path(&vault, "new.png"),
        Value::Integer(0),
    );

    import(&vault);

    assert_eq!(file_bytes(&dir), before);
    assert_eq!(
        upload_queue::list_pending(&installed(&vault), 50).unwrap()[0].disk_path,
        upload_path(&vault, "new.png")
    );
}

/// A count that is no integer is no row Electron wrote: the run stops before anything installs.
#[test]
fn an_attachment_row_of_the_wrong_type_fails_the_import() {
    let vault = Vault::new();
    seed_upload(
        &vault.data_conn(),
        "q-1",
        NOTE,
        &upload_path(&vault, "new.png"),
        text("twice"),
    );
    assert!(matches!(
        stage_vault_import(vault.input()),
        Err(ImportError::MalformedRow {
            table: "attachment_upload_queue",
            ..
        })
    ));
    assert!(!vault.staging().exists());
    assert!(!vault.core().join(DATA_FILE).exists());
}
