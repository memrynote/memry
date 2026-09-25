//! Journal body writes: a block edit addressed by a day or by a live journal id
//! (spec 005-journal JP020).
//!
//! The body is the same collaborative document a note's is, keyed by the
//! journal record's id (§7.1), so the edit is authored and stored exactly as
//! [`crate::domain::body_write::edit_block`] does it. Two things differ:
//!
//! - liveness is [`journal::journal_exists`], not the notes table;
//! - the change is queued as `("journal", id)`. The item type of a CRDT change
//!   never reaches the wire (JP003d), so this is for readability only.
//!
//! **A day is created by its first write (D2), in the write's transaction.**
//! The edit is authored before anything is written, so an edit that fails
//! (a block the body does not hold) or that authors nothing leaves no entry
//! behind and pushes nothing.

use rusqlite::Connection;

use crate::api::errors::StorageError;
use crate::crdt::body_edit::BlockEdit;
use crate::crdt::errors::CrdtError;
use crate::domain::body_write;
use crate::domain::journal::{self, ITEM_TYPE};

/// What [`edit_day`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditDayOutcome {
    /// The journal record id, which is also the document id. For a day with no
    /// entry and an edit that changed nothing, the id the day would get.
    pub id: String,
    /// Whether this edit created the day's entry.
    pub created: bool,
    /// Whether this edit cleared a tombstone on the day's entry.
    pub revived: bool,
    /// Whether the edit authored an update (and therefore wrote anything).
    pub changed: bool,
}

/// Applies one block edit to the body of the day `date`, creating or reviving
/// the day's entry when it has no live one.
///
/// The id is resolved through [`journal::entry_for`]: an existing record's id
/// wins over `j<date>`, even a tombstoned one, which is revived under its own
/// id (D5). Creation and the update row commit in one transaction.
pub fn edit_day(
    conn: &Connection,
    date: &str,
    edit: &BlockEdit,
    device_id: &str,
    now_ms: i64,
) -> Result<EditDayOutcome, CrdtError> {
    let id = match journal::entry_for(conn, date)? {
        Some((id, _)) => id,
        None => journal::document_id_for(date)?,
    };

    let Some(update) = body_write::author(conn, &id, edit, device_id)? else {
        return Ok(EditDayOutcome {
            id,
            created: false,
            revived: false,
            changed: false,
        });
    };

    let tx = conn.unchecked_transaction().map_err(storage_failed)?;
    let opened = journal::open_day_in(&tx, date, device_id, now_ms)?;
    if opened.id != id {
        // The entry changed between authoring and the transaction; the update
        // was authored against another document. Dropping `tx` rolls back.
        return Err(StorageError::Failed {
            what: format!("the entry for {date} changed during the edit"),
        }
        .into());
    }
    body_write::append_in(&tx, ITEM_TYPE, &id, &update, now_ms)?;
    tx.commit().map_err(storage_failed)?;

    Ok(EditDayOutcome {
        id,
        created: opened.created,
        revived: opened.revived,
        changed: true,
    })
}

/// Applies one block edit to the body of an already-live journal entry.
///
/// - Returns: `Ok(false)` when no live journal entry has that id; it never
///   creates or revives one. `Ok(true)` when the entry is live, including an
///   edit that authored nothing (which writes nothing).
pub fn edit_entry(
    conn: &Connection,
    id: &str,
    edit: &BlockEdit,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, CrdtError> {
    if !journal::journal_exists(conn, id) {
        return Ok(false);
    }
    let Some(update) = body_write::author(conn, id, edit, device_id)? else {
        return Ok(true);
    };
    let tx = conn.unchecked_transaction().map_err(storage_failed)?;
    body_write::append_in(&tx, ITEM_TYPE, id, &update, now_ms)?;
    tx.commit().map_err(storage_failed)?;
    Ok(true)
}

fn storage_failed(error: rusqlite::Error) -> CrdtError {
    StorageError::Failed {
        what: error.to_string(),
    }
    .into()
}
