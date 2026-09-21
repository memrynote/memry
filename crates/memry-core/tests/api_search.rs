//! The exported search surface: `Vault::search`, its reindex, and the rule
//! that a stale index never surfaces a deleted note.
//!
//! Real SQLite, real FTS5, no transport.
//!
//! | Test                                          | Rule                            |
//! | --------------------------------------------- | ------------------------------- |
//! | a body word is found, not only a title        | why this exists at all          |
//! | an empty query returns nothing                | not a request for the vault     |
//! | a note deleted after indexing never surfaces  | the index may be stale, not the answer |
//! | a reindex is idempotent                       | safe on any schedule            |

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::api::vault::Vault;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use yrs::{ReadTxn as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn vault(label: &str) -> (Db, Vault) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-api-search-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let opened = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (
        open_data(&dir.join("data.db")).expect("second open"),
        opened,
    )
}

/// Writes a note, and its body into the note's **document** when there is one.
///
/// The body goes through the update log rather than the create record's
/// `content`, because that is where the indexer reads it from: the Y.Doc is
/// authoritative for a body and §12.2 calls create-time `content` best-effort
/// in its own words. A test that seeded `content` would pass against an
/// indexer that never read a body at all.
fn write_note(db: &Db, id: &str, title: &str, body: &str) {
    db.call_blocking(|conn: &mut Connection| {
        let note = NewNote {
            id,
            title,
            folder_path: None,
            content: "",
            tags: &[],
            properties: None,
        };
        notes::create(conn, &note, DEVICE, NOW)?;
        if !body.is_empty() {
            update_log::append_server_update(conn, id, 1, &body_update(id, body), NOW)
                .expect("the body update");
        }
        Ok(())
    })
    .expect("the write");
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
    captured
        .lock()
        .expect("lock")
        .first()
        .cloned()
        .expect("one update")
}

#[test]
fn a_body_word_is_found_not_only_a_title() {
    // The whole reason this crossed the FFI: the browse screen filters the
    // list it holds, which matches titles, so a vault whose word is in the
    // body reads as "no results".
    let (db, vault) = vault("body");
    write_note(&db, "n1", "Groceries", "buy cardamom and saffron");
    write_note(&db, "n2", "Cardamom", "");
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");

    let hits = search
        .notes("cardamom".to_string(), 10)
        .expect("the search");

    let ids: Vec<&str> = hits.iter().map(|hit| hit.id.as_str()).collect();
    assert!(ids.contains(&"n1"), "the body match is missing: {ids:?}");
    assert!(ids.contains(&"n2"));
    assert!(hits.iter().all(|hit| hit.kind == "note"));
}

#[test]
fn an_empty_query_returns_nothing() {
    // An empty search box is not a request for the whole vault.
    let (db, vault) = vault("empty");
    write_note(&db, "n1", "Groceries", "buy cardamom");
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");

    assert!(
        search
            .notes(String::new(), 10)
            .expect("the search")
            .is_empty()
    );
    assert!(
        search
            .notes("   ".to_string(), 10)
            .expect("the search")
            .is_empty()
    );
    assert!(
        search
            .notes("!!".to_string(), 10)
            .expect("the search")
            .is_empty()
    );
}

#[test]
fn a_note_deleted_after_indexing_never_surfaces() {
    // The index is a cache and is allowed to lag. The answer is not: a hit
    // that opens nothing is worse than a shorter list.
    let (db, vault) = vault("deleted");
    write_note(&db, "n1", "Cardamom", "");
    let search = vault.search().expect("the index");
    search.reindex().expect("the reindex");
    assert_eq!(
        search
            .notes("cardamom".to_string(), 10)
            .expect("before")
            .len(),
        1
    );

    db.call_blocking(|conn: &mut Connection| {
        notes::delete(conn, "n1", DEVICE, NOW)?;
        Ok(())
    })
    .expect("the delete");

    // Deliberately **no** reindex between the delete and the search.
    assert!(
        search
            .notes("cardamom".to_string(), 10)
            .expect("after")
            .is_empty(),
        "a tombstoned note must not surface from a stale index"
    );
}

#[test]
fn a_reindex_is_idempotent() {
    // It is safe on any schedule, which is what lets a screen call it on
    // appear without knowing what else already did.
    let (db, vault) = vault("idempotent");
    write_note(&db, "n1", "Cardamom", "");
    let search = vault.search().expect("the index");

    let first = search.reindex().expect("first");
    let second = search.reindex().expect("second");

    assert!(first.full, "an empty index is a full build");
    assert!(
        !second.full,
        "the second pass tops up rather than rebuilding"
    );
    assert_eq!(first.notes_indexed, 1);
    // The watermark is inclusive, so the boundary row is re-indexed rather
    // than skipped — re-writing a row to the value it already holds is the
    // safe side of that trade, and duplicate rows are what matter.
    assert_eq!(
        search
            .notes("cardamom".to_string(), 10)
            .expect("the search")
            .len(),
        1,
        "a second pass must not double the note"
    );
}
