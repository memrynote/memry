//! A body edit, made durable and queued for the other devices.
//!
//! [`crate::crdt::body_edit`] changes the document; this is the half that makes
//! the change survive and travel.
//!
//! **The update row and the outbox row commit together or not at all**
//! (FR-030, data-model §A.2). An update row on its own is an edit that is
//! durable on this device and that no peer is ever sent — the note then reads
//! correctly here and is missing a paragraph everywhere else, with nothing to
//! detect it.
//!
//! **The document is rebuilt from the log for every edit.** It is the same
//! document [`crate::domain::reads::body`] reads, opened under this device's
//! id so the update is authored by it rather than by the reader identity. A
//! cached document would be faster and would also be a second writer to keep in
//! step with the log; that is a cache with a correctness problem, and this path
//! is a local SQLite read plus a `yrs` apply.
//!
//! **The update is what the transaction authored** (chapter 12 §12.5.1), taken
//! from the registry's sink rather than recovered by diffing two copies of the
//! document.

use std::sync::{Arc, Mutex, PoisonError};

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::crdt::body_edit::{self, BlockEdit};
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::UpdateSink;
use crate::crdt::{DocumentRegistry, update_log};
use crate::domain::notes::ITEM_TYPE;
use crate::domain::reads;
use crate::sync::outbox;

/// Applies one block edit to a note's body.
///
/// - Returns: `Ok(false)` when this vault holds no live note by that id, which
///   is an answer and not a failure — the same `nil`-versus-error distinction
///   the read surface draws. A block the body does not hold **is** an error:
///   the note is here, and the edit did not land.
pub fn edit_block(
    conn: &Connection,
    note_id: &str,
    edit: &BlockEdit,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, CrdtError> {
    if !reads::note_exists(conn, note_id) {
        return Ok(false);
    }

    let Some(update) = author(conn, note_id, edit, device_id)? else {
        // A write that authored nothing: setting an attribute to the value it
        // already holds. Nothing is stored and nothing is pushed — an edit
        // that changed nothing must not ship a clock and win a conflict it had
        // no business winning.
        return Ok(true);
    };

    let tx = conn.unchecked_transaction().map_err(storage_failed)?;
    append_in(&tx, ITEM_TYPE, note_id, &update, now_ms)?;
    tx.commit().map_err(storage_failed)?;
    Ok(true)
}

/// Replays `doc_id`'s durable log into a document opened under `device_id`
/// and applies `edit` to it, **without writing anything**.
///
/// - Returns: the update the edit authored, or `None` when it authored nothing.
///   A refused edit (a block the body does not hold) is an error, and nothing
///   has been written either way.
pub(crate) fn author(
    conn: &Connection,
    doc_id: &str,
    edit: &BlockEdit,
    device_id: &str,
) -> Result<Option<Vec<u8>>, CrdtError> {
    let authored: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let sink: UpdateSink = {
        let authored = Arc::clone(&authored);
        Arc::new(move |_, bytes: &[u8]| {
            authored
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(bytes.to_vec())
        })
    };
    let document = DocumentRegistry::new(device_id, sink).get_or_open(doc_id)?;
    for blob in update_log::load_plan(conn, doc_id)?.blobs() {
        // Durable, so the replay does not reach the sink and this edit's
        // update is the only thing in it.
        document.apply_durable_update(blob)?;
    }

    body_edit::apply(&document, edit)?;

    let mut updates = authored.lock().unwrap_or_else(PoisonError::into_inner);
    Ok((!updates.is_empty()).then(|| updates.swap_remove(0)))
}

/// Stores an authored update and queues it as `(item_type, doc_id)`, inside
/// the caller's transaction: the update row and its outbox row commit together
/// or not at all (FR-030, data-model §A.2).
pub(crate) fn append_in(
    tx: &Connection,
    item_type: &str,
    doc_id: &str,
    update: &[u8],
    now_ms: i64,
) -> Result<(), CrdtError> {
    update_log::append_local_update_in(tx, doc_id, update, now_ms)?;
    let change = outbox::Change::crdt_update(item_type, doc_id, update.to_vec());
    outbox::enqueue(tx, &change, now_ms)?;
    Ok(())
}

fn storage_failed(error: rusqlite::Error) -> CrdtError {
    CrdtError::from(StorageError::Failed {
        what: error.to_string(),
    })
}
