//! Chapter 06 §6.5.2 P3: **a concurrent merge re-queues the merged row.**
//!
//! A merge stores `merge(local, remote)`, a clock no server row carries. Until
//! that row is pushed, the merging device is the only one holding it: with
//! task `t` at `{a:1}`, A retitles it (`{a:2}`, pushed) and B changes its due
//! date (`{a:1,b:1}`, pushed over A's). A pulls B's row, keeps both edits under
//! `{a:2,b:1}` and, without a requeue, never pushes them: B and the server keep
//! the old title until someone edits `t` again. Electron re-queues one level up
//! (`apps/desktop/src/main/sync/engine/conflict-report.ts:12-36`); here every
//! merge branch calls [`requeue`] inside the transaction that stores the merge,
//! so the merged row and its outbox row commit together or not at all.
//!
//! **The requeue is the row's key, not its bytes** (§6.5.2 P2): the push
//! rebuilds the payload from the live row, so the union clock goes out as
//! stored, **never ticked again**. That is what keeps two devices that merged
//! the same pair from ping-ponging: the first union push is accepted, the
//! second is a replay of an identical clock and is retired, and the pull that
//! follows sees an equal clock, which is not a merge (P4).
//!
//! A requeue is not a local edit, so it queues no calendar provider push
//! ([`crate::sync::outbox::enqueue_merged`]).

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::domain::tasks::Inbound;
use crate::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use crate::sync::outbox;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// Queues the merged `(item_type, item_id)` for push, inside the transaction
/// that stored the merge.
pub(crate) fn requeue(
    tx: &Connection,
    item_type: &str,
    item_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    outbox::enqueue_merged(tx, item_type, item_id, now_ms).map(drop)
}

/// Stores a concurrent branch's merged `record` and re-queues it, in one
/// transaction. A payload the wholesale path records corrupt is not queued.
pub(crate) fn store_merged(
    conn: &Connection,
    record: &InboundRecord,
    now_ms: i64,
) -> Result<Inbound, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let outcome = sync_items::apply_remote_in(&tx, record, now_ms)?;
    if outcome == ApplyOutcome::Applied {
        requeue(&tx, &record.item_type, &record.item_id, now_ms)?;
    }
    tx.commit().map_err(failed)?;
    Ok(match outcome {
        ApplyOutcome::Applied => Inbound::Merged {
            conflicted_fields: Vec::new(),
        },
        other => crate::domain::task_merge::inbound(other),
    })
}

#[cfg(test)]
mod tests;
