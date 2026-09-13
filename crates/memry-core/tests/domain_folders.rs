//! Folder domain writes against real SQLite (T126, FR-051).
//!
//! | Test                                        | Rule                             |
//! | ------------------------------------------- | -------------------------------- |
//! | a create writes an explicit null icon        | chapter 13 §13.7.10              |
//! | a rename re-keys the subtree and the notes   | §13.6, §A.4, FR-051              |
//! | the re-key carries the unknown keys          | FR-033, §13.2                    |
//! | a folder with no config still moves its notes | §13.7.10                       |
//! | a move into itself and onto a used path fail | one transaction, nothing written |
//! | a delete refuses a subtree that holds notes  | no chapter defines a cascade     |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::{folders, notes};
use memry_core::storage::repositories::sync_items;
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, params};
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

fn note_in(
    conn: &Connection,
    id: &str,
    folder: &str,
) -> Result<(), memry_core::api::errors::StorageError> {
    notes::create(
        conn,
        &notes::NewNote {
            id,
            title: id,
            folder_path: Some(folder),
            content: "",
            tags: &[],
            properties: None,
        },
        DEVICE,
        NOW,
    )?;
    Ok(())
}

fn payload_of(conn: &Connection, item_type: &str, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn live_folders(conn: &Connection) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT path FROM folders WHERE deleted_at IS NULL ORDER BY path")
        .expect("prepare");
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query");
    rows.map(|row| row.expect("a row")).collect()
}

fn queued_keys(conn: &Connection) -> Vec<(String, String, String)> {
    let mut statement = conn
        .prepare("SELECT item_type, item_id, op FROM outbox ORDER BY item_type, item_id, op")
        .expect("prepare");
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("query");
    rows.map(|row| row.expect("a row")).collect()
}

fn folder_of(conn: &Connection, note_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT folder_path FROM notes WHERE id = ?1",
        params![note_id],
        |row| row.get(0),
    )
    .expect("the projection row")
}

#[test]
fn a_create_writes_the_nullable_icon_key_and_derives_the_tree_columns() {
    let db = open("folders-create");
    db.call_blocking(|conn| {
        folders::create(conn, "Notes", None, DEVICE, NOW)?.acknowledge();
        folders::create(conn, "Notes/Protocol", Some("book"), DEVICE, NOW)?.acknowledge();

        let root = payload_of(conn, "folder_config", "Notes");
        assert!(
            root.get("icon").is_some(),
            "§13.7.10 makes `icon` nullable, not optional: the key is always there"
        );
        assert_eq!(root["icon"], Value::Null);
        assert_eq!(root["clock"], json!({"device-a": 1}));

        let (parent, name, icon): (Option<String>, String, Option<String>) = conn
            .query_row(
                "SELECT parent_path, name, icon FROM folders WHERE path = 'Notes/Protocol'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the projection row");
        assert_eq!(parent.as_deref(), Some("Notes"));
        assert_eq!(name, "Protocol");
        assert_eq!(icon.as_deref(), Some("book"));
        Ok(())
    })
    .expect("create");
}

#[test]
fn a_rename_re_keys_every_descendant_config_and_rewrites_every_note_path() {
    let db = open("folders-rename");
    db.call_blocking(|conn| {
        folders::create(conn, "Notes", None, DEVICE, NOW)?;
        folders::create(conn, "Notes/Protocol", Some("book"), DEVICE, NOW)?;
        folders::create(conn, "Notes2", None, DEVICE, NOW)?;
        note_in(conn, "note1", "Notes")?;
        note_in(conn, "note2", "Notes/Protocol")?;
        note_in(conn, "note3", "Notes2")?;

        let moved = folders::rename(conn, "Notes", "Archive", DEVICE, NOW + 1)?;
        assert_eq!(moved.to, "Archive");
        assert_eq!(
            moved.folders,
            vec![
                ("Notes".to_owned(), "Archive".to_owned()),
                ("Notes/Protocol".to_owned(), "Archive/Protocol".to_owned()),
            ]
        );
        assert_eq!(moved.notes, vec!["note1".to_owned(), "note2".to_owned()]);

        // The sibling that merely shares a prefix did not move.
        assert_eq!(
            live_folders(conn),
            vec![
                "Archive".to_owned(),
                "Archive/Protocol".to_owned(),
                "Notes2".to_owned()
            ]
        );
        assert_eq!(folder_of(conn, "note1").as_deref(), Some("Archive"));
        assert_eq!(
            folder_of(conn, "note2").as_deref(),
            Some("Archive/Protocol")
        );
        assert_eq!(folder_of(conn, "note3").as_deref(), Some("Notes2"));

        // The old ids are tombstoned and their deletes are queued alongside
        // the new ids' upserts: a re-key is a create plus a delete, because
        // the id is the path.
        let old = sync_items::load(conn, "folder_config", "Notes")?.expect("the old row");
        assert_eq!(old.deleted_at, Some(NOW + 1));
        let queued = queued_keys(conn);
        assert!(queued.contains(&(
            "folder_config".to_owned(),
            "Archive".to_owned(),
            "upsert".to_owned()
        )));
        assert!(queued.contains(&(
            "folder_config".to_owned(),
            "Notes".to_owned(),
            "delete".to_owned()
        )));
        assert!(queued.contains(&("note".to_owned(), "note2".to_owned(), "upsert".to_owned())));
        Ok(())
    })
    .expect("rename");
}

#[test]
fn the_re_key_carries_a_key_this_build_does_not_model() {
    let db = open("folders-unknown-key");
    db.call_blocking(|conn| {
        let newer = r#"{"icon":"book","position":3,"clock":{"device-b":4}}"#;
        sync_items::apply_remote(
            conn,
            &sync_items::InboundRecord {
                item_type: "folder_config".to_owned(),
                item_id: "Notes".to_owned(),
                payload_json: newer.to_owned(),
                server_cursor: Some(11),
                signer_device_id: Some("device-b".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            },
            NOW,
        )?;

        folders::rename(conn, "Notes", "Archive", DEVICE, NOW + 1)?;
        let moved = payload_of(conn, "folder_config", "Archive");
        assert_eq!(moved["icon"], json!("book"));
        assert_eq!(
            moved["position"],
            json!(3),
            "`position` has no reader here and must ride the re-key anyway"
        );
        assert_eq!(
            moved["clock"],
            json!({"device-a": 1, "device-b": 4}),
            "the peer's ticks are kept and this device's is added"
        );
        Ok(())
    })
    .expect("re-key");
}

#[test]
fn a_folder_that_only_exists_because_notes_are_in_it_still_moves() {
    let db = open("folders-implicit");
    db.call_blocking(|conn| {
        note_in(conn, "note1", "Inbox/Today")?;

        let moved = folders::move_to(conn, "Inbox", Some("Archive"), DEVICE, NOW + 1)?;
        assert!(
            moved.folders.is_empty(),
            "there was no folder_config to move"
        );
        assert_eq!(moved.notes, vec!["note1".to_owned()]);
        assert_eq!(
            folder_of(conn, "note1").as_deref(),
            Some("Archive/Inbox/Today")
        );
        Ok(())
    })
    .expect("implicit");
}

#[test]
fn a_move_that_cannot_be_made_sense_of_is_refused_and_writes_nothing() {
    let db = open("folders-refused");
    db.call_blocking(|conn| {
        folders::create(conn, "Notes", None, DEVICE, NOW)?;
        folders::create(conn, "Archive", None, DEVICE, NOW)?;
        note_in(conn, "note1", "Notes")?;
        conn.execute("DELETE FROM outbox", []).expect("drain");

        assert!(
            folders::move_to(conn, "Notes", Some("Notes"), DEVICE, NOW + 1).is_err(),
            "a folder cannot be moved inside itself"
        );
        assert!(
            folders::rename(conn, "Notes", "Archive", DEVICE, NOW + 1).is_err(),
            "the target path is already in use"
        );
        assert!(folders::rename(conn, "Notes", "a/b", DEVICE, NOW + 1).is_err());
        assert!(folders::create(conn, "/Notes", None, DEVICE, NOW + 1).is_err());

        assert_eq!(
            live_folders(conn),
            vec!["Archive".to_owned(), "Notes".to_owned()]
        );
        assert_eq!(folder_of(conn, "note1").as_deref(), Some("Notes"));
        let queued: i64 = conn
            .query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))
            .expect("count");
        assert_eq!(queued, 0, "a refused move queues nothing");
        Ok(())
    })
    .expect("refuse");
}

#[test]
fn a_delete_refuses_while_the_subtree_still_holds_a_note_and_then_takes_the_subtree() {
    let db = open("folders-delete");
    db.call_blocking(|conn| {
        folders::create(conn, "Notes", None, DEVICE, NOW)?;
        folders::create(conn, "Notes/Protocol", None, DEVICE, NOW)?;
        note_in(conn, "note1", "Notes/Protocol")?;

        let refused = folders::delete(conn, "Notes", DEVICE, NOW + 1);
        assert!(refused.is_err(), "no chapter defines a cascading delete");
        assert_eq!(
            live_folders(conn),
            vec!["Notes".to_owned(), "Notes/Protocol".to_owned()]
        );

        notes::move_to_folder(conn, "note1", None, DEVICE, NOW + 2)?;
        let removed = folders::delete(conn, "Notes", DEVICE, NOW + 3)?;
        assert_eq!(
            removed.folders,
            vec!["Notes".to_owned(), "Notes/Protocol".to_owned()]
        );
        assert!(live_folders(conn).is_empty());

        let child = sync_items::load(conn, "folder_config", "Notes/Protocol")?.expect("the row");
        assert_eq!(child.deleted_at, Some(NOW + 3));
        assert!(folders::delete(conn, "Notes", DEVICE, NOW + 4).is_err());
        Ok(())
    })
    .expect("delete");
}
