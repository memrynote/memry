//! A note's or journal day's file gone ([`removed`]) or moved where it is the other kind
//! ([`crossed`]): the record is deleted, on the row's evidence that nothing but the file goes
//! ([`removal_deletes`]).

use rusqlite::{Connection, params};

use super::identity::{Removed, live_place, owe_in, settle_place};
use super::{ITEM_TYPE, failed, tombstone_local};
use crate::api::errors::StorageError;
use crate::domain::{journal, note_files, note_positions, owed_file_body};
use crate::sync::{body_debt, outbox};

/// The file at `path` of a note or a journal day is gone: the record is deleted
/// and its manual order dropped, in one transaction (a day as Electron's
/// `enqueueJournalDelete`). One deleted before is answered `Deleted` again with
/// nothing written; one the removal may not delete ([`removal_deletes`]) keeps
/// its record.
pub fn removed(
    conn: &Connection,
    note_id: &str,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Removed, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let removed = delete_in(&tx, note_id, device_id, now_ms)?;
    if removed == Removed::Undecided {
        return Ok(removed);
    }
    note_positions::remove(&tx, path)?;
    settle_place(&tx, note_id)?;
    tx.commit().map_err(failed)?;
    Ok(removed)
}

/// The note's or day's file moved from `from_path` to where it is the other kind: a note to a
/// day's path, a day out of the journal or to another date. Electron deletes the item and lists
/// the file as a new one (`renameKeepsJournalDate`, `vault/watcher.ts`), since notes and days
/// are separate sync types keyed by id; the tier makes the new one. The record is deleted as
/// [`removed`] deletes it, and owed the move ([`super::identity::owe_place`]) in the same
/// transaction: the debt stays until the tier drops the row, so a crash before that is finished
/// by the next open, which asks again and is answered `Deleted` with nothing written. One the
/// removal may not delete is only owed the move, as before, and so is one to `to_day`, the date
/// the new path names, when that day is here already: the file is not the new day then, and a
/// delete would leave the record's text in a file nothing names.
pub fn crossed(
    conn: &Connection,
    note_id: &str,
    from_path: &str,
    to_day: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Removed, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    owe_in(&tx, note_id, from_path, now_ms)?;
    let live = live_place(&tx, note_id)?.is_some() || live_day(&tx, note_id)?;
    if live
        && let Some(date) = to_day
        && live_day(&tx, &format!("j{date}"))?
    {
        tx.commit().map_err(failed)?;
        return Ok(Removed::Undecided);
    }
    let removed = delete_in(&tx, note_id, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(removed)
}

/// The live note or day deleted when the removal may delete it, with its delete queued.
fn delete_in(
    tx: &Connection,
    note_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Removed, StorageError> {
    let live = if live_place(tx, note_id)?.is_some() {
        ITEM_TYPE
    } else if live_day(tx, note_id)? {
        journal::ITEM_TYPE
    } else {
        return Ok(Removed::Deleted);
    };
    if !removal_deletes(tx, note_id)? {
        return Ok(Removed::Undecided);
    }
    tombstone_local(tx, live, note_id, device_id, now_ms)?;
    outbox::enqueue(tx, &outbox::Change::delete(live, note_id), now_ms)?;
    Ok(Removed::Deleted)
}

/// Whether the removal of the note's file may delete the note: its row says the
/// file held the whole note.
///
/// - The row knows the bytes on disk (`file_hash`): the tier pairs a move of the
///   file on them, so the removal is not a move.
/// - The document holds those bytes: the row's `content_hash` is the same, and
///   no file body is owed ([`owed_file_body`]). A body the file never had
///   (synced, kept, refused) would go with the note.
/// - No edit came after the row's stamp ([`note_files::behind_body`]): an edit
///   in the app, or a pulled one, whose write-back failed or has not run.
/// - No body is owed a pull ([`body_debt`]): the server holds text no file had.
fn removal_deletes(conn: &Connection, note_id: &str) -> Result<bool, StorageError> {
    let Some(row) = note_files::by_id(conn, note_id)? else {
        return Ok(false);
    };
    let holds_the_file = row.file_hash.is_some() && row.content_hash == row.file_hash;
    Ok(holds_the_file
        && !owed_file_body::owes(conn, note_id)?
        && !note_files::behind_body(conn, note_id)?
        && !body_debt::is_owed(conn, note_id)?)
}

/// Whether `id` is a live journal day's record.
fn live_day(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM journal_entries WHERE id = ?1 AND deleted_at IS NULL)",
        params![id],
        |row| row.get(0),
    )
    .map_err(failed)
}
