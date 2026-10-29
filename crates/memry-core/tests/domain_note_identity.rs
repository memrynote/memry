//! The note a vault file is, against real SQLite (desktop Step 13d, #3530).
//!
//! | Test                                                      | Rule                                |
//! | --------------------------------------------------------- | ----------------------------------- |
//! | a new file creates a note with its dates and queues it    | Electron `indexer.ts` new file      |
//! | a record with no file is adopted, keeping its id          | an id is never minted twice         |
//! | asked again after a crash, the same note is answered      | idempotent across create and row    |
//! | a deleted note, a filed note, another folder never match  | one note per file                   |
//! | an un-imported Electron vault gets no new note            | Electron ids come from Step 36 only |
//! | a rename edits title and folder once, keeps or drops slot | Electron `processRename`, #1646     |
//! | a removed file deletes its note once                      | §5.8, one tombstone                 |
//! | a local-only note's removal pushes nothing                | the gate in `outbox::enqueue`       |
//! | a journal day keeps its record                            | Step 13m owns journal days          |

use memry_core::api::errors::StorageError;
use memry_core::domain::note_files::{self, NoteFileStat};
use memry_core::domain::note_positions;
use memry_core::domain::notes::identity::{
    self, Adopted, ELECTRON_IMPORT_META_KEY, FileNote, Moved, Removed,
};
use memry_core::domain::notes::{self, local_only};
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_core::storage::{Db, open_data};
use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
const BORN: i64 = 1_700_000_000_000;
const TOUCHED: i64 = 1_700_000_500_000;

fn open(label: &str) -> Db {
    let dir = tempfile::Builder::new()
        .prefix(&format!("memry-identity-{label}-"))
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn run<T: Send + 'static>(
    db: &Db,
    f: impl FnOnce(&mut Connection) -> Result<T, StorageError> + Send + 'static,
) -> T {
    db.call_blocking(f).expect("a database call")
}

fn file(title: &'static str, folder_path: Option<&'static str>) -> FileNote<'static> {
    FileNote {
        title,
        folder_path,
        created_ms: BORN,
        modified_ms: TOUCHED,
        electron_db_beside: false,
    }
}

fn adopt(db: &Db, file: FileNote<'static>, new_id: &'static str) -> Adopted {
    run(db, move |conn| {
        identity::adopt(conn, &file, new_id, DEVICE, NOW)
    })
}

fn create(db: &Db, id: &'static str, title: &'static str, folder: Option<&'static str>) {
    run(db, move |conn| {
        notes::create(
            conn,
            &notes::NewNote {
                id,
                title,
                folder_path: folder,
                content: "",
                tags: &[],
                properties: None,
                emoji: None,
            },
            DEVICE,
            NOW,
        )
        .map(drop)
    });
}

fn give_row(db: &Db, id: &'static str, path: &'static str) {
    run(db, move |conn| {
        note_files::upsert_stat(
            conn,
            &NoteFileStat {
                note_id: id.to_owned(),
                path: path.to_owned(),
                file_type: "markdown".to_owned(),
                mime_type: None,
                file_size: Some(1),
                content_hash: None,
                indexed_at: NOW,
            },
        )
    });
}

fn clear_outbox(db: &Db) {
    run(db, |conn| {
        conn.execute("DELETE FROM outbox", [])
            .map(drop)
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
    });
}

/// `(op, item_id)` of every queued row, in order.
fn outbox(db: &Db) -> Vec<(String, String)> {
    run(db, |conn| {
        let mut statement = conn
            .prepare("SELECT op, item_id FROM outbox ORDER BY id")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query");
        Ok(rows.map(|row| row.expect("a row")).collect())
    })
}

fn payload(db: &Db, id: &'static str) -> Value {
    run(db, move |conn| {
        let raw = sync_items::push_payload(conn, "note", id)?.expect("a payload");
        Ok(serde_json::from_str(&raw).expect("valid JSON"))
    })
}

fn note_count(db: &Db) -> i64 {
    run(db, |conn| {
        Ok(conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("count"))
    })
}

fn deleted(db: &Db, id: &'static str) -> bool {
    run(db, move |conn| {
        Ok(conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM notes WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .expect("the note"))
    })
}

fn position(db: &Db, path: &'static str) -> Option<(String, i64)> {
    run(db, move |conn| {
        Ok(conn
            .query_row(
                "SELECT folder_path, position FROM note_positions WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .expect("read"))
    })
}

fn place(db: &Db, folder: &'static str, paths: &'static [&'static str]) {
    let paths: Vec<String> = paths.iter().map(|path| (*path).to_owned()).collect();
    run(db, move |conn| {
        note_positions::reorder(conn, folder, &paths)
    });
}

#[test]
fn a_new_file_creates_a_note_with_the_files_dates_and_queues_it_once() {
    let db = open("create");
    assert_eq!(
        adopt(&db, file("Plan", Some("Work/2025")), "new1"),
        Adopted::Created("new1".to_owned())
    );
    let stored = payload(&db, "new1");
    assert_eq!(stored["title"], json!("Plan"));
    assert_eq!(stored["folderPath"], json!("Work/2025"));
    assert_eq!(stored["fileType"], json!("markdown"));
    assert_eq!(stored["content"], json!(""));
    assert_eq!(stored["createdAt"], json!("2023-11-14T22:13:20.000Z"));
    assert_eq!(stored["modifiedAt"], json!("2023-11-14T22:21:40.000Z"));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "new1".to_owned())]);

    let root = adopt(&db, file("Inbox", None), "new2");
    assert_eq!(root, Adopted::Created("new2".to_owned()));
    assert_eq!(payload(&db, "new2")["folderPath"], Value::Null);
}

/// A record pulled before its file was written keeps the id every device knows.
#[test]
fn a_record_with_no_file_is_adopted_and_keeps_its_id() {
    let db = open("pulled");
    let record = json!({
        "title": "Plan",
        "content": "",
        "fileType": "markdown",
        "folderPath": "Work",
        "clock": {"device-b": 3},
        "createdAt": "2025-01-01T00:00:00.000Z",
        "modifiedAt": "2025-01-02T00:00:00.000Z",
    });
    let inbound = InboundRecord {
        item_type: "note".to_owned(),
        item_id: "server-id".to_owned(),
        payload_json: record.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    };
    run(&db, move |conn| {
        sync_items::apply_remote(conn, &inbound, NOW).map(drop)
    });

    assert_eq!(
        adopt(&db, file("Plan", Some("Work")), "minted"),
        Adopted::Existing("server-id".to_owned())
    );
    assert_eq!(note_count(&db), 1);
    assert!(outbox(&db).is_empty());
}

/// A crash between the note's create and its row: asked again, the same note answers.
#[test]
fn asked_again_before_the_row_is_written_the_same_note_answers() {
    let db = open("again");
    assert_eq!(
        adopt(&db, file("Plan", None), "first"),
        Adopted::Created("first".to_owned())
    );
    clear_outbox(&db);
    assert_eq!(
        adopt(&db, file("Plan", None), "second"),
        Adopted::Existing("first".to_owned())
    );
    assert_eq!(note_count(&db), 1);
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_deleted_note_a_filed_note_or_another_folder_is_never_matched() {
    let db = open("no-match");
    create(&db, "gone", "Plan", None);
    run(&db, |conn| {
        notes::delete(conn, "gone", DEVICE, NOW).map(drop)
    });
    create(&db, "filed", "Plan", None);
    give_row(&db, "filed", "Plan.md");
    create(&db, "elsewhere", "Plan", Some("Work"));
    create(&db, "empty-folder", "Plan", Some(""));

    assert_eq!(
        adopt(&db, file("Plan", None), "fresh"),
        Adopted::Created("fresh".to_owned())
    );
    // The oldest of two unfiled notes answers, and only the folder the file is in.
    create(&db, "younger", "Plan", Some("Work"));
    assert_eq!(
        adopt(&db, file("Plan", Some("Work")), "unused"),
        Adopted::Existing("elsewhere".to_owned())
    );
}

#[test]
fn an_electron_vault_not_imported_gets_no_new_note() {
    let db = open("electron");
    let beside = FileNote {
        electron_db_beside: true,
        ..file("Plan", None)
    };
    assert_eq!(adopt(&db, beside, "minted"), Adopted::Withheld);
    assert_eq!(note_count(&db), 0);
    assert!(outbox(&db).is_empty());

    // Once the import marked the vault, a new file is a new note.
    run(&db, |conn| {
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, '{\"version\":1}')",
            params![ELECTRON_IMPORT_META_KEY],
        )
        .map(drop)
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    });
    assert_eq!(
        adopt(&db, beside, "minted"),
        Adopted::Created("minted".to_owned())
    );
}

/// A vault whose notes are in the core (created, pulled or imported) is past the import, even
/// with Electron's database beside it: a native vault Electron opened once.
#[test]
fn a_vault_with_notes_in_the_core_creates_beside_electrons_database() {
    let db = open("native");
    create(&db, "mine", "Mine", None);
    let beside = FileNote {
        electron_db_beside: true,
        ..file("Plan", None)
    };
    assert_eq!(
        adopt(&db, beside, "minted"),
        Adopted::Created("minted".to_owned())
    );
}

#[test]
fn a_rename_in_its_folder_edits_the_title_once_and_keeps_the_slot() {
    let db = open("rename");
    create(&db, "n1", "Old", Some("Work"));
    place(&db, "Work", &["Work/Other.md", "Work/Old.md"]);
    clear_outbox(&db);
    let moved = Moved {
        old_path: "Work/Old.md",
        new_path: "Work/New.md",
        title: "New",
        folder_path: Some("Work"),
    };
    run(&db, move |conn| {
        identity::renamed(conn, "n1", &moved, DEVICE, NOW + 1)
    });

    let stored = payload(&db, "n1");
    assert_eq!(stored["title"], json!("New"));
    assert_eq!(stored["folderPath"], json!("Work"));
    assert_eq!(stored["clock"], json!({"device-a": 2}));
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "n1".to_owned())]);
    assert_eq!(position(&db, "Work/Old.md"), None);
    assert_eq!(position(&db, "Work/New.md"), Some(("Work".to_owned(), 1)));
}

#[test]
fn a_move_to_another_folder_edits_the_folder_and_drops_the_old_slot() {
    let db = open("move");
    create(&db, "n1", "Plan", Some("Work"));
    place(&db, "Work", &["Work/Plan.md"]);
    clear_outbox(&db);
    let moved = Moved {
        old_path: "Work/Plan.md",
        new_path: "Plan.md",
        title: "Plan",
        folder_path: None,
    };
    run(&db, move |conn| {
        identity::renamed(conn, "n1", &moved, DEVICE, NOW + 1)
    });

    let stored = payload(&db, "n1");
    assert_eq!(stored["title"], json!("Plan"));
    assert_eq!(stored["folderPath"], Value::Null);
    assert_eq!(outbox(&db), vec![("upsert".to_owned(), "n1".to_owned())]);
    assert_eq!(position(&db, "Work/Plan.md"), None);
    assert_eq!(position(&db, "Plan.md"), None);
}

/// A rename the record already says (the app's own rename, seen again) writes nothing.
#[test]
fn a_rename_the_record_already_says_queues_nothing() {
    let db = open("rename-same");
    create(&db, "n1", "Plan", None);
    clear_outbox(&db);
    let moved = Moved {
        old_path: "Old.md",
        new_path: "Plan.md",
        title: "Plan",
        folder_path: None,
    };
    run(&db, move |conn| {
        identity::renamed(conn, "n1", &moved, DEVICE, NOW + 1)
    });
    assert!(outbox(&db).is_empty());
    assert_eq!(payload(&db, "n1")["clock"], json!({"device-a": 1}));
}

#[test]
fn a_removed_file_deletes_its_note_once() {
    let db = open("remove");
    create(&db, "n1", "Plan", None);
    place(&db, "", &["Plan.md"]);
    clear_outbox(&db);
    let removed = run(&db, |conn| {
        identity::removed(conn, "n1", "Plan.md", DEVICE, NOW + 1)
    });
    assert_eq!(removed, Removed::Deleted);
    assert!(deleted(&db, "n1"));
    assert_eq!(outbox(&db), vec![("delete".to_owned(), "n1".to_owned())]);
    assert_eq!(position(&db, "Plan.md"), None);

    // A crash before the row went: asked again, nothing more is written.
    clear_outbox(&db);
    let again = run(&db, |conn| {
        identity::removed(conn, "n1", "Plan.md", DEVICE, NOW + 2)
    });
    assert_eq!(again, Removed::Deleted);
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_local_only_notes_removal_pushes_nothing() {
    let db = open("local-only");
    create(&db, "n1", "Secret", None);
    give_row(&db, "n1", "Secret.md");
    run(&db, |conn| local_only::set(conn, "n1", true, NOW).map(drop));
    clear_outbox(&db);
    let removed = run(&db, |conn| {
        identity::removed(conn, "n1", "Secret.md", DEVICE, NOW + 1)
    });
    assert_eq!(removed, Removed::Deleted);
    assert!(deleted(&db, "n1"));
    assert!(outbox(&db).is_empty());
}

#[test]
fn a_journal_days_removal_keeps_its_record() {
    let db = open("journal");
    let removed = run(&db, |conn| {
        identity::removed(conn, "j2025-01-01", "journal/2025-01-01.md", DEVICE, NOW)
    });
    assert_eq!(removed, Removed::Kept);
    assert!(outbox(&db).is_empty());
}
