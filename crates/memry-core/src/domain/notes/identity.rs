//! Which note a vault file is (desktop Step 13d): the record half of the vault
//! tier's identity (`memry_desktop::vault::consumer::identity`). The tier owns
//! the `note_files` rows and asks here only about a file no row names, a
//! removed file and a moved file; nothing here reads or writes a file or a row.
//!
//! **A note id is never minted for a note that already has one.** A note id is
//! its sync item id and its CRDT document id on every device (chapter 07 §7.1),
//! so a second id for one note is a duplicate every device keeps. So:
//!
//! - a file no row names is first matched to a live note that has no row and
//!   the file's folder and title ([`adopt`]): a record pulled before its file
//!   was written, or one a crash left between its create and its row. A
//!   tombstoned note is never matched (a deleted note whose file comes back is
//!   a new note), nor a note that has a row (that note is another file);
//! - only then is a note created, with a fresh id and the file's dates, the way
//!   Electron's indexer gives a new outside file `generateNoteId()`;
//! - a vault Electron left beside its own database (`<vault>/.memry/data.db`)
//!   whose notes were not brought into the core gets no new id at all
//!   ([`Adopted::Withheld`]): its notes have Electron's ids, which only the
//!   import of Step 36 (#3553) carries over. A fresh id for each of them would
//!   reach the server as a second copy of every note once sync runs. The
//!   import marks its vault with [`ELECTRON_IMPORT_META_KEY`]; a vault with any
//!   note record (imported, pulled, or created here) is past that point too.
//!
//! **A removed file deletes its note once, and the record goes first** ([`removed`]).
//! The tier removes the row only after this answered, so a local-only note's
//! flag is still there for [`crate::sync::outbox::enqueue`] to keep its
//! tombstone off the server. Asked again for a note already deleted (a crash
//! before the row went), it deletes nothing more and queues nothing.
//!
//! **A moved file moves its note's record, not the links to it** ([`renamed`]):
//! the title and folder follow the file, in one edit, with the note's manual
//! order updated in the same transaction. Electron's watcher
//! rewrites no inbound `[[link]]` on a rename made outside the app, and neither
//! does this: the app's own rename (Step 13g) does.
//!
//! Journal days are not decided here before Step 13m: the tier passes no
//! journal file to [`adopt`], and a journal day's removal keeps its record
//! ([`Removed::Kept`]).

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::Value;

use super::{ITEM_TYPE, NewNote, create_dated_in, edit_in, failed, tombstone_local};
use crate::api::errors::StorageError;
use crate::domain::{journal, note_positions};
use crate::storage::repositories::Change;
use crate::sync::outbox;

/// The `meta` key the Electron import (Step 36, #3553) writes into the core
/// `data.db` of a vault it brought over, valued `{version: 1, importedAt,
/// tables}`.
pub const ELECTRON_IMPORT_META_KEY: &str = "electron_import.v1";

/// What a file says about the note it is.
#[derive(Debug, Clone, Copy)]
pub struct FileNote<'a> {
    /// The file name without `.md`: the note's title, as Electron reads it.
    pub title: &'a str,
    /// The folder the file is in; `None` at the vault root.
    pub folder_path: Option<&'a str>,
    /// When the file was created, for a new note's `createdAt`.
    pub created_ms: i64,
    /// When the file was last modified, for a new note's `modifiedAt`.
    pub modified_ms: i64,
    /// `<vault>/.memry/data.db` of Electron is beside the core's database.
    pub electron_db_beside: bool,
}

/// The note a file is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Adopted {
    /// A live note that had no row and has the file's folder and title.
    Existing(String),
    /// A new note, created without a body.
    Created(String),
    /// No note has this file, and none may be created: an Electron vault whose
    /// notes were not imported.
    Withheld,
}

/// What a removed file did to its note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removed {
    /// The note is deleted (now, or before).
    Deleted,
    /// The record stays: a journal day, which Step 13m decides.
    Kept,
}

/// The note of a file no row names: an existing note it belongs to, or a new
/// one with `new_id`. One transaction, so a second file with the same folder
/// and title, asked right after, sees the note this one created.
pub fn adopt(
    conn: &Connection,
    file: &FileNote<'_>,
    new_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Adopted, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let Some(id) = unfiled_note(&tx, file.title, file.folder_path)? {
        return Ok(Adopted::Existing(id));
    }
    if file.electron_db_beside && !past_electron(&tx)? {
        return Ok(Adopted::Withheld);
    }
    let note = NewNote {
        id: new_id,
        title: file.title,
        folder_path: file.folder_path,
        content: "",
        tags: &[],
        properties: None,
        emoji: None,
    };
    create_dated_in(
        &tx,
        &note,
        device_id,
        now_ms,
        (file.created_ms, file.modified_ms),
    )?;
    outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, new_id), now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(Adopted::Created(new_id.to_owned()))
}

/// The oldest live note with this folder and title that no `note_files` row
/// names.
fn unfiled_note(
    conn: &Connection,
    title: &str,
    folder_path: Option<&str>,
) -> Result<Option<String>, StorageError> {
    conn.query_row(
        "SELECT n.id FROM notes n
          WHERE n.deleted_at IS NULL AND n.title = ?1 AND n.folder_path IS ?2
            AND NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = n.id)
          ORDER BY n.created_at, n.id
          LIMIT 1",
        params![title, folder_path],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

/// Whether the vault's notes are in the core already: the Electron import ran,
/// or the vault holds a note record of any kind.
fn past_electron(conn: &Connection) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)
             OR EXISTS (SELECT 1 FROM notes)",
        params![ELECTRON_IMPORT_META_KEY],
        |row| row.get(0),
    )
    .map_err(failed)
}

/// Where a moved file now is.
#[derive(Debug, Clone, Copy)]
pub struct Moved<'a> {
    pub old_path: &'a str,
    pub new_path: &'a str,
    /// The new file name without `.md`.
    pub title: &'a str,
    /// The new folder; `None` at the vault root.
    pub folder_path: Option<&'a str>,
}

/// The note's file moved: the record takes the new title and folder. Renamed in
/// its folder, the note keeps its manual slot; moved to another folder, its old
/// slot is dropped and the new folder orders it as any unplaced note. A note
/// that is not live (a journal day, a deleted note) keeps its record as it is.
pub fn renamed(
    conn: &Connection,
    note_id: &str,
    moved: &Moved<'_>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let Some((title, folder)) = live_place(&tx, note_id)? {
        let mut changes = Vec::new();
        if title != moved.title {
            changes.push(("title", Change::set(moved.title)));
        }
        if folder.as_deref() != moved.folder_path {
            let folder = moved
                .folder_path
                .map_or(Value::Null, |path| Value::String(path.to_owned()));
            changes.push(("folderPath", Change::Set(folder)));
        }
        if !changes.is_empty() {
            edit_in(&tx, ITEM_TYPE, note_id, changes, device_id, now_ms)?;
            outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, note_id), now_ms)?;
        }
    }
    if folder_of(moved.old_path) == folder_of(moved.new_path) {
        note_positions::carry(&tx, moved.old_path, moved.new_path)?;
    } else {
        note_positions::remove(&tx, moved.old_path)?;
    }
    tx.commit().map_err(failed)
}

fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

/// A live note's title and folder.
fn live_place(
    conn: &Connection,
    note_id: &str,
) -> Result<Option<(String, Option<String>)>, StorageError> {
    conn.query_row(
        "SELECT title, folder_path FROM notes WHERE id = ?1 AND deleted_at IS NULL",
        params![note_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .map_err(failed)
}

/// The note's file at `path` is gone: the note is deleted and its manual order
/// dropped, in one transaction. A note deleted before is answered `Deleted`
/// again with nothing written; a journal day keeps its record.
pub fn removed(
    conn: &Connection,
    note_id: &str,
    path: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Removed, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if live_place(&tx, note_id)?.is_some() {
        tombstone_local(&tx, ITEM_TYPE, note_id, device_id, now_ms)?;
        outbox::enqueue(&tx, &outbox::Change::delete(ITEM_TYPE, note_id), now_ms)?;
    } else if is_journal_day(&tx, note_id)? {
        return Ok(Removed::Kept);
    }
    note_positions::remove(&tx, path)?;
    tx.commit().map_err(failed)?;
    Ok(Removed::Deleted)
}

/// A journal day's record, or a journal day's id (`j<YYYY-MM-DD>`).
fn is_journal_day(conn: &Connection, id: &str) -> Result<bool, StorageError> {
    if id
        .strip_prefix('j')
        .is_some_and(|date| journal::valid_date(date).is_ok())
    {
        return Ok(true);
    }
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM journal_entries WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )
    .map_err(failed)
}
