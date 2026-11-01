//! The app's own rename or move of a note's file (desktop Step 13g, #3530), after
//! `renameNote` and `moveNote` (`apps/desktop/src/main/vault/notes-rename.ts`). The vault tier
//! moves the file first and then calls [`moved_by_app`] under its rows' lane. That one
//! transaction moves the record, the file's `note_files` row and the manual slot together.
//!
//! The order is what makes a crash converge. Before the transaction, the file is at its new
//! path and the row still names the old one with the same bytes: the next open's rescan pairs
//! the two as a move of the note, the way it pairs a move made outside the app
//! ([`super::identity::renamed`]). After it, file, row and record all agree. A failed
//! transaction changes nothing, so the tier moves the file back. A record that moved without
//! its row is never left behind, which the watcher's two steps (record, then row) allow.
//!
//! The record takes the title the person gave, not the file name, which is the title with
//! the characters a file name cannot hold replaced (Electron's `title: newTitle`). A move keeps
//! the title. A rename keeps the note's manual slot. A move drops the slot of the old folder
//! and puts the note above every placed sibling of the new one (`placeNewItemAtTop`), as a new
//! note there would be.
//!
//! A move that changes what the file is (a note into a journal day's path, a day out of the
//! journal or to another day's) follows the rule the watcher's move follows (Step 13m): the
//! record stays as it was and is owed the move ([`super::identity::owe_place`]), and only the
//! row follows the file.
//!
//! The inbound `[[link]]` rewrite is not here: it edits other notes' files, which only the
//! vault tier writes.

use rusqlite::Connection;

use super::failed;
use super::identity::{folder_of, follow, owe_in, settle_place};
use crate::api::errors::StorageError;
use crate::domain::{note_files, note_positions};

/// Where the app moved a note's file.
#[derive(Debug, Clone, Copy)]
pub struct AppMoved<'a> {
    /// The row's path before the move.
    pub old_path: &'a str,
    /// Vault-relative, `/`-separated; no other row may hold it.
    pub new_path: &'a str,
    /// The title the person gave, or `None` to keep the record's (a move).
    pub title: Option<&'a str>,
    /// The new path is what the file was: the record's journal day (none for a note) is the
    /// day the new path names. The tier knows the journal folder and format, so it decides.
    pub keeps_kind: bool,
}

/// The note's file is at `moved.new_path` now: record, row and slot follow it in one
/// transaction. An `Err` leaves all three as they were.
pub fn moved_by_app(
    conn: &Connection,
    note_id: &str,
    moved: &AppMoved<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let (old_folder, new_folder) = (folder_of(moved.old_path), folder_of(moved.new_path));
    if moved.keeps_kind {
        let folder = (!new_folder.is_empty()).then_some(new_folder);
        follow(&tx, note_id, moved.title, folder, device_id, now_ms)?;
        if old_folder == new_folder {
            note_positions::carry(&tx, moved.old_path, moved.new_path)?;
        } else {
            note_positions::remove(&tx, moved.old_path)?;
            note_positions::place_at_top(&tx, moved.new_path, new_folder)?;
        }
        settle_place(&tx, note_id)?;
    } else {
        owe_in(&tx, note_id, moved.old_path, now_ms)?;
    }
    note_files::rename_path(&tx, note_id, moved.new_path)?;
    tx.commit().map_err(failed)
}
