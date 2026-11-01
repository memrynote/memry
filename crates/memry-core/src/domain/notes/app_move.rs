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
//! ([`pending`], [`abandon`]; the record's format is a contract, [`Recorded`]). That works for
//! a file note too, whose row has no hash to pair a moved file by. After the transaction,
//! file, row and record all agree. A failed transaction changes nothing, so the tier moves the
//! file back. A record that moved without its row is never left behind, which the watcher's
//! two steps (record, then row) allow.
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

/// The `meta` key of the record of an app move whose file may have moved and whose note has
/// not followed ([`begin`]). One at a time: the vault tier's rows' lane runs one move at a time.
pub const APP_MOVE_META_KEY: &str = "notes.app_move.v1";

/// The `version` of the record this build writes and acts on.
const RECORD_VERSION: u64 = 1;

/// An app move that [`begin`] recorded and that was not finished or forgotten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingMove {
    pub note_id: String,
    pub old_path: String,
    pub new_path: String,
    pub title: Option<String>,
}

/// What is recorded under [`APP_MOVE_META_KEY`].
///
/// The record is JSON, `{"version": 1, "noteId", "oldPath", "newPath", "title"}`, and a
/// format that crosses builds: a build before this one does not know the key; every later
/// build reads a version 1 record as this build writes it, and a field a later build adds to
/// version 1 is ignored here. A record of another version, or one that does not parse, is
/// [`Recorded::Unknown`]: nothing here acts on it, replaces it or deletes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recorded {
    /// A version 1 record, which this build finishes or forgets.
    Move(PendingMove),
    /// A record this build cannot act on, left for the build that wrote it; says why.
    Unknown(String),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u64,
    note_id: String,
    old_path: String,
    new_path: String,
    title: Option<String>,
}

/// Records the move before the file moves, replacing a version 1 record left behind: whatever
/// happens to the file next, the next open can tell. Writes no note. Refused over a record
/// this build cannot read ([`Recorded::Unknown`]), which stays as it is.
pub fn begin(conn: &Connection, note_id: &str, moved: &AppMoved<'_>) -> Result<(), StorageError> {
    if let Some(Recorded::Unknown(why)) = pending(conn)? {
        return Err(StorageError::Failed {
            what: format!(
                "an unfinished app move that this version cannot read is recorded ({why}); \
                 it is left for the version that wrote it"
            ),
        });
    }
    let record = Record {
        version: RECORD_VERSION,
        note_id: note_id.to_owned(),
        old_path: moved.old_path.to_owned(),
        new_path: moved.new_path.to_owned(),
        title: moved.title.map(str::to_owned),
    };
    let value = serde_json::to_string(&record).map_err(|error| StorageError::Failed {
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

/// What is recorded, if anything.
pub fn pending(conn: &Connection) -> Result<Option<Recorded>, StorageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = ?1",
            params![APP_MOVE_META_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(value.map(|value| parse(&value)))
}

fn parse(value: &str) -> Recorded {
    let version = match serde_json::from_str::<serde_json::Value>(value) {
        Ok(json) => json.get("version").and_then(serde_json::Value::as_u64),
        Err(error) => return Recorded::Unknown(format!("a record that does not parse: {error}")),
    };
    match version {
        Some(RECORD_VERSION) => match serde_json::from_str::<Record>(value) {
            Ok(record) => Recorded::Move(PendingMove {
                note_id: record.note_id,
                old_path: record.old_path,
                new_path: record.new_path,
                title: record.title,
            }),
            Err(error) => {
                Recorded::Unknown(format!("a version 1 record that does not parse: {error}"))
            }
        },
        Some(version) => Recorded::Unknown(format!("a version {version} record")),
        None => Recorded::Unknown("a record with no version".to_owned()),
    }
}

/// Forgets the recorded move, when it is a version 1 record (`note_id`'s, if given): the file
/// did not move, went back, or the note followed it.
fn forget(conn: &Connection, note_id: Option<&str>) -> Result<(), StorageError> {
    let ours = match pending(conn)? {
        Some(Recorded::Move(recorded)) => note_id.is_none_or(|id| recorded.note_id == id),
        Some(Recorded::Unknown(_)) | None => false,
    };
    if ours {
        conn.execute(
            "DELETE FROM meta WHERE key = ?1",
            params![APP_MOVE_META_KEY],
        )
        .map_err(failed)?;
    }
    Ok(())
}

/// Forgets a version 1 record: the file did not move, or went back. A record this build cannot
/// read stays.
pub fn abandon(conn: &Connection) -> Result<(), StorageError> {
    forget(conn, None)
}

/// The note's file is at `moved.new_path` now: record, row and slot follow it in one
/// transaction, which also forgets the note's record of the move ([`begin`]). An `Err` leaves
/// all of it as it was.
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
    forget(&tx, Some(note_id))?;
    tx.commit().map_err(failed)
}
