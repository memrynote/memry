//! The two doors a local body edit goes through (T125's core half).
//!
//! Real `yrs`, real SQLite, no transport at all — nothing here touches the
//! network, because a local edit does not.
//!
//! | Test                                       | Rule                          |
//! | ------------------------------------------ | ----------------------------- |
//! | a write reaches the sink exactly once      | chapter 07, the local log     |
//! | a replay does not                          | chapter 07 §7.4, ORIGIN_DURABLE |
//! | an update row alone is refused             | FR-030, data-model §A.2       |
//! | the update row and the outbox row are one  | FR-030, §C.4                  |

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use memry_core::api::errors::StorageError;
use memry_core::crdt::registry::UpdateSink;
use memry_core::crdt::update_log::{self, Namespace};
use memry_core::crdt::{DocumentRegistry, extract_text};
use memry_core::storage::{Db, open_data};
use memry_core::sync::outbox;
use yrs::{ReadTxn as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim};

static SCRATCH: AtomicU64 = AtomicU64::new(0);

const NOTE: &str = "abc123def456";

fn scratch_db(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir: PathBuf = std::env::temp_dir().join(format!(
        "memry-local-edit-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn storage_failure(error: impl std::fmt::Display) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// `Document::write` is the door a local edit is authored through: one
/// transaction in, one update out, and the bytes arrive at the registry's sink
/// rather than being recovered by diffing a second copy of the document
/// (chapter 12 §12.5.1).
#[test]
fn a_write_reaches_the_sink_exactly_once_and_a_replay_never_does() {
    let authored: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| {
            authored.lock().expect("lock").push(bytes.to_vec());
        })
    };
    let registry = DocumentRegistry::new("device-a", sink);
    let document = registry.get_or_open(NOTE).expect("open");

    document
        .write(|txn| {
            let fragment = txn
                .get_xml_fragment("prosemirror")
                .expect("the root is typed at open");
            let group = fragment.push_back(txn, XmlElementPrelim::empty("blockGroup"));
            let container = group.push_back(txn, XmlElementPrelim::empty("blockContainer"));
            let paragraph = container.push_back(txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(txn, XmlTextPrelim::new("from cli"));
        })
        .expect("a write transaction");

    let updates = authored.lock().expect("lock").clone();
    assert_eq!(updates.len(), 1, "one transaction, one update");
    assert_eq!(extract_text(&document).expect("extract"), "from cli");

    // The same bytes coming back out of the durable log must not be reported
    // as a second local edit: that is what would re-push the whole document on
    // every launch.
    let replayed = DocumentRegistry::new("device-a", {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| {
            authored.lock().expect("lock").push(bytes.to_vec());
        })
    });
    let peer = replayed.get_or_open(NOTE).expect("open");
    peer.apply_durable_update(&updates[0]).expect("applies");
    assert_eq!(authored.lock().expect("lock").len(), 1);
    assert_eq!(extract_text(&peer).expect("extract"), "from cli");
}

/// An update row written on its own is an edit that is durable locally and
/// that no peer is ever sent. The refusal is structural, not remembered.
#[test]
fn a_local_update_row_outside_a_transaction_is_refused() {
    let db = scratch_db("autocommit");
    let refused = db.call_blocking(|conn| {
        Ok(update_log::append_local_update_in(
            conn,
            NOTE,
            &[1u8, 2, 3],
            1_700_000_000_000,
        ))
    });
    let message = format!("{:?}", refused.expect("the call returns"));
    assert!(message.contains("same transaction"), "{message}");

    let rows: i64 = db
        .call_blocking(|conn| {
            conn.query_row("SELECT COUNT(*) FROM yjs_updates", [], |row| row.get(0))
                .map_err(storage_failure)
        })
        .expect("count");
    assert_eq!(rows, 0, "a refused append writes nothing");
}

/// FR-030: the update row and its outbox row commit together or not at all.
#[test]
fn the_update_row_and_its_outbox_row_commit_in_one_transaction() {
    let db = scratch_db("commit");
    let update = vec![9u8, 8, 7];
    let change = outbox::Change::crdt_update("note", NOTE, update.clone());
    let blob = update.clone();

    let durable = db
        .call_blocking(move |conn| {
            outbox::commit(conn, &change, 1_700_000_000_000, |tx| {
                update_log::append_local_update_in(tx, NOTE, &blob, 1_700_000_000_000)
                    .map_err(storage_failure)
            })
        })
        .expect("commits");
    assert_eq!(durable.acknowledge(), 1, "the first local sequence");

    let stored = db
        .call_blocking(|conn| {
            update_log::updates_after(conn, Namespace::Local, NOTE, 0).map_err(storage_failure)
        })
        .expect("read back");
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].update_blob, update);

    let queued: (String, Option<Vec<u8>>) = db
        .call_blocking(|conn| {
            conn.query_row("SELECT op, payload FROM outbox", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(storage_failure)
        })
        .expect("the outbox row");
    assert_eq!(queued.0, outbox::OP_CRDT_UPDATE);
    // The bytes are the change: there is no live row to rebuild a CRDT update
    // from, so losing the payload loses the edit.
    assert_eq!(queued.1, Some(update));
}
