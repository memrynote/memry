//! The read-only `Vault` and `Notes` surface (T164, band B3's minimum).
//!
//! Real SQLite, real `yrs`, no transport: a read never touches the network.
//!
//! | Test                                             | Rule                                    |
//! | ------------------------------------------------ | --------------------------------------- |
//! | an empty vault reads as empty                    | empty is empty                          |
//! | the reads return what the domain wrote           | data-model §A.4                         |
//! | an undecodable folder row fails the whole list   | never "could not tell" as empty         |
//! | an undecodable note row fails the whole list     | same, the second list                   |
//! | a deleted note is gone from the list and the read | §A.4's `deleted_at`, chapter 07 §7.15  |
//! | an unpulled body is not an empty note            | `NoteBody::present`                     |
//! | an undecodable update throws, never empty text   | `CrdtError::Undecodable`                |
//! | a list sees rows committed later                 | a live handle, not a snapshot           |

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::crdt::errors::CrdtError;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::{folders, notes};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use yrs::{ReadTxn as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// A scratch vault directory and the `Vault` opened over it.
///
/// The directory comes back too, because several tests reach past the exported
/// surface with a second connection to damage a row the way a projector bug
/// would.
fn vault(label: &str) -> (PathBuf, Vault) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-api-vault-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let opened = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (dir, opened)
}

/// A second handle on the same file, for the writes the read surface does not
/// own and for the damage it must refuse to paper over.
fn behind(dir: &Path) -> Db {
    open_data(&dir.join("data.db")).expect("second open")
}

fn execute(db: &Db, sql: &str) {
    db.call_blocking(|conn: &mut Connection| {
        conn.execute(sql, []).map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })
    })
    .expect("the statement runs");
}

fn seed(db: &Db) {
    db.call_blocking(|conn: &mut Connection| {
        folders::create(conn, "Work", Some("folder"), DEVICE, NOW)?;
        folders::create(conn, "Work/Deep", None, DEVICE, NOW)?;
        notes::create(
            conn,
            &notes::NewNote {
                id: "note-root",
                title: "at the root",
                folder_path: None,
                content: "",
                tags: &[],
                properties: None,
            },
            DEVICE,
            NOW,
        )?;
        notes::create(
            conn,
            &notes::NewNote {
                id: "note-work",
                title: "in Work",
                folder_path: Some("Work"),
                content: "",
                tags: &[],
                properties: None,
            },
            DEVICE,
            NOW + 1,
        )?;
        Ok(())
    })
    .expect("seed");
}

/// A real lib0 v1 update carrying `text` in the body fragment.
fn body_update(doc_id: &str, text: &str) -> Vec<u8> {
    let captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new("device-peer", sink)
        .get_or_open(doc_id)
        .expect("open");
    document
        .write(|txn| {
            let fragment = txn
                .get_xml_fragment("prosemirror")
                .expect("the root is typed at open");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new(text));
        })
        .expect("a write transaction");
    let updates = captured.lock().expect("lock").clone();
    updates.into_iter().next().expect("one update")
}

#[test]
fn an_empty_vault_reads_as_empty_and_never_as_a_failure() {
    let (_dir, opened) = vault("empty");
    let notes_api = opened.notes();

    assert_eq!(opened.id(), "vault-1");
    assert_eq!(notes_api.folders().expect("folders"), Vec::new());
    assert_eq!(notes_api.list().expect("list"), Vec::new());
    assert_eq!(
        notes_api.read("nothing-here".to_string()).expect("read"),
        None,
        "a successful query that matched no row is None, not an error"
    );
}

#[test]
fn the_reads_return_what_the_domain_wrote() {
    let (dir, opened) = vault("written");
    seed(&behind(&dir));
    let notes_api = opened.notes();

    let folders = notes_api.folders().expect("folders");
    assert_eq!(
        folders.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
        ["Work", "Work/Deep"],
        "parent before child, by path"
    );
    assert_eq!(folders[0].parent_path, None, "a root folder has no parent");
    assert_eq!(folders[0].icon.as_deref(), Some("folder"));
    assert_eq!(folders[1].parent_path.as_deref(), Some("Work"));
    assert_eq!(folders[1].name, "Deep");
    assert_eq!(folders[1].icon, None, "an explicit null icon reads as None");

    let listed = notes_api.list().expect("list");
    assert_eq!(
        listed.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
        ["note-work", "note-root"],
        "newest first"
    );
    assert_eq!(listed[0].folder_path.as_deref(), Some("Work"));
    assert_eq!(
        listed[1].folder_path, None,
        "the vault root is None, and is a real folder"
    );
    assert_eq!(listed[1].title, "at the root");

    let detail = notes_api
        .read("note-root".to_string())
        .expect("read")
        .expect("the note exists");
    assert_eq!(detail.summary.id, "note-root");
    assert_eq!(detail.summary.title, "at the root");
}

/// The incident `protocol::account` records, one tier down: a row that will not
/// decode must fail the list, never shrink it.
#[test]
fn a_folder_row_that_will_not_decode_fails_the_whole_list() {
    let (dir, opened) = vault("bad-folder");
    let db = behind(&dir);
    seed(&db);
    let notes_api = opened.notes();
    assert_eq!(notes_api.folders().expect("folders").len(), 2);

    // A blob where the projector writes text: what a column type confusion
    // actually looks like on disk.
    execute(
        &db,
        "UPDATE folders SET parent_path = X'DEADBEEF' WHERE path = 'Work/Deep'",
    );

    let error = notes_api
        .folders()
        .expect_err("an undecodable row fails the read");
    assert!(
        matches!(error, StorageError::Failed { .. }),
        "got {error:?}"
    );
}

#[test]
fn a_note_row_that_will_not_decode_fails_the_whole_list() {
    let (dir, opened) = vault("bad-note");
    let db = behind(&dir);
    seed(&db);
    let notes_api = opened.notes();
    assert_eq!(notes_api.list().expect("list").len(), 2);

    // Text where §A.6 requires epoch milliseconds.
    execute(
        &db,
        "UPDATE notes SET modified_at = 'yesterday' WHERE id = 'note-work'",
    );

    let error = notes_api
        .list()
        .expect_err("an undecodable row fails the read");
    assert!(
        matches!(error, StorageError::Failed { .. }),
        "got {error:?}"
    );
    // And the single-note read of the damaged row fails too, rather than
    // answering None — "unreadable" is not "deleted".
    let error = notes_api
        .read("note-work".to_string())
        .expect_err("the same row, read alone");
    assert!(matches!(error, CrdtError::Storage { .. }), "got {error:?}");
}

#[test]
fn a_deleted_note_leaves_both_the_list_and_the_read() {
    let (dir, opened) = vault("deleted");
    let db = behind(&dir);
    seed(&db);
    db.call_blocking(|conn: &mut Connection| {
        notes::delete(conn, "note-work", DEVICE, NOW + 2)?;
        Ok(())
    })
    .expect("delete");

    let notes_api = opened.notes();
    assert_eq!(
        notes_api
            .list()
            .expect("list")
            .iter()
            .map(|n| n.id.as_str())
            .collect::<Vec<_>>(),
        ["note-root"]
    );
    assert_eq!(notes_api.read("note-work".to_string()).expect("read"), None);
}

/// The distinction a `String` alone cannot carry.
#[test]
fn a_body_this_device_has_not_pulled_is_not_an_empty_note() {
    let (dir, opened) = vault("body");
    let db = behind(&dir);
    seed(&db);
    let notes_api = opened.notes();

    let before = notes_api
        .read("note-root".to_string())
        .expect("read")
        .expect("the note exists");
    assert_eq!(before.body.text, "");
    assert!(
        !before.body.present,
        "no log rows at all: the body has not been pulled here"
    );

    let update = body_update("note-root", "from a peer");
    db.call_blocking(|conn: &mut Connection| {
        update_log::append_server_update(conn, "note-root", 1, &update, NOW).map_err(|error| {
            StorageError::Failed {
                what: error.to_string(),
            }
        })
    })
    .expect("append");

    let after = notes_api
        .read("note-root".to_string())
        .expect("read")
        .expect("the note exists");
    assert_eq!(after.body.text, "from a peer");
    assert!(after.body.present);
}

#[test]
fn an_undecodable_update_throws_and_never_reads_as_empty_text() {
    let (dir, opened) = vault("undecodable");
    let db = behind(&dir);
    seed(&db);
    db.call_blocking(|conn: &mut Connection| {
        update_log::append_server_update(conn, "note-root", 1, b"not a v1 update", NOW).map_err(
            |error| StorageError::Failed {
                what: error.to_string(),
            },
        )
    })
    .expect("append");

    let error = opened
        .notes()
        .read("note-root".to_string())
        .expect_err("bytes that are not an update fail the read");
    assert!(
        matches!(error, CrdtError::Undecodable { .. }),
        "an unreadable body is Undecodable, never empty text: got {error:?}"
    );
}

/// A `Notes` is a live handle, not a snapshot: a list taken after the handle
/// was built sees rows committed since. A cached first answer would make an
/// empty vault look permanently empty.
#[test]
fn a_list_sees_rows_committed_after_the_handle_was_built() {
    let (dir, opened) = vault("same-handle");
    let notes_api = opened.notes();
    assert_eq!(notes_api.list().expect("list"), Vec::new());

    seed(&behind(&dir));

    assert_eq!(notes_api.list().expect("list").len(), 2);
}
