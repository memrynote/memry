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
//!   text. A match whose body says something else defers rather than mints:
//!   Electron keys a note by its path, so the file may be that note at another
//!   version, and a second id for it would be a second copy on every device. A
//!   body owed a pull, or one this build cannot write out, defers too. A
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
//!   Electron opened later, does ([`record_origin`]). A core whose origin is not
//!   recorded mints nothing beside Electron's database either.
//!
//! Step 17 (#3534): a device that has not pulled the vault yet should hold
//! [`Adopted::Created`] until its first pull settles, since a record about to
//! arrive may name the file.
//!
//! **A removed file deletes its note once, and the record goes first** ([`removed`]).
//! The tier removes the row only after this answered, so a local-only note's
//! flag is still there for [`crate::sync::outbox::enqueue`] to keep its
//! tombstone off the server. Asked again for a note already deleted (a crash
//! before the row went), it deletes nothing more and queues nothing. A tombstone
//! deletes the note on every device, so the removal deletes it only on the
//! row's evidence that nothing but the file goes ([`removal_deletes`]): the row
//! knows the bytes on disk, which a move of the file pairs on, so the removal is
//! not a move; the document holds those bytes; no edit came after the row's
//! stamp, so the file had every edit; and no body is owed a pull. Otherwise the
//! note is kept ([`Removed::Undecided`]).
//!
//! **A moved file moves its note's record, not the links to it** ([`renamed`]):
//! the title and folder follow the file, in one edit, with the note's manual
//! order updated in the same transaction. Electron's watcher
//! rewrites no inbound `[[link]]` on a rename made outside the app, and neither
//! does this: the app's own rename (Step 13g) does. A move the tier cannot tell
//! the meaning of yet leaves the record where it was and owes it the move
//! ([`owe_place`]); [`owed_places`] lists them for when it can.
//!
//! Journal days (Step 13m): a file that names a day is the day's
//! ([`super::journal_day`]), and the tier passes no such file to [`adopt`]. A
//! removed day file deletes its day on the same evidence as a note's
//! ([`removed`]). A day's move within its day changes no record ([`renamed`]):
//! a day's path is never synced; a move that changes what the file is (a note
//! into a day, a day out of it, or to another day) is owed by the tier.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::Value;

use super::{ITEM_TYPE, NewNote, create_dated_in, edit_in, failed, iso, tombstone_local};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::markdown_seed::body_is_empty;
use crate::crdt::registry::UpdateSink;
use crate::crdt::{BODY_FRAGMENT, epoch};
use crate::domain::external_feed::same_text;
use crate::domain::{journal, note_files, note_positions, owed_file_body};
use crate::markdown::convert::EmbedResolver;
use crate::markdown::convert::api::Converter;
use crate::markdown::convert::restore::SerializeOptions;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::{body_debt, outbox};

/// The `meta` key the Electron import (Step 36, #3553) writes into the core
/// `data.db` of a vault it brought over, valued `{version: 1, importedAt,
/// tables}`.
pub const ELECTRON_IMPORT_META_KEY: &str = "electron_import.v1";

/// The `meta` key that says what the core `data.db` was created over:
/// `electron` when Electron's `data.db` was beside it when it was first
/// recorded, else `native` ([`record_origin`]). Never rewritten.
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
    /// A new record, created without a body; or a deleted journal day revived, whose body is
    /// empty or already the file's text ([`super::journal_day::adopt_day`]).
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
    /// does not say it is: the body is another text, is owed a pull, or is not
    /// one this build writes out whole. Or such a note appeared while the file
    /// was being asked about.
    Undecided,
}

/// What a vault's core database was created over ([`VAULT_ORIGIN_META_KEY`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Native,
    OverElectron,
}

/// What a removed file did to its note or journal day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Removed {
    /// The note or day is deleted (now, or before).
    Deleted,
    /// The record stays: the row cannot tell this removal from a move, or the
    /// note holds what its file did not ([`removal_deletes`]).
    Undecided,
}

/// Records what the core database was created over, once: every open calls this,
/// so one that failed is retried, and a value already there is kept.
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
/// `embeds` resolves the file's image embeds (`![[target]]`) as the feed did, so
/// a body that holds them writes out as the file's text; it must not read this
/// database.
pub fn adopt(
    conn: &Connection,
    converter: Option<&Converter>,
    embeds: Option<&dyn EmbedResolver>,
    file: &FileNote<'_>,
    new_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Adopted, CrdtError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let candidates = unfiled_notes(&tx, file.title, file.folder_path)?;
    if !candidates.is_empty() {
        let Some(converter) = converter else {
            return Ok(Adopted::Deferred(Deferral::Undecided));
        };
        // The oldest note whose body is the file's, unless one may be and cannot say.
        let mut same = None;
        for id in candidates {
            let text = (file.path, file.body);
            match body_says(&tx, converter, embeds, ITEM_TYPE, &id, text, device_id)? {
                Evidence::Same => {
                    same.get_or_insert(id);
                }
                Evidence::Unknown => return Ok(Adopted::Deferred(Deferral::Undecided)),
                Evidence::Other => {}
            }
        }
        return Ok(same.map_or(Adopted::Deferred(Deferral::Undecided), Adopted::Existing));
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
    // A date no record can carry (a corrupt far-future time) is the creation's: refused, the
    // file would be asked about at every open, and never named.
    let carried = |ms: i64| if iso(ms).is_ok() { ms } else { now_ms };
    create_dated_in(
        &tx,
        &note,
        device_id,
        now_ms,
        (carried(file.created_ms), carried(file.modified_ms)),
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
    let mut statement = conn.prepare_cached(UNFILED_NOTES).map_err(failed)?;
    let ids = statement
        .query_map(params![title, folder_path], |row| row.get(0))
        .map_err(failed)?;
    ids.collect::<Result<_, _>>().map_err(failed)
}

/// Asked once per file no row names: `idx_notes_live_title` (data migration 18)
/// answers it.
pub(crate) const UNFILED_NOTES: &str = "SELECT n.id FROM notes n
  WHERE n.deleted_at IS NULL AND n.title = ?1 AND n.folder_path IS ?2
    AND n.file_type = 'markdown'
    AND NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = n.id)
  ORDER BY n.created_at, n.id";

pub(super) enum Evidence {
    /// The note's body is empty, or already serializes to the file's text.
    Same,
    /// The note's body says something else: the file may be another note, or
    /// this one at another version.
    Other,
    /// The body is not here to compare (owed a pull), or this build cannot
    /// write it out whole.
    Unknown,
}

/// What the body of `note_id`, a record of `item_type`, says about the file at `path` whose
/// markdown below its frontmatter is `body` being that record.
pub(super) fn body_says(
    conn: &Connection,
    converter: &Converter,
    embeds: Option<&dyn EmbedResolver>,
    item_type: &str,
    note_id: &str,
    (path, file_body): (&str, &str),
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
        created_content(conn, item_type, note_id)?
    } else {
        let options = SerializeOptions {
            note_path: Some(path),
            embeds,
            ..SerializeOptions::default()
        };
        match converter.serialize_note_body(&document, BODY_FRAGMENT, &options) {
            Some(body) => body.markdown,
            None => return Ok(Evidence::Unknown),
        }
    };
    let markdown = file_body.strip_prefix('\u{feff}').unwrap_or(file_body);
    Ok(if body.is_empty() || same_text(&body, markdown) {
        Evidence::Same
    } else {
        Evidence::Other
    })
}

/// The `content` of the record's stored payload: the text it was created with.
fn created_content(
    conn: &Connection,
    item_type: &str,
    note_id: &str,
) -> Result<String, StorageError> {
    let payload = sync_items::push_payload(conn, item_type, note_id)?;
    let content = payload
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|payload| payload.get("content")?.as_str().map(str::to_owned));
    Ok(content.unwrap_or_default())
}

/// Whether a new note id may be minted beside Electron's database: the import
/// brought Electron's notes into the core, or the core is recorded as created
/// for a vault that was not Electron's. Nothing recorded is not evidence.
pub(super) fn mints_beside_electron(conn: &Connection) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1)
             OR EXISTS (SELECT 1 FROM meta WHERE key = ?2 AND value = 'native')",
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
/// slot is dropped and the new folder orders it as any unplaced note. A move the
/// record was owed ([`owe_place`]) is settled: the title and folder are compared
/// with the record, which still describes the owed path, and the slot is counted
/// from `old_path`, the row's, since owing dropped the owed path's slot. A note
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
    settle_place(&tx, note_id)?;
    tx.commit().map_err(failed)
}

/// A move of the note's file from `from_path` that the record was not given
/// ([`renamed`] was not called): owed until it is. The first path is kept, since
/// the record still describes it. The note's slot at `from_path` is dropped, as a
/// move to another folder drops it: the path is free, and a file that comes to
/// it takes it with no slot of this note's.
pub fn owe_place(
    conn: &Connection,
    note_id: &str,
    from_path: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    tx.execute(
        "INSERT INTO note_place_owed (note_id, from_path, marked_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(note_id) DO NOTHING",
        params![note_id, from_path, now_ms],
    )
    .map_err(failed)?;
    note_positions::remove(&tx, from_path)?;
    tx.commit().map_err(failed)
}

/// A move the record is owed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwedPlace {
    pub note_id: String,
    /// The path the record still describes.
    pub from_path: String,
    /// Where the note's row is now.
    pub path: String,
}

/// The moves the records are owed, for the notes that still have a row, oldest
/// first. A note whose row is gone owes nothing more, and its debt is dropped.
pub fn owed_places(conn: &Connection) -> Result<Vec<OwedPlace>, StorageError> {
    conn.execute(
        "DELETE FROM note_place_owed
          WHERE NOT EXISTS (SELECT 1 FROM note_files f WHERE f.note_id = note_place_owed.note_id)",
        [],
    )
    .map_err(failed)?;
    let mut statement = conn
        .prepare_cached(
            "SELECT o.note_id, o.from_path, f.path FROM note_place_owed o
               JOIN note_files f ON f.note_id = o.note_id
              ORDER BY o.marked_at, o.note_id",
        )
        .map_err(failed)?;
    let owed = statement
        .query_map([], |row| {
            Ok(OwedPlace {
                note_id: row.get(0)?,
                from_path: row.get(1)?,
                path: row.get(2)?,
            })
        })
        .map_err(failed)?;
    owed.collect::<Result<_, _>>().map_err(failed)
}

fn settle_place(conn: &Connection, note_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM note_place_owed WHERE note_id = ?1",
        params![note_id],
    )
    .map(drop)
    .map_err(failed)
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
    let live = if live_place(&tx, note_id)?.is_some() {
        Some(ITEM_TYPE)
    } else if live_day(&tx, note_id)? {
        Some(journal::ITEM_TYPE)
    } else {
        None
    };
    if let Some(item_type) = live {
        if !removal_deletes(&tx, note_id)? {
            return Ok(Removed::Undecided);
        }
        tombstone_local(&tx, item_type, note_id, device_id, now_ms)?;
        outbox::enqueue(&tx, &outbox::Change::delete(item_type, note_id), now_ms)?;
    }
    note_positions::remove(&tx, path)?;
    settle_place(&tx, note_id)?;
    tx.commit().map_err(failed)?;
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
