//! `Search::reindex` lets go of the vault's `data.db` between batches (#5842).
//!
//! A full rebuild of a 17k-note vault held the shared `data.db` mutex for
//! 160 s, so the sync pass started beside it at app open, and every write,
//! waited for the whole rebuild. These tests use the real `Vault`, its one
//! shared `Db`, and a real `index.db`. They count rows instead of timing calls.
//!
//! | Test                                                | Rule                              |
//! | --------------------------------------------------- | --------------------------------- |
//! | a database call during a reindex runs before it ends | sync and writes interleave        |
//! | a note edited during a reindex is indexed with its new text | no stale row after the pass |

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use memry_core::api::vault::Vault;
use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::epoch::HeldBody;
use memry_core::crdt::registry::UpdateSink;
use memry_core::domain::notes::{self, NewNote};
use memry_core::domain::search::REINDEX_BATCH;
use rusqlite::Connection;
use yrs::{ReadTxn as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

const NOW: i64 = 1_760_000_000_000;
const DEVICE: &str = "device-a";
/// Enough notes for several batches.
const NOTES: usize = 3 * REINDEX_BATCH + 1;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn vault(label: &str) -> (PathBuf, Vault) {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-reindex-batches-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    let opened = Vault::open("vault-1".to_string(), dir.display().to_string()).expect("open");
    (dir, opened)
}

fn note_id(i: usize) -> String {
    format!("n{i:04}")
}

fn seed(vault: &Vault) {
    vault
        .db_handle()
        .call_blocking(|conn: &mut Connection| {
            for i in 0..NOTES {
                let id = note_id(i);
                let note = NewNote {
                    id: &id,
                    title: &format!("Note {i}"),
                    folder_path: None,
                    content: "",
                    tags: &[],
                    properties: None,
                    emoji: None,
                };
                notes::create(conn, &note, DEVICE, NOW)?;
                append_body(conn, &id, 1, "cardamom", NOW);
            }
            Ok(())
        })
        .expect("the seed");
}

fn append_body(conn: &Connection, id: &str, sequence: i64, text: &str, at: i64) {
    HeldBody::never_purged(conn, id)
        .and_then(|held| held.append_server_update(sequence, &body_update(id, text), at))
        .expect("the body update");
}

/// A real lib0 v1 update carrying `text` in the body fragment, from a peer
/// named for the update so a second one is not a duplicate of the first.
fn body_update(doc_id: &str, text: &str) -> Vec<u8> {
    let captured: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_, bytes: &[u8]| captured.lock().expect("lock").push(bytes.to_vec()))
    };
    let document = DocumentRegistry::new(&format!("peer-{text}"), sink)
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

/// The `fts_notes` rows `index.db` has committed, read on a connection of
/// its own, so a batch the reindex has not committed is not counted.
fn committed_rows(dir: &Path, id: Option<&str>) -> usize {
    let index = Connection::open(dir.join("index.db")).expect("index.db");
    let count: i64 = match id {
        None => index.query_row("SELECT count(*) FROM fts_notes", [], |row| row.get(0)),
        Some(id) => index.query_row(
            "SELECT count(*) FROM fts_notes WHERE id = ?1",
            [id],
            |row| row.get(0),
        ),
    }
    .expect("count");
    count as usize
}

/// Runs a reindex on its own thread and keeps calling the vault's shared `Db`
/// the way a sync pass does, until one call finds a partly committed index
/// (the call ran between two batches) or the reindex ends. `during` runs
/// inside that call, holding the `data.db` lock. Answers whether it ran mid-pass.
fn reindex_while_calling(
    dir: &Path,
    vault: &Vault,
    during: impl Fn(&Connection),
) -> (bool, memry_core::api::search::ReindexSummary) {
    let search = vault.search(None).expect("the index");
    let finished = Arc::new(AtomicBool::new(false));
    let indexer = {
        let finished = Arc::clone(&finished);
        std::thread::spawn(move || {
            let summary = search.reindex();
            finished.store(true, Ordering::SeqCst);
            summary
        })
    };
    let data = vault.db_handle();
    let mut mid_pass = false;
    while !mid_pass && !finished.load(Ordering::SeqCst) {
        mid_pass = data
            .call_blocking(|conn: &mut Connection| {
                let committed = committed_rows(dir, None);
                let between = committed > 0 && committed < NOTES;
                if between {
                    during(conn);
                }
                Ok(between)
            })
            .expect("a sync-like call");
    }
    let summary = indexer.join().expect("join").expect("the reindex");
    (mid_pass, summary)
}

#[test]
fn a_database_call_during_a_reindex_runs_before_the_reindex_ends() {
    let (dir, vault) = vault("interleave");
    seed(&vault);

    let (mid_pass, summary) = reindex_while_calling(&dir, &vault, |_| {});

    assert!(
        mid_pass,
        "every data.db call waited for the whole reindex: it never let go between batches"
    );
    assert!(summary.full);
    assert_eq!(summary.notes_indexed as usize, NOTES);
    assert_eq!(committed_rows(&dir, None), NOTES, "every note once");
}

#[test]
fn a_note_edited_during_a_reindex_is_indexed_with_its_new_text() {
    let (dir, vault) = vault("edit");
    seed(&vault);
    // The first note is in the first batch, so the reindex has already
    // indexed it when the edit lands.
    let edited = note_id(0);

    let (mid_pass, _) = reindex_while_calling(&dir, &vault, |conn| {
        append_body(conn, &edited, 2, "saffron", NOW + 1);
    });
    if !mid_pass {
        // The reindex never let go: the edit lands after it, as it did.
        let data = vault.db_handle();
        data.call_blocking(|conn: &mut Connection| {
            append_body(conn, &edited, 2, "saffron", NOW + 1);
            Ok(())
        })
        .expect("the edit");
    }

    let search = vault.search(None).expect("the index");
    let hits = search
        .search("saffron".to_string(), None, 10)
        .expect("search");
    let ids: Vec<&str> = hits.notes.iter().map(|hit| hit.id.as_str()).collect();
    assert_eq!(ids, [edited.as_str()], "the edit is in the index");
    assert_eq!(committed_rows(&dir, Some(&edited)), 1, "one row per note");
    assert_eq!(committed_rows(&dir, None), NOTES);
}
