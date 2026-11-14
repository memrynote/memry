//! The delete half of [`super::apply_page`]: a typed tombstone, the clock
//! weighing #2409 adds to it, and §5.12.1's untyped delete.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::update_log;
use crate::domain::journal;
use crate::storage::repositories::{projectors, sync_items};
use crate::sync::clock::{ClockOrder, VectorClock, compare};
use crate::sync::{body_debt, delete_keep, journal_day_merge, store};

use super::{ApplyTotals, DOCUMENT_TYPES, sqlite_failed};

/// One typed delete, as §7.15's first two consequences require it: the record
/// row, **its projection**, and the document's body log, in one transaction.
///
/// Three statements and one rule each.
///
/// - [`store::mark_deleted`] is the record tier, and it keeps the stored
///   payload byte for byte (§5.12: the body is never decoded).
/// - [`projectors::delete`] is the half that was missing, and the one with
///   teeth. Nothing else writes `notes.deleted_at`, and until it did, a note
///   deleted on another device stayed live in every projection-driven read on
///   this one — and, worse, stayed inside
///   [`crate::sync::first_sync_store::recent_document_ids`]'s `deleted_at IS NULL`
///   window, so the next first sync handed a tombstoned id to
///   [`crate::sync::body_pull::pull_document`] and re-applied the surviving server
///   log over a deleted note's body.
/// - [`update_log::purge_in`] is §7.15's first consequence, for a document
///   type only.
///
/// **One transaction, not three.** A crash between the record delete and the
/// purge would leave a deleted note with a live body, which is precisely the
/// state §7.15 forbids; a failure in any statement rolls the delete back whole
/// and propagates, so the page aborts with the cursor unmoved and the delete
/// arrives again. A purge that quietly did nothing would be worse than one
/// that errors: the caller would believe the body was gone.
///
/// **A clocked delete is recorded, then weighed** (#2409). Its clock is kept
/// for a later re-create of the id ([`store::record_tombstone_clock`]), and a
/// live local row whose clock happens strictly after it keeps the item: the
/// §5.8 client rule, and what stops this device's own late tombstone from
/// deleting the re-create that followed it. A tombstone with no clock applies
/// unconditionally, as it always has.
#[allow(clippy::too_many_arguments)]
pub(super) fn apply_tombstone(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    deleted_at: i64,
    server_cursor: Option<i64>,
    clock: Option<&VectorClock>,
    body_state_vector: Option<&str>,
    now_ms: i64,
    clock_device: Option<&str>,
    totals: &mut ApplyTotals,
) -> Result<(), StorageError> {
    let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
    if let Some(clock) = clock.filter(|clock| !clock.is_empty()) {
        store::record_tombstone_clock(&txn, item_type, item_id, clock, now_ms)?;
        if live_clock_is_after(&txn, item_type, item_id, clock)? {
            txn.commit().map_err(sqlite_failed)?;
            totals.skipped += 1;
            return Ok(());
        }
    }
    delete_keep::keep(
        &txn,
        item_type,
        item_id,
        deleted_at,
        clock,
        body_state_vector,
        clock_device,
        now_ms,
    )?;
    store::mark_deleted(&txn, item_type, item_id, deleted_at, server_cursor, now_ms)?;
    if item_type == journal::ITEM_TYPE {
        journal_day_merge::mark_deleted(&txn, item_id)?;
        // A live foreign row keeps its row and body for the drain (#2984).
        if journal_day_merge::hold_for_merge(&txn, item_id, clock)? {
            txn.commit().map_err(sqlite_failed)?;
            totals.deleted += 1;
            return Ok(());
        }
    }
    projectors::delete(&txn, item_type, item_id, deleted_at)?;
    let purged = if DOCUMENT_TYPES.contains(&item_type) {
        // The body debt goes with the body: a pull owed before the delete
        // would bring the server's surviving log back (#2297).
        body_debt::settle(&txn, item_id)?;
        update_log::purge_in(&txn, item_id).map_err(crdt_failed)?
    } else {
        0
    };
    txn.commit().map_err(sqlite_failed)?;
    totals.deleted += 1;
    if purged > 0 {
        totals.purged_documents.push(item_id.to_owned());
    }
    Ok(())
}

/// Whether the live local row's clock happens strictly after `tombstone`.
///
/// A row that is already deleted, has no clock, or whose clock will not parse
/// is not after anything, so the delete applies exactly as before #2409.
fn live_clock_is_after(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    tombstone: &VectorClock,
) -> Result<bool, StorageError> {
    let Some(row) = sync_items::load(conn, item_type, item_id)? else {
        return Ok(false);
    };
    let local = row
        .clock
        .filter(|_| row.deleted_at.is_none())
        .and_then(|text| serde_json::from_str::<VectorClock>(&text).ok());
    Ok(local.is_some_and(|local| compare(&local, tombstone) == ClockOrder::After))
}

/// An id from `deleted` that arrived with **no type on the wire** (§5.12.1).
///
/// The untyped delete covers *every* row under that id, whatever its type, so
/// the projection half reads the types this device actually stored
/// ([`store::item_types_for`]) and marks the tables each one names. The wire
/// carried no type and a client MUST NOT invent one from the id's shape, so
/// the local rows are the only honest source for that list.
///
/// The purge runs **unconditionally** here, and that is not the id-shape
/// inference §5.12.1 forbids. The typed arm above has to be careful because a
/// tag named like a note id would otherwise take the note's body with it; here
/// there is no such case to be careful about, because every row under the id —
/// the note's included — is being deleted. Body rows under a purely local
/// document this device never got a record for go with it, which is the same
/// rule read from the other side (§5.12: a delete for an unseen item is still
/// recorded).
pub(super) fn apply_untyped_tombstone(
    conn: &Connection,
    item_id: &str,
    now_ms: i64,
    totals: &mut ApplyTotals,
) -> Result<(), StorageError> {
    let txn = conn.unchecked_transaction().map_err(sqlite_failed)?;
    let item_types = store::item_types_for(&txn, item_id)?;
    store::apply_untyped_tombstone(&txn, item_id, now_ms, now_ms)?;
    journal_day_merge::mark_deleted(&txn, item_id)?;
    if journal_day_merge::hold_for_merge(&txn, item_id, None)? {
        txn.commit().map_err(sqlite_failed)?;
        totals.deleted += 1;
        return Ok(());
    }
    for item_type in &item_types {
        projectors::delete(&txn, item_type, item_id, now_ms)?;
    }
    body_debt::settle(&txn, item_id)?;
    let purged = update_log::purge_in(&txn, item_id).map_err(crdt_failed)?;
    txn.commit().map_err(sqlite_failed)?;
    totals.deleted += 1;
    if purged > 0 {
        totals.purged_documents.push(item_id.to_owned());
    }
    Ok(())
}

/// The CRDT tier's failure, back in the storage vocabulary this path speaks.
///
/// [`CrdtError::Storage`] is unwrapped rather than stringified: a purge cannot
/// fail for any CRDT reason — it decodes nothing — so the only variant reachable
/// here is a disk or lock failure, and flattening it would turn "out of space"
/// into "bad document".
fn crdt_failed(error: CrdtError) -> StorageError {
    match error {
        CrdtError::Storage { source } => source,
        other => StorageError::Failed {
            what: other.to_string(),
        },
    }
}
