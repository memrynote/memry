//! A note's or journal day's file gone ([`removed`]) or moved where it is the other kind
//! ([`crossed`]): the record is deleted, on the row's evidence that nothing but the file goes
//! ([`removal_deletes`]).

use rusqlite::{Connection, params};

use super::identity::{
    Removed, live_place, mints_beside_electron, owe_in, settle_place, unfiled_notes,
};
use super::journal_day::{DayEntry, day_entry};
use super::{ITEM_TYPE, failed, tombstone_local};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::{journal, note_files, note_positions, owed_file_body};
use crate::markdown::convert::EmbedResolver;
use crate::markdown::convert::api::Converter;
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

/// Where a crossing move took a note's or day's file, and what the file says there.
#[derive(Debug, Clone, Copy)]
pub struct Crossing<'a> {
    /// The path the record still describes.
    pub from_path: &'a str,
    /// Where the file is now, vault-relative with `/`.
    pub path: &'a str,
    /// The file name without `.md`, and its folder (`None` at the vault root).
    pub title: &'a str,
    pub folder_path: Option<&'a str>,
    /// The day the new path names, `YYYY-MM-DD`; `None` for a note's path.
    pub day: Option<&'a str>,
    /// The file's markdown below its frontmatter block.
    pub body: &'a str,
    /// `<vault>/.memry/data.db` of Electron is beside the core's database.
    pub electron_db_beside: bool,
}

/// The note's or day's file moved to where it is the other kind: a note to a day's path, a day
/// out of the journal or to another date. Electron deletes the item and lists the file as a
/// new one (`renameKeepsJournalDate`, `vault/watcher.ts`), since notes and days are separate
/// sync types keyed by id; the tier makes the new one. The record is deleted as [`removed`]
/// deletes it, and owed the move ([`super::identity::owe_place`]) in the same transaction: the
/// debt stays until the tier drops the row, so a crash before that is finished by the next
/// open, which asks again and is answered `Deleted` with nothing written. One the removal may
/// not delete is only owed the move, as before, and so is one whose file the tier would put
/// off as the new item ([`put_off`]): the delete would leave the record's text in a file no
/// item names, and push it to every device. `converter` and `embeds` read a day entry's body,
/// as [`super::journal_day::adopt_day`] reads it; `embeds` must not read this database.
pub fn crossed(
    conn: &Connection,
    converter: Option<&Converter>,
    embeds: Option<&dyn EmbedResolver>,
    note_id: &str,
    to: &Crossing<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<Removed, CrdtError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    owe_in(&tx, note_id, to.from_path, now_ms)?;
    let live = live_place(&tx, note_id)?.is_some() || live_day(&tx, note_id)?;
    if live && put_off(&tx, converter, embeds, to, device_id)? {
        tx.commit().map_err(failed)?;
        return Ok(Removed::Undecided);
    }
    let removed = delete_in(&tx, note_id, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(removed)
}

/// Whether the tier would put the file off rather than make it the new item, by the rules of
/// [`super::identity::adopt`] and [`super::journal_day::adopt_day`]: a note no row names
/// claims its path; its day is a date no record holds, or one whose entry is another's, has a
/// row, or has another text ([`DayEntry::Taken`]); or a new id may not be minted beside
/// Electron's database. A deleted day whose text the file is, is revived, as Electron makes the
/// day again (`newMarkdownFileId`).
fn put_off(
    tx: &Connection,
    converter: Option<&Converter>,
    embeds: Option<&dyn EmbedResolver>,
    to: &Crossing<'_>,
    device_id: &str,
) -> Result<bool, CrdtError> {
    if !unfiled_notes(tx, to.title, to.folder_path)?.is_empty() {
        return Ok(true);
    }
    if let Some(date) = to.day {
        let Ok(date) = journal::valid_date(date) else {
            return Ok(true);
        };
        let id = journal::document_id_for(date)?;
        match day_entry(
            tx,
            converter,
            embeds,
            date,
            &id,
            (to.path, to.body),
            device_id,
        )? {
            DayEntry::Taken => return Ok(true),
            DayEntry::Existing => return Ok(false),
            DayEntry::Free => {}
        }
    }
    Ok(to.electron_db_beside && !mints_beside_electron(tx)?)
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
