//! Which note a vault file is (desktop Step 13d): the record half of the vault
//! tier's identity (`memry_desktop::vault::consumer::identity`). The tier owns
//! the `note_files` rows and asks here only about a file no row names, a
//! removed file and a moved file; nothing here reads or writes a file or a row.
//!
//! **A file gets a note id, and a push leaves, only on evidence.** A note id is
//! its sync item id and its CRDT document id on every device (chapter 07 §7.1),
//! so a file named by the wrong note, or a second id for one note, is a mistake
//! every device keeps. When the evidence is not here yet the answer is
//! [`Adopted::Deferred`], and the next open asks again. So:
//!
//! - a file no row names is first matched to a live markdown note that has no
//!   row and the file's folder and title, exactly: a record pulled before its
//!   file was written, or one a crash left between its create and its row
//!   ([`adopt`]). The match is the note only when its body (or, before it has a
//!   document, the `content` it was created with) is empty or already the file's
//!   text; a body owed a pull, or one this build cannot write out, defers. A
//!   tombstone never matches (a deleted note whose file comes back is a new
//!   note), nor a note that has a row (that note is another file), nor a file
//!   note (a PDF titled like the file);
//! - only then is a note created, with a fresh id and the file's dates, the way
//!   Electron's indexer gives a new outside file `generateNoteId()`;
//! - a vault Electron left beside its own database (`<vault>/.memry/data.db`)
//!   whose notes were not brought into the core gets no new id at all
//!   ([`Deferral::ElectronNotImported`]): its notes have Electron's ids, which
//!   only the import of Step 36 (#3553) carries over, and a fresh id for each of
//!   them would reach the server as a second copy of every note. The import
//!   marks its vault ([`ELECTRON_IMPORT_META_KEY`]). A core the app created over
//!   Electron's database is never imported (Step 36 answers `NativeFirst`), so
//!   it never mints there; a core created for a vault Electron never had, which
//!   Electron opened later, does ([`record_origin`]).
//!
//! Step 17 (#3534): a device that has not pulled the vault yet should hold
//! [`Adopted::Created`] until its first pull settles, since a record about to
//! arrive may name the file.
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
//! journal file to [`adopt`] and no move into or out of the journal folder to
//! [`renamed`], and a journal day's removal keeps its record ([`Removed::Kept`]).

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::Value;

use super::{ITEM_TYPE, NewNote, create_dated_in, edit_in, failed, tombstone_local};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::markdown_seed::body_is_empty;
use crate::crdt::registry::UpdateSink;
use crate::crdt::{BODY_FRAGMENT, epoch};
use crate::domain::external_feed::same_text;
use crate::domain::{journal, note_positions};
use crate::markdown::convert::api::Converter;
use crate::markdown::convert::restore::SerializeOptions;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::{body_debt, outbox};

/// The `meta` key the Electron import (Step 36, #3553) writes into the core
/// `data.db` of a vault it brought over, valued `{version: 1, importedAt,
/// tables}`.
pub const ELECTRON_IMPORT_META_KEY: &str = "electron_import.v1";

/// The `meta` key that says what the core `data.db` was created over:
/// `electron` when Electron's `data.db` was beside it, else `native`
/// ([`record_origin`]). Never rewritten.
pub const VAULT_ORIGIN_META_KEY: &str = "vault.origin.v1";

/// What a file says about the note it is.
#[derive(Debug, Clone, Copy)]
pub struct FileNote<'a> {
    /// Vault-relative, `/`-separated; relative links in a body resolve against it.
    pub path: &'a str,
    /// The file name without `.md`: the note's title, as Electron reads it.
    pub title: &'a str,
    /// The folder the file is in; `None` at the vault root.
    pub folder_path: Option<&'a str>,
    /// The file's markdown below its frontmatter block.
    pub body: &'a str,
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
    /// A live note that had no row, has the file's folder and title, and whose
    /// body is empty or already the file's text.
    Existing(String),
    /// A new note, created without a body.
    Created(String),
    /// Not now: nothing was written, and the next open asks again.
    Deferred(Deferral),
}

/// Why a file got no note yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Deferral {
    /// Electron's database is beside the core and its notes are not in it.
    ElectronNotImported,
    /// A note with the file's folder and title may be this file, and its body
    /// cannot say yet: owed a pull, or not one this build writes out whole. Or
    /// such a note appeared while the file was being asked about.
    Undecided,
}

/// What a vault's core database was created over ([`VAULT_ORIGIN_META_KEY`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Native,
    OverElectron,
}

/// What a removed file did to its note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removed {
    /// The note is deleted (now, or before).
    Deleted,
    /// The record stays: a journal day, which Step 13m decides.
    Kept,
}

/// Records what the core database was created over, once: the open that created
/// it calls this, and a value already there is kept.
pub fn record_origin(conn: &Connection, origin: Origin) -> Result<(), StorageError> {
    let value = match origin {
        Origin::Native => "native",
        Origin::OverElectron => "electron",
    };
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO NOTHING",
        params![VAULT_ORIGIN_META_KEY, value],
    )
    .map(drop)
    .map_err(failed)
}

/// Whether a note may be this file ([`adopt`] then needs a converter).
pub fn has_unfiled_note(
    conn: &Connection,
    title: &str,
    folder_path: Option<&str>,
) -> Result<bool, StorageError> {
    Ok(!unfiled_notes(conn, title, folder_path)?.is_empty())
}

/// The note of a file no row names: an existing note it is, or a new one with
/// `new_id`. One transaction, so a second file with the same folder and title,
/// asked right after, sees the note this one created. `converter` reads the
/// bodies of the notes the file may be; without one such a note defers.
pub fn adopt(
    conn: &Connection,
    converter: Option<&Converter>,
    file: &FileNote<'_>,
    new_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Adopted, CrdtError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    for id in unfiled_notes(&tx, file.title, file.folder_path)? {
        let Some(converter) = converter else {
            return Ok(Adopted::Deferred(Deferral::Undecided));
        };
        match body_says(&tx, converter, &id, file, device_id)? {
            Evidence::Same => return Ok(Adopted::Existing(id)),
            Evidence::Unknown => return Ok(Adopted::Deferred(Deferral::Undecided)),
            Evidence::Other => {}
        }
    }
    if file.electron_db_beside && !mints_beside_electron(&tx)? {
        return Ok(Adopted::Deferred(Deferral::ElectronNotImported));
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

/// The live markdown notes with this folder and title, exactly, that no
/// `note_files` row names, oldest first.
fn unfiled_notes(
    conn: &Connection,
    title: &str,
    folder_path: Option<&str>,
) -> Result<Vec<String>, StorageError> {
    let mut statement = conn
        .prepare_cached(
            "SELECT n.id FROM notes n
              WHERE n.deleted_at IS NULL AND n.title = ?1 AND n.folder_path IS ?2
                AND n.file_type = 'markdown'
                AND NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = n.id)
              ORDER BY n.created_at, n.id",
        )
        .map_err(failed)?;
    let ids = statement
        .query_map(params![title, folder_path], |row| row.get(0))
        .map_err(failed)?;
    ids.collect::<Result<_, _>>().map_err(failed)
}

enum Evidence {
    /// The note's body is empty, or already serializes to the file's text.
    Same,
    /// The note's body says something else: another note.
    Other,
    /// The body is not here to compare (owed a pull), or this build cannot
    /// write it out whole.
    Unknown,
}

/// What the note's body says about the file being that note.
fn body_says(
    conn: &Connection,
    converter: &Converter,
    note_id: &str,
    file: &FileNote<'_>,
    device_id: &str,
) -> Result<Evidence, CrdtError> {
    if body_debt::is_owed(conn, note_id)? {
        return Ok(Evidence::Unknown);
    }
    // Opened to read: nothing is authored, so the sink sees nothing.
    let sink: UpdateSink = Arc::new(|_, _: &[u8]| {});
    let document = epoch::open_for_write(conn, device_id, note_id, sink)?;
    let body = if body_is_empty(&document)? {
        // No document yet: the note's text is the `content` it was created with
        // (chapter 12 §12.2 carve-out A), until something seeds a document from it.
        created_content(conn, note_id)?
    } else {
        let options = SerializeOptions {
            note_path: Some(file.path),
            ..SerializeOptions::default()
        };
        match converter.serialize_note_body(&document, BODY_FRAGMENT, &options) {
            Some(body) => body.markdown,
            None => return Ok(Evidence::Unknown),
        }
    };
    let markdown = file.body.strip_prefix('\u{feff}').unwrap_or(file.body);
    Ok(if body.is_empty() || same_text(&body, markdown) {
        Evidence::Same
    } else {
        Evidence::Other
    })
}

/// The `content` of the note's stored payload: the text it was created with.
fn created_content(conn: &Connection, note_id: &str) -> Result<String, StorageError> {
    let payload = sync_items::push_payload(conn, ITEM_TYPE, note_id)?;
    let content = payload
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|payload| payload.get("content")?.as_str().map(str::to_owned));
    Ok(content.unwrap_or_default())
}

/// Whether a new note id may be minted beside Electron's database: the import
/// brought Electron's notes into the core, or the core was created for a vault
/// that was not Electron's. A core from before its origin was recorded counts as
/// native once a file was named in it.
fn mints_beside_electron(conn: &Connection) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)
             OR COALESCE((SELECT value = 'native' FROM meta WHERE key = ?2),
                         EXISTS (SELECT 1 FROM note_files))",
        params![ELECTRON_IMPORT_META_KEY, VAULT_ORIGIN_META_KEY],
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
