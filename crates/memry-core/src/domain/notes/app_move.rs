//! The app's own rename or move of a note's file (desktop Step 13g, #3530), after
//! `renameNote` and `moveNote` (`apps/desktop/src/main/vault/notes-rename.ts`), markdown and
//! file notes (PDF, image, audio, video) alike. Under its rows' lane the vault tier records
//! the move ([`begin`]), moves the file, and then calls [`moved_by_app`]. That one transaction
//! moves the record, the file's `note_files` row and the manual slot together, and forgets the
//! record of the move.
//!
//! The order is what makes a crash converge. Until the transaction, the note's record of the
//! move names both paths and the title, and the vault tier's next open, before its watcher
//! starts (13g-1c), finishes the move when the file is at the new path and forgets it when it
//! is not ([`pending`], [`abandon`]; the record's format is a contract, [`Recorded`]). That
//! works for a file note too, whose row has no hash to pair a moved file by. After the
//! transaction, file, row and record all agree. A failed transaction changes nothing, so the
//! tier moves the file back. A record that moved without its row is never left behind, which
//! the watcher's two steps (record, then row) allow.
//!
//! Power loss converges as a crash does only when the disk has the steps in this order:
//! [`begin`] syncs its write (`synchronous = FULL`) before the file moves, and the tier syncs
//! the file's folder after the rename and before the transaction (13g-1c). The transaction
//! itself may be lost; the record then finishes it again.
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

use rusqlite::{Connection, params};
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

/// The `meta` key of a note's record of an app move, before the note's id: one row per note
/// whose file may have moved and whose record has not followed ([`begin`]).
const PREFIX: &str = "notes.app_move.v1:";
/// The first key after every key with [`PREFIX`] (`:` is followed by `;`).
const PREFIX_END: &str = "notes.app_move.v1;";

/// The `version` of the record this build writes and acts on.
const RECORD_VERSION: u64 = 1;

/// The `meta` key of `note_id`'s record of an app move.
pub fn record_key(note_id: &str) -> String {
    format!("{PREFIX}{note_id}")
}

/// A note's app move that [`begin`] recorded and that was not finished or forgotten.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingMove {
    pub old_path: String,
    pub new_path: String,
    pub title: Option<String>,
}

/// What a note's [`record_key`] holds.
///
/// The value is JSON, `{"version": 1, "oldPath", "newPath", "title"}`, a format that crosses
/// builds: a build before this one does not know the key; every later build reads a version 1
/// record as this build writes it, and a field a later build adds to version 1 is ignored here.
/// A record of another version, or one that does not parse, is [`Recorded::Unreadable`]:
/// nothing here acts on it, replaces it or deletes it, and it holds back that note's moves
/// only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Recorded {
    /// A version 1 record, which this build finishes or forgets.
    Move(PendingMove),
    /// A record this build cannot act on, left for the build that wrote it; says why.
    Unreadable(String),
}

/// Why [`begin`] did not record a move.
#[derive(Debug, thiserror::Error)]
pub enum BeginError {
    /// The note's last move is recorded and not settled: its file may be at either path, so
    /// it moves again only after the next open settled that.
    #[error("the last move of this note did not finish; reopen the vault to finish it")]
    Unsettled,
    /// Another version of the app recorded a move of the note that this one cannot read.
    #[error(
        "another version of the app recorded a move of this note that this version cannot \
         finish ({0}); open the vault in that version"
    )]
    Unreadable(String),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u64,
    old_path: String,
    new_path: String,
    title: Option<String>,
}

/// Records the note's move before its file moves, on disk before it returns
/// (`synchronous = FULL` for this one write), so the next open knows of it whatever happens
/// to the file next. Writes no note. One move per note: refused while the note has a record.
pub fn begin(conn: &Connection, note_id: &str, moved: &AppMoved<'_>) -> Result<(), BeginError> {
    match recorded(conn, note_id)? {
        Some(Recorded::Move(_)) => return Err(BeginError::Unsettled),
        Some(Recorded::Unreadable(why)) => return Err(BeginError::Unreadable(why)),
        None => {}
    }
    let record = Record {
        version: RECORD_VERSION,
        old_path: moved.old_path.to_owned(),
        new_path: moved.new_path.to_owned(),
        title: moved.title.map(str::to_owned),
    };
    let value = serde_json::to_string(&record).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    let was: i64 = conn
        .query_row("PRAGMA synchronous", [], |row| row.get(0))
        .map_err(failed)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(failed)?;
    let written = conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)",
        params![record_key(note_id), value],
    );
    let restored = conn.pragma_update(None, "synchronous", was);
    written.map_err(failed)?;
    restored.map_err(failed)?;
    Ok(())
}

/// Every note's record, in note id order.
pub fn pending(conn: &Connection) -> Result<Vec<(String, Recorded)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT substr(key, ?1), value FROM meta WHERE key >= ?2 AND key < ?3 ORDER BY key",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(
            params![PREFIX.len() as i64 + 1, PREFIX, PREFIX_END],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(failed)?;
    rows.map(|row| {
        let (note_id, value) = row.map_err(failed)?;
        Ok((note_id, parse(&value)))
    })
    .collect()
}

fn recorded(conn: &Connection, note_id: &str) -> Result<Option<Recorded>, StorageError> {
    let mut statement = conn
        .prepare_cached("SELECT value FROM meta WHERE key = ?1")
        .map_err(failed)?;
    let mut rows = statement
        .query(params![record_key(note_id)])
        .map_err(failed)?;
    match rows.next().map_err(failed)? {
        Some(row) => Ok(Some(parse(&row.get::<_, String>(0).map_err(failed)?))),
        None => Ok(None),
    }
}

fn parse(value: &str) -> Recorded {
    let version = match serde_json::from_str::<serde_json::Value>(value) {
        Ok(json) => json.get("version").and_then(serde_json::Value::as_u64),
        Err(error) => {
            return Recorded::Unreadable(format!("a record that does not parse: {error}"));
        }
    };
    match version {
        Some(RECORD_VERSION) => match serde_json::from_str::<Record>(value) {
            Ok(record) => Recorded::Move(PendingMove {
                old_path: record.old_path,
                new_path: record.new_path,
                title: record.title,
            }),
            Err(error) => {
                Recorded::Unreadable(format!("a version 1 record that does not parse: {error}"))
            }
        },
        Some(version) => Recorded::Unreadable(format!("a version {version} record")),
        None => Recorded::Unreadable("a record with no version".to_owned()),
    }
}

/// Forgets the note's record of the move from `old_path` to `new_path`: the file did not
/// move, went back, or the note followed it. Any other record of the note stays, and so does
/// one this build cannot read. True when one was forgotten.
pub fn abandon(
    conn: &Connection,
    note_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<bool, StorageError> {
    let names_it = matches!(
        recorded(conn, note_id)?,
        Some(Recorded::Move(recorded))
            if recorded.old_path == old_path && recorded.new_path == new_path
    );
    if names_it {
        conn.execute(
            "DELETE FROM meta WHERE key = ?1",
            params![record_key(note_id)],
        )
        .map_err(failed)?;
    }
    Ok(names_it)
}

/// The note's file is at `moved.new_path` now: record, row and slot follow it in one
/// transaction, which also forgets the note's record of this move ([`begin`], [`abandon`]).
/// An `Err` leaves all of it as it was.
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
    abandon(&tx, note_id, moved.old_path, moved.new_path)?;
    tx.commit().map_err(failed)
}
