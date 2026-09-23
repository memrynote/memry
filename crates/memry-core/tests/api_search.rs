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

use memry_core::api::search::BacklinkOrder;
use memry_core::api::vault::Vault;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::{DocumentRegistry, update_log};
use memry_core::domain::notes::{self, NewNote};
use memry_core::storage::{Db, open_data};
use rusqlite::Connection;
use yrs::{ReadTxn as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

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

// MARK: - Backlinks (N800)

/// A body update carrying one wiki link to `target`.
///
/// The link is a mark with a target, which is how `extract_blocks` reports one
/// and what the projection reads.
fn link_update(doc_id: &str, text: &str, target: &str) -> Vec<u8> {
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
            let link = paragraph.push_back(txn, XmlElementPrelim::empty("wikiLink"));
            link.insert_attribute(txn, "target", target);
            link.push_back(txn, XmlTextPrelim::new(text));
        })
        .expect("a write transaction");
    captured
        .lock()
        .expect("lock")
        .first()
        .cloned()
        .expect("one update")
}

fn write_linking_note(db: &Db, id: &str, title: &str, target: &str) {
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
        update_log::append_server_update(conn, id, 1, &link_update(id, target, target), NOW)
            .expect("the body update");
        Ok(())
    })
    .expect("the write");
}

/// **The projection is what makes this answerable at all.**
///
/// `note_links` existed in the index schema and nothing wrote a row into it,
/// so this query would have returned an empty list forever and read as "no
/// note links here" rather than "nothing populates the table".
#[test]
fn a_note_knows_which_notes_link_to_it() {
    let (db, vault) = vault("backlinks");
    write_note(&db, "target", "Cardamom", "the spice itself");
    write_linking_note(&db, "source", "Groceries", "Cardamom");

    let search = vault.search().expect("search");
    search.reindex().expect("the reindex");

    let found = search
        .backlinks("target".to_string(), BacklinkOrder::Recent)
        .expect("backlinks");

    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].source_id, "source");
    assert_eq!(found[0].source_title, "Groceries");
    assert_eq!(found[0].target_title, "Cardamom");
}

/// A link written before its target exists still counts once the target is
/// created, which is what the nullable `target_id` is for.
#[test]
fn a_link_written_before_its_target_existed_still_counts() {
    let (db, vault) = vault("backlinks-forward");
    write_linking_note(&db, "source", "Groceries", "Cardamom");

    let search = vault.search().expect("search");
    search.reindex().expect("the reindex");

    // The note the link names does not exist yet.
    write_note(&db, "target", "Cardamom", "the spice itself");
    search.reindex().expect("the second reindex");

    let found = search
        .backlinks("target".to_string(), BacklinkOrder::Recent)
        .expect("backlinks");
    assert_eq!(
        found.len(),
        1,
        "the forward reference must resolve: {found:?}"
    );
}

/// A note that stopped linking somewhere really stops: the projection deletes
/// the source's rows before inserting, so an edit that removed a link does not
/// leave a backlink behind.
///
/// **Authored as a real deletion rather than a second insert.** Yjs updates
/// are additive, so appending another body update leaves the original link in
/// the document and the backlink correctly survives — the first version of
/// this test appended one and was wrong about Yjs, not about the projection.
#[test]
fn removing_a_link_removes_the_backlink() {
    let (db, vault) = vault("backlinks-removed");
    write_note(&db, "target", "Cardamom", "the spice itself");
    let link = link_update("source", "Cardamom", "Cardamom");
    db.call_blocking(|conn: &mut Connection| {
        let note = NewNote {
            id: "source",
            title: "Groceries",
            folder_path: None,
            content: "",
            tags: &[],
            properties: None,
        };
        notes::create(conn, &note, DEVICE, NOW)?;
        update_log::append_server_update(conn, "source", 1, &link, NOW).expect("the body");
        Ok(())
    })
    .expect("the write");

    let search = vault.search().expect("search");
    search.reindex().expect("the reindex");
    assert_eq!(
        search
            .backlinks("target".to_string(), BacklinkOrder::Recent)
            .expect("backlinks")
            .len(),
        1
    );

    // The user deletes the paragraph the link was in.
    let removal = removal_update("source", &[link]);
    db.call_blocking(|conn: &mut Connection| {
        update_log::append_server_update(conn, "source", 2, &removal, NOW).expect("the removal");
        Ok(())
    })
    .expect("the write");
    search.reindex().expect("the second reindex");

    assert!(
        search
            .backlinks("target".to_string(), BacklinkOrder::Recent)
            .expect("backlinks")
            .is_empty(),
        "a link the source no longer makes must not survive"
    );
}

/// The three orders desktop offers, each asserted rather than assumed.
#[test]
fn the_three_sort_orders_each_order_differently() {
    let (db, vault) = vault("backlinks-order");
    write_note(&db, "target", "Cardamom", "the spice");
    write_linking_note(&db, "older", "Zebra", "Cardamom");
    write_linking_note(&db, "newer", "Apple", "Cardamom");
    // `newer` really is newer, so "recent" has something to order by.
    db.call_blocking(|conn: &mut Connection| {
        conn.execute(
            "UPDATE notes SET modified_at = ?2 WHERE id = ?1",
            rusqlite::params!["newer", NOW + 5_000],
        )
        .expect("the stamp");
        conn.execute(
            "UPDATE notes SET modified_at = ?2 WHERE id = ?1",
            rusqlite::params!["older", NOW - 5_000],
        )
        .expect("the stamp");
        Ok(())
    })
    .expect("the stamps");

    let search = vault.search().expect("search");
    search.reindex().expect("the reindex");

    let ids = |order| {
        search
            .backlinks("target".to_string(), order)
            .expect("backlinks")
            .into_iter()
            .map(|backlink| backlink.source_id)
            .collect::<Vec<_>>()
    };

    assert_eq!(ids(BacklinkOrder::Recent), ["newer", "older"]);
    assert_eq!(ids(BacklinkOrder::Oldest), ["older", "newer"]);
    // By the linking note's title: Apple before Zebra.
    assert_eq!(ids(BacklinkOrder::Title), ["newer", "older"]);
}

/// A note linking to itself is not a backlink, and a note that is not here
/// has an empty list rather than an error.
#[test]
fn a_self_link_is_not_a_backlink_and_a_missing_note_is_empty() {
    let (db, vault) = vault("backlinks-self");
    write_linking_note(&db, "self", "Cardamom", "Cardamom");

    let search = vault.search().expect("search");
    search.reindex().expect("the reindex");

    assert!(
        search
            .backlinks("self".to_string(), BacklinkOrder::Recent)
            .expect("backlinks")
            .is_empty(),
        "a note linking to itself is not a backlink"
    );
    assert!(
        search
            .backlinks("no-such-note".to_string(), BacklinkOrder::Recent)
            .expect("backlinks")
            .is_empty()
    );
}

/// An update that empties the body fragment, given everything already in it.
///
/// A real deletion, which is the only way to take content out of a Yjs
/// document: appending another update adds to it.
fn removal_update(doc_id: &str, prior: &[Vec<u8>]) -> Vec<u8> {
    let captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new("device-peer", sink)
        .get_or_open(doc_id)
        .expect("open");
    for blob in prior {
        document.apply_durable_update(blob).expect("prior");
    }
    captured.lock().expect("lock").clear();
    document
        .write(|txn| {
            let fragment = txn
                .get_xml_fragment("prosemirror")
                .expect("the root is typed at open");
            let length = fragment.len(txn);
            fragment.remove_range(txn, 0, length);
        })
        .expect("a write transaction");
    captured
        .lock()
        .expect("lock")
        .first()
        .cloned()
        .expect("one update")
}
