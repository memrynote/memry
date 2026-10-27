//! Local-only notes (desktop `notes:set-local-only`): a note whose record and
//! body never leave this device.
//!
//! The flag is `note_files.local_only` ([`crate::domain::note_files`]) and the
//! rule that honours it is one check in [`crate::sync::outbox::enqueue`]: while
//! it is set, no outbox row is written for the note, a record row or a body
//! update, and the note's own `sync_items` row and CRDT log are written as
//! usual. Deleting a local-only note therefore pushes no tombstone, as on
//! desktop (`pending-deletes.ts`): the server may never have seen it. The
//! caller that deletes a note's file row must do so **after** the core delete,
//! or the delete is no longer withheld.
//!
//! [`set`] is the one owner of the flag and settles what was queued:
//!
//! - **On** drops every unsent record upsert and body update of the note. A
//!   body update typed in the second before the toggle is already queued, and
//!   would otherwise still be pushed. What the server is owed is recomputed
//!   when the flag is cleared. A queued delete stays: it is not content.
//! - **Off** queues the whole note, because nothing else will: the record (its
//!   payload is rebuilt from `sync_items` at push time, so the server receives
//!   the current state, not the state when the flag was set) and the body as one
//!   full-state update. A full Yjs state merges idempotently with what peers
//!   and the server already hold, so it is safe whatever they have.
//!
//! **The server never holds a record without its body.** A body that cannot
//! ride as one update (the server caps the decoded sealed update at 5 MiB,
//! chapter 07 §7.3, and measures the *compressed* frame) is refused **before
//! anything is written**: the flag stays on, nothing is queued, and the answer
//! is [`LocalOnlyChange::TooLargeToSync`] for the caller to show. Queuing the
//! record and leaving the body to a return value would let a crash or an
//! ignored answer put a record on the server whose later body deltas depend on
//! history it never received. A note that large stays local-only until a later
//! step pairs clearing the flag with a snapshot push under a durable marker of
//! what is owed (the snapshot pusher refuses a local-only note, so it cannot
//! be the first half of that pair today).

use rusqlite::{Connection, params};
use yrs::ReadTxn as _;

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::{note_files, reads};
use crate::protocol::account::MAX_UPDATE_BYTES;
use crate::protocol::crdt_envelope::packed_len;
use crate::storage::repositories::sync_items;
use crate::sync::outbox;

use super::{ITEM_TYPE, failed};

/// What became of the note's body when the flag was cleared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyPush {
    /// The full state is queued as one update.
    Queued,
    /// The note holds no body, or no record to send it with: nothing to queue.
    Empty,
}

/// What [`set`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalOnlyChange {
    /// The note was already in the asked state; nothing was touched.
    Unchanged,
    /// The note is local-only now; `dropped` unsent outbox rows were removed.
    Enabled { dropped: usize },
    /// The note syncs again; its record is queued, and `body` says what became
    /// of its body.
    Disabled { body: BodyPush },
    /// The note stays local-only and **nothing was written**: its body sealed
    /// is `packed_bytes` long, over the 5 MiB the server takes as one update.
    TooLargeToSync { packed_bytes: usize },
}

/// Sets or clears the local-only flag of a note that has a `note_files` row.
///
/// One transaction: the flag and the outbox rows it changes commit together.
pub fn set(
    conn: &Connection,
    note_id: &str,
    local_only: bool,
    now_ms: i64,
) -> Result<LocalOnlyChange, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let Some(file) = note_files::by_id(&tx, note_id)? else {
        return Err(StorageError::NotFound {
            what: note_id.to_owned(),
        });
    };
    if file.local_only == local_only {
        return Ok(LocalOnlyChange::Unchanged);
    }
    let change = if local_only {
        note_files::set_local_only(&tx, note_id, true)?;
        let dropped = tx
            .execute(
                "DELETE FROM outbox WHERE item_type = ?1 AND item_id = ?2 AND op IN (?3, ?4)",
                params![
                    ITEM_TYPE,
                    note_id,
                    outbox::OP_UPSERT,
                    outbox::OP_CRDT_UPDATE
                ],
            )
            .map_err(failed)?;
        LocalOnlyChange::Enabled { dropped }
    } else {
        // Decided before the first write: see the module doc.
        let pushable = is_pushable(&tx, note_id)?;
        let state = if pushable {
            full_state(&tx, note_id).map_err(storage)?
        } else {
            None
        };
        if let Some(state) = &state {
            let packed_bytes = packed_len(state);
            if packed_bytes > MAX_UPDATE_BYTES {
                return Ok(LocalOnlyChange::TooLargeToSync { packed_bytes });
            }
        }
        note_files::set_local_only(&tx, note_id, false)?;
        LocalOnlyChange::Disabled {
            body: queue_whole_note(&tx, note_id, pushable, state, now_ms)?,
        }
    };
    tx.commit().map_err(failed)?;
    Ok(change)
}

/// The note's live record exists and can be pushed: it has a payload and is
/// not deleted. A note known by metadata only, or already deleted, has nothing
/// to send.
fn is_pushable(tx: &Connection, note_id: &str) -> Result<bool, StorageError> {
    Ok(sync_items::load(tx, ITEM_TYPE, note_id)?
        .is_some_and(|row| row.payload.is_some() && row.deleted_at.is_none()))
}

/// Queues the record and, when there is one, the body of a note that just
/// stopped being local-only.
fn queue_whole_note(
    tx: &Connection,
    note_id: &str,
    pushable: bool,
    state: Option<Vec<u8>>,
    now_ms: i64,
) -> Result<BodyPush, StorageError> {
    if !pushable {
        return Ok(BodyPush::Empty);
    }
    outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, note_id), now_ms)?;
    let Some(state) = state else {
        return Ok(BodyPush::Empty);
    };
    outbox::enqueue(
        tx,
        &outbox::Change::crdt_update(ITEM_TYPE, note_id, state),
        now_ms,
    )?;
    Ok(BodyPush::Queued)
}

/// The note body's whole state as one update, or `None` for a document that
/// holds nothing (its state vector is empty: the two-byte encode of an empty
/// document is not "no content").
fn full_state(conn: &Connection, note_id: &str) -> Result<Option<Vec<u8>>, CrdtError> {
    let document = reads::document_of(conn, note_id)?;
    if document.read(|txn| txn.state_vector().is_empty())? {
        return Ok(None);
    }
    document.encode_state().map(Some)
}

fn storage(error: CrdtError) -> StorageError {
    match error {
        CrdtError::Storage { source } => source,
        other => StorageError::Failed {
            what: other.to_string(),
        },
    }
}
