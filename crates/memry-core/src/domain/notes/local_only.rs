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
//! [`set`] changes the flag and settles what was queued:
//!
//! - **On** drops every unsent outbox row of the note. A body update typed in
//!   the second before the toggle is already queued, and would otherwise still
//!   be pushed. What the server is owed is recomputed when the flag is cleared.
//! - **Off** queues the whole note, because nothing else will: the record (its
//!   payload is rebuilt from `sync_items` at push time, so the server receives
//!   the current state, not the state when the flag was set) and the body as one
//!   full-state update. A full Yjs state merges idempotently with what peers
//!   and the server already hold, so it is safe whatever they have.
//!
//! A body whose full state exceeds the 5 MiB update cap (chapter 07 §7.3)
//! cannot ride as one update. It is reported as [`BodyPush::TooLarge`] and
//! never queued: the caller sends it as a snapshot
//! ([`crate::crdt::SnapshotPusher`]), which is the one route for a document of
//! that size. A row the server would reject is retired by the push loop, which
//! would lose the body silently.

use rusqlite::{Connection, params};
use yrs::ReadTxn as _;

use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::{note_files, reads};
use crate::protocol::account::MAX_UPDATE_BYTES;
use crate::storage::repositories::sync_items;
use crate::sync::outbox;

use super::{ITEM_TYPE, failed};

/// What happened to the note's body when the flag was cleared.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyPush {
    /// The full state is queued as one update.
    Queued,
    /// The note holds no body, or no record to send it with: nothing to queue.
    Empty,
    /// The full state is `bytes` long, over the update cap: send a snapshot.
    TooLarge { bytes: usize },
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
    note_files::set_local_only(&tx, note_id, local_only)?;

    let change = if local_only {
        let dropped = tx
            .execute(
                "DELETE FROM outbox WHERE item_type = ?1 AND item_id = ?2",
                params![ITEM_TYPE, note_id],
            )
            .map_err(failed)?;
        LocalOnlyChange::Enabled { dropped }
    } else {
        LocalOnlyChange::Disabled {
            body: queue_whole_note(&tx, note_id, now_ms)?,
        }
    };
    tx.commit().map_err(failed)?;
    Ok(change)
}

/// Queues the record and the body of a note that just stopped being
/// local-only. A note with no payload yet (known by metadata only) or already
/// deleted has nothing to send.
fn queue_whole_note(tx: &Connection, note_id: &str, now_ms: i64) -> Result<BodyPush, StorageError> {
    let live = sync_items::load(tx, ITEM_TYPE, note_id)?
        .is_some_and(|row| row.payload.is_some() && row.deleted_at.is_none());
    if !live {
        return Ok(BodyPush::Empty);
    }
    outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, note_id), now_ms)?;

    let Some(state) = full_state(tx, note_id).map_err(storage)? else {
        return Ok(BodyPush::Empty);
    };
    if state.len() > MAX_UPDATE_BYTES {
        return Ok(BodyPush::TooLarge { bytes: state.len() });
    }
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
