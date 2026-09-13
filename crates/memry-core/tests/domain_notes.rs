//! Note domain writes against real SQLite (T126).
//!
//! | Test                                          | Rule                              |
//! | --------------------------------------------- | --------------------------------- |
//! | a create writes payload, projection and queue  | FR-030, §A.2, §13.2 rule 3        |
//! | the pushed bytes are the stored bytes          | chapter 06 §6.5.2 P2              |
//! | an edit merges and never rebuilds from the row | §13.2 rules 3 and 4               |
//! | the vault root is an explicit null             | chapter 13 §13.4                  |
//! | a delete tombstones and queues a delete        | §5.8, §A.2                        |
//! | a refused create leaves nothing behind         | FR-030, one transaction           |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-domain-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn note(id: &str) -> NewNote<'_> {
    NewNote {
        id,
        title: "A note",
        folder_path: Some("Notes"),
        content: "",
        tags: &[],
        properties: None,
    }
}

fn payload_of(conn: &Connection, item_type: &str, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn outbox_ops(conn: &Connection, item_id: &str) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT op FROM outbox WHERE item_id = ?1 ORDER BY id")
        .expect("prepare");
    let rows = statement
        .query_map(params![item_id], |row| row.get::<_, String>(0))
        .expect("query");
    rows.map(|row| row.expect("a row")).collect()
}

#[test]
fn a_create_writes_the_payload_the_projection_and_the_queue_row_together() {
    let db = open("notes-create");
    db.call_blocking(|conn| {
        let stored = notes::create(conn, &note("note1"), DEVICE, NOW)?.acknowledge();

        // One set of bytes: what the function returned, what the column holds,
        // and what a push rebuilds from the live row are one string (§6.5.2).
        assert_eq!(
            sync_items::push_payload(conn, "note", "note1")?.as_deref(),
            Some(stored.as_str())
        );

        let parsed: Value = serde_json::from_str(&stored).expect("valid JSON");
        assert_eq!(parsed["title"], json!("A note"));
        assert_eq!(parsed["folderPath"], json!("Notes"));
        assert_eq!(parsed["fileType"], json!("markdown"));
        assert_eq!(parsed["content"], json!(""));
        assert_eq!(parsed["clock"], json!({"device-a": 1}));
        assert_eq!(parsed["createdAt"], json!("2025-10-09T08:53:20.000Z"));
        assert_eq!(parsed["modifiedAt"], parsed["createdAt"]);
        assert!(parsed.get("tags").is_none(), "no tags were asked for");

        let (title, folder): (String, String) = conn
            .query_row(
                "SELECT title, folder_path FROM notes WHERE id = 'note1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the projection row");
        assert_eq!((title.as_str(), folder.as_str()), ("A note", "Notes"));

        // The body row exists from the first moment, with no seed and no text
        // (data-model §A.3).
        let (text, seed): (String, Option<String>) = conn
            .query_row(
                "SELECT text, seed_markdown FROM note_bodies WHERE note_id = 'note1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the body row");
        assert_eq!(text, "");
        assert_eq!(seed, None);

        assert_eq!(outbox_ops(conn, "note1"), vec!["upsert".to_owned()]);
        Ok(())
    })
    .expect("create");
}

#[test]
fn a_rename_merges_into_the_stored_payload_and_advances_the_clock() {
    let db = open("notes-rename");
    db.call_blocking(|conn| {
        notes::create(conn, &note("note1"), DEVICE, NOW)?;
        let stored = notes::rename(conn, "note1", "Renamed", DEVICE, NOW + 60_000)?.acknowledge();

        let parsed: Value = serde_json::from_str(&stored).expect("valid JSON");
        assert_eq!(parsed["title"], json!("Renamed"));
        // Merged, not rebuilt: the keys the rename never mentioned are still
        // there, with `createdAt` untouched and `modifiedAt` moved.
        assert_eq!(parsed["folderPath"], json!("Notes"));
        assert_eq!(parsed["createdAt"], json!("2025-10-09T08:53:20.000Z"));
        assert_eq!(parsed["modifiedAt"], json!("2025-10-09T08:54:20.000Z"));
        assert_eq!(parsed["clock"], json!({"device-a": 2}));

        let title: String = conn
            .query_row("SELECT title FROM notes WHERE id = 'note1'", [], |row| {
                row.get(0)
            })
            .expect("the projection row");
        assert_eq!(title, "Renamed");

        // A record enqueue supersedes the earlier one for the same key.
        assert_eq!(outbox_ops(conn, "note1"), vec!["upsert".to_owned()]);
        Ok(())
    })
    .expect("rename");
}

#[test]
fn a_move_to_the_vault_root_writes_an_explicit_null_rather_than_dropping_the_key() {
    let db = open("notes-move");
    db.call_blocking(|conn| {
        notes::create(conn, &note("note1"), DEVICE, NOW)?;

        let moved = notes::move_to_folder(conn, "note1", Some("Archive/2026"), DEVICE, NOW + 1)?
            .acknowledge();
        assert_eq!(
            serde_json::from_str::<Value>(&moved).unwrap()["folderPath"],
            json!("Archive/2026")
        );

        let rooted = notes::move_to_folder(conn, "note1", None, DEVICE, NOW + 2)?.acknowledge();
        let parsed: Value = serde_json::from_str(&rooted).expect("valid JSON");
        assert!(
            parsed.get("folderPath").is_some(),
            "absent means `keep your own value` (§13.4); the root is a null"
        );
        assert_eq!(parsed["folderPath"], Value::Null);

        let folder: Option<String> = conn
            .query_row(
                "SELECT folder_path FROM notes WHERE id = 'note1'",
                [],
                |row| row.get(0),
            )
            .expect("the projection row");
        assert_eq!(folder, None);
        Ok(())
    })
    .expect("move");
}

#[test]
fn a_delete_tombstones_the_row_projects_it_and_queues_a_delete() {
    let db = open("notes-delete");
    db.call_blocking(|conn| {
        notes::create(conn, &note("note1"), DEVICE, NOW)?;
        notes::delete(conn, "note1", DEVICE, NOW + 5)?.acknowledge();

        let row = sync_items::load(conn, "note", "note1")?.expect("the row");
        assert_eq!(row.deleted_at, Some(NOW + 5));

        let deleted_at: Option<i64> = conn
            .query_row(
                "SELECT deleted_at FROM notes WHERE id = 'note1'",
                [],
                |row| row.get(0),
            )
            .expect("the projection row");
        assert_eq!(deleted_at, Some(NOW + 5));

        // The payload is still here, with the clock advanced by the delete.
        assert_eq!(
            payload_of(conn, "note", "note1")["clock"],
            json!({"device-a": 2})
        );
        assert_eq!(outbox_ops(conn, "note1"), vec!["delete".to_owned()]);
        Ok(())
    })
    .expect("delete");
}

#[test]
fn a_refused_create_leaves_no_payload_no_projection_and_no_queue_row() {
    let db = open("notes-refused");
    db.call_blocking(|conn| {
        notes::create(conn, &note("note1"), DEVICE, NOW)?;
        conn.execute("DELETE FROM outbox", []).expect("drain");

        let again = notes::create(conn, &note("note1"), DEVICE, NOW + 1);
        assert!(again.is_err(), "an id that already exists is refused");

        // The first note is untouched and the refusal queued nothing: the
        // merge and its outbox row are one transaction, so a failed write is
        // no write at all.
        assert_eq!(
            payload_of(conn, "note", "note1")["clock"],
            json!({"device-a": 1})
        );
        let queued: i64 = conn
            .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
            .expect("count");
        assert_eq!(queued, 0);

        // And an edit to a note that does not exist is an error, never a
        // silent create.
        assert!(notes::rename(conn, "missing", "x", DEVICE, NOW).is_err());
        Ok(())
    })
    .expect("refuse");
}

#[test]
fn an_unknown_key_written_by_a_newer_peer_survives_a_local_rename() {
    let db = open("notes-unknown-key");
    db.call_blocking(|conn| {
        let newer = r#"{"title":"A note","coverImage":{"url":"memry://cover/1"}}"#;
        sync_items::apply_remote(
            conn,
            &sync_items::InboundRecord {
                item_type: "note".to_owned(),
                item_id: "note1".to_owned(),
                payload_json: newer.to_owned(),
                server_cursor: Some(7),
                signer_device_id: Some("device-b".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            },
            NOW,
        )?;

        notes::rename(conn, "note1", "Renamed", DEVICE, NOW + 1)?.acknowledge();
        let parsed = payload_of(conn, "note", "note1");
        assert_eq!(parsed["title"], json!("Renamed"));
        assert_eq!(parsed["coverImage"], json!({"url": "memry://cover/1"}));
        Ok(())
    })
    .expect("merge");
}

#[test]
fn a_body_row_is_readable_after_a_create() {
    let db = open("notes-body");
    db.call_blocking(|conn| {
        notes::create(conn, &note("note1"), DEVICE, NOW)?;
        let materialised: Option<i64> = conn
            .query_row(
                "SELECT materialised_at FROM note_bodies WHERE note_id = 'note1'",
                [],
                |row| row.get(0),
            )
            .optional()
            .expect("query");
        assert_eq!(materialised, Some(NOW));
        Ok(())
    })
    .expect("body");
}
