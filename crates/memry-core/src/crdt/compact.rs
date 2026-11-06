//! Local compaction (desktop Step 14i, #3531): a document's local namespace
//! folded into one snapshot, so a body typed into for hours stops costing a
//! replay of every keystroke at each load.
//!
//! **The snapshot is the document's own state, never a copy of it.** Electron's
//! `compactYDoc` (`packages/sync-client/src/crdt-compact-utils.ts:6`) copies each
//! root's content into a fresh document. A copy is new items under a new client
//! id: merged with the log it came from (y-leveldb's `flushDocument` merges the
//! stored updates with it) every block comes back twice, and a peer's edit made
//! against the old items lands in content nobody shows (chapter 12 §12.5.0.1).
//! It also has to refuse a root it cannot type (§12.5.3). Here the snapshot is
//! the full-state encode of the log's replay (§12.5.1): the same items, every
//! root included whatever its type, so the fold changes how the log stores the
//! body and not the body.
//!
//! **The snapshot holds every row the fold deletes.** [`fold_compacted`] reads
//! the log, builds the snapshot and folds at the highest local sequence in one
//! transaction on the writer, so a row committed before it is inside the
//! snapshot and one committed after it is above the fold point. The outbox is
//! never read or written: a pending row keeps its own bytes and is sent as it
//! was queued.
//!
//! [`compact_doc`] answers `None`, and nothing is written, when the namespace
//! has no update to fold, when the replay holds updates waiting on one it lacks
//! (the encode would not carry them), or when the snapshot would not be smaller
//! than the rows it replaces.

use std::sync::Arc;

use rusqlite::{Connection, TransactionBehavior};

use crate::api::errors::StorageError;

use super::errors::CrdtError;
use super::registry::{DocumentRegistry, UpdateSink};
use super::update_log::{self, LoadPlan};

/// The replay's client id. It authors nothing: the replay is only encoded.
const READER_DEVICE_ID: &str = "memry-core-compaction";

/// A local namespace compacted to one snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Compacted {
    /// The whole document as one v1 update.
    pub state: Vec<u8>,
    /// The local rows' bytes the snapshot replaces, less its own.
    pub saved_bytes: usize,
}

/// A fold [`fold_compacted`] committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Folded {
    /// The highest local sequence the snapshot holds.
    pub fold_at: i64,
    pub saved_bytes: usize,
}

/// `plan`'s local namespace (its snapshot and updates) compacted to the
/// full-state encode of the whole plan's replay. `None` when there is no local
/// update, when the replay waits on an update it lacks, or when the encode is
/// not smaller than the local rows.
pub fn compact_doc(doc_id: &str, plan: &LoadPlan) -> Result<Option<Compacted>, CrdtError> {
    if plan.local_updates.is_empty() {
        return Ok(None);
    }
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new(READER_DEVICE_ID, sink).get_or_open(doc_id)?;
    for blob in plan.blobs() {
        document.apply_durable_update(blob)?;
    }
    if document.has_missing_updates()? {
        return Ok(None);
    }
    let state = document.encode_state()?;
    let replaced = plan
        .local_snapshot
        .iter()
        .map(|row| row.snapshot.len())
        .chain(plan.local_updates.iter().map(|row| row.update_blob.len()))
        .sum::<usize>();
    Ok(replaced
        .checked_sub(state.len())
        .filter(|saved| *saved > 0)
        .map(|saved_bytes| Compacted { state, saved_bytes }))
}

/// Folds `doc_id`'s local namespace into the snapshot [`compact_doc`] builds, in
/// one immediate transaction. `None`: nothing was written.
///
/// The snapshot is stamped with the newest stamp it replaces, not the fold's
/// time: the body did not change, so the readers that compare stamps (the
/// write-back's `behind_bodies`, search's watermark, delete-keep's last local
/// edit) see what they saw before.
pub fn fold_compacted(conn: &mut Connection, doc_id: &str) -> Result<Option<Folded>, CrdtError> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(failed)?;
    let plan = update_log::load_plan(&tx, doc_id)?;
    let Some(compacted) = compact_doc(doc_id, &plan)? else {
        return Ok(None);
    };
    let stamp = plan
        .local_snapshot
        .iter()
        .map(|row| row.compacted_at)
        .chain(plan.local_updates.iter().map(|row| row.created_at))
        .max()
        .unwrap_or_default();
    let fold_at = update_log::fold_local_in(&tx, doc_id, &compacted.state, stamp)?;
    tx.commit().map_err(failed)?;
    Ok(Some(Folded {
        fold_at,
        saved_bytes: compacted.saved_bytes,
    }))
}

fn failed(error: rusqlite::Error) -> CrdtError {
    StorageError::Failed {
        what: format!("could not fold a compacted body: {error}"),
    }
    .into()
}
