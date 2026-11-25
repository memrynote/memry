//! The delete half of [`super::apply_page_into`]: a typed tombstone and the
//! clock weighing #2409 adds to it.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::update_log;
use crate::domain::{attachment_uploads, journal, notes, settings};
use crate::storage::nested_tx;
use crate::storage::repositories::{projectors, sync_items};
use crate::sync::clock::{ClockOrder, VectorClock, compare};
use crate::sync::delete_keep::VaultFiles;
use crate::sync::{body_debt, delete_keep, journal_day_merge, outbox, store};

use super::{ApplyTotals, DOCUMENT_TYPES, feed, sqlite_failed};

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
    vault: Option<&VaultFiles>,
    totals: &mut ApplyTotals,
) -> Result<(), StorageError> {
    // Settings are never deleted (#5433), as desktop's settings handler skips
    // a pulled delete: the row stays live and its queued edit stays queued.
    if item_type == settings::SETTINGS_ITEM_TYPE {
        eprintln!(
            "memry-core: pull: {item_type}:{item_id} delete skipped: settings are never deleted"
        );
        totals.skipped += 1;
        return Ok(());
    }
    let txn = nested_tx::begin(conn).map_err(sqlite_failed)?;
    if let Some(clock) = clock.filter(|clock| !clock.is_empty()) {
        store::record_tombstone_clock(&txn, item_type, item_id, clock, now_ms)?;
        if live_clock_is_after(&txn, item_type, item_id, clock)? {
            txn.commit().map_err(sqlite_failed)?;
            totals.skipped += 1;
            feed::revived(&mut totals.feed, item_type, item_id);
            return Ok(());
        }
    }
    let was_live = feed::is_live(&txn, item_type, item_id)?;
    delete_keep::keep(
        &txn,
        item_type,
        item_id,
        deleted_at,
        server_cursor,
        clock,
        body_state_vector,
        clock_device,
        vault,
        now_ms,
    )?;
    store::mark_deleted(&txn, item_type, item_id, deleted_at, server_cursor, now_ms)?;
    // Sent, the queued edit would undelete the item (VERIFY-5426). After
    // `delete_keep::keep`, which reads the queue (rule 1). A re-create whose
    // clock is after the delete returned above, still queued.
    drop_queued_edits(&txn, item_type, item_id)?;
    if item_type == journal::ITEM_TYPE {
        journal_day_merge::mark_deleted(&txn, item_id)?;
        // A live foreign row keeps its row and body for the drain (#2984).
        if journal_day_merge::hold_for_merge(&txn, item_id, clock)? {
            txn.commit().map_err(sqlite_failed)?;
            count(totals, was_live);
            feed::deleted(&mut totals.feed, item_type, item_id, was_live);
            return Ok(());
        }
    }
    projectors::delete(&txn, item_type, item_id, deleted_at)?;
    let purged = if DOCUMENT_TYPES.contains(&item_type) {
        // The body debt goes with the body: a pull owed before the delete
        // would bring the server's surviving log back (#2297).
        body_debt::settle(&txn, item_id)?;
        // After `delete_keep::keep`, which reads the queue to decide what text
        // this device never pushed (#5379).
        outbox::drop_body_updates(&txn, item_type, item_id)?;
        let purged = update_log::purge_in(&txn, item_id).map_err(crdt_failed)?;
        // A same-id revive can still want the note's unsent pictures (§14.8.2).
        if item_type == notes::ITEM_TYPE {
            let kept = attachment_uploads::ids_for_note(&txn, item_id)?.len();
            if kept > 0 {
                eprintln!(
                    "memry-core: attachment uploads: note {item_id} was deleted elsewhere; its {kept} unsent picture(s) stay here until it is revived or they are detached"
                );
            }
        }
        purged
    } else {
        0
    };
    txn.commit().map_err(sqlite_failed)?;
    count(totals, was_live);
    feed::deleted(&mut totals.feed, item_type, item_id, was_live);
    if purged > 0 {
        totals.purged_documents.push(item_id.to_owned());
    }
    Ok(())
}

/// Retires the queued edits of a row this verified delete removed. Sent, each
/// is an `update` carrying `deletedAt` that the server applies as a write,
/// bringing the item back on every device (#5413, #5427). A queued delete
/// stays; a document's body updates go with its log (#5379).
fn drop_queued_edits(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<(), StorageError> {
    let mut statement = conn
        .prepare("SELECT id FROM outbox WHERE item_type = ?1 AND item_id = ?2 AND op IN (?3, ?4)")
        .map_err(sqlite_failed)?;
    let ids = statement
        .query_map(
            rusqlite::params![item_type, item_id, outbox::OP_UPSERT, outbox::OP_CREATE],
            |row| row.get(0),
        )
        .map_err(sqlite_failed)?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(sqlite_failed)?;
    outbox::retire_in(conn, &ids, "superseded by a verified delete")
}

/// Counts one applied delete: deleted when it took a live row, skipped when the row was
/// never live or already deleted, as the feed reports it ([`feed::deleted`]).
fn count(totals: &mut ApplyTotals, was_live: bool) {
    if was_live {
        totals.deleted += 1;
    } else {
        totals.skipped += 1;
    }
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
