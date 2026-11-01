//! The app's own rename or move of a note's file (desktop Step 13g, #3530), after
//! `renameNote` and `moveNote` (`apps/desktop/src/main/vault/notes-rename.ts`), markdown and
//! file notes (PDF, image, audio, video) alike. Under its rows' lane the vault tier records
//! the move ([`begin`]), moves the file, and then calls [`moved_by_app`]. That one transaction
//! moves the record, the file's `note_files` row and the manual slot together, and forgets the
//! record of the move.
//!
//! The order is what makes a crash converge. Until the transaction, the record of the move
//! names the note, both paths and the title, and the next open, before its watcher starts,
//! finishes the move when the file is at the new path and forgets it when it is not
//! ([`pending`], [`abandon`]). That works for a file note too, whose row has no hash to pair a
//! moved file by. After the transaction, file, row and record all agree. A failed transaction
//! changes nothing, so the tier moves the file back. A record that moved without its row is
//! never left behind, which the watcher's two steps (record, then row) allow.
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

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

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
    /// The title the person gave, or `None` to keep the record's (a move). Always `None`
    /// without `keeps_kind`: the record keeps its title then, as it keeps its folder.
    pub title: Option<&'a str>,
    /// The new path is what the file was: the record's journal day (none for a note) is the
    /// day the new path names. The tier knows the journal folder and format, so it decides.
    pub keeps_kind: bool,
}

/// The `meta` key of the app move whose file may have moved and whose record has not
/// ([`begin`]). One at a time: the vault tier's rows' lane runs one move at a time.
pub const APP_MOVE_META_KEY: &str = "notes.app_move.v1";

/// An app move that [`begin`] recorded and [`moved_by_app`] has not finished. Stored as JSON
/// under [`APP_MOVE_META_KEY`]; every build reads every `v1` record, and a field a later build
/// adds is ignored here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMove {
    pub note_id: String,
    pub old_path: String,
    pub new_path: String,
    pub title: Option<String>,
}

/// Records the move before the file moves, replacing any record left: whatever happens to the
/// file next, the next open can tell. Writes no note.
pub fn begin(conn: &Connection, note_id: &str, moved: &AppMoved<'_>) -> Result<(), StorageError> {
    let pending = PendingMove {
        note_id: note_id.to_owned(),
        old_path: moved.old_path.to_owned(),
        new_path: moved.new_path.to_owned(),
        title: moved.title.map(str::to_owned),
    };
    let value = serde_json::to_string(&pending).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![APP_MOVE_META_KEY, value],
    )
    .map_err(failed)?;
    Ok(())
}

/// The move [`begin`] recorded and nothing finished or forgot. A record that does not parse
/// is an error, which the caller logs before it forgets it.
pub fn pending(conn: &Connection) -> Result<Option<PendingMove>, StorageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![APP_MOVE_META_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    value
        .map(|value| {
            serde_json::from_str(&value).map_err(|error| StorageError::Failed {
                what: format!("the record of an app move does not parse: {error}"),
            })
        })
        .transpose()
}

/// Forgets the recorded move: the file did not move, or went back.
pub fn abandon(conn: &Connection) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM meta WHERE key = ?1",
        params![APP_MOVE_META_KEY],
    )
    .map_err(failed)?;
    Ok(())
}

/// The note's file is at `moved.new_path` now: record, row and slot follow it in one
/// transaction, which also forgets the record of the move ([`begin`]). An `Err` leaves all of
/// it as it was.
pub fn moved_by_app(
    conn: &Connection,
    note_id: &str,
    moved: &AppMoved<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    debug_assert!(
        moved.keeps_kind || moved.title.is_none(),
        "a move that changes what the file is keeps the record's title"
    );
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
    abandon(&tx)?;
    tx.commit().map_err(failed)
}
