//! A large-file class markdown file no row names (over 1 MiB, or a block over 128 KiB,
//! `markdown::shared::markdown_class`) made a note the way Electron lists it
//! (`backfillLargeFile` and `syncLargeFileBodyToCache`, `vault/ingest-backfill.ts`): a
//! record with the file's place and dates and no body, read-only in the large-file viewer.
//!
//! **Never queued.** Electron neither syncs such a file nor seeds a CRDT document for it
//! (`syncNoteCreate` returns on `sizeClass: 'large-file'`, `notes/runtime-effects.ts`), so
//! this writes no outbox row: the server would hold a record whose body never comes. A later
//! edit of the record (a move, a rename in the app) queues it as any record edit does, as
//! Electron's `enqueueUpdate` does.
//!
//! The file's body is never read here, as Electron never parses it, so a live note no row
//! names with the file's folder and title, which only a body compare tells from the file
//! ([`super::identity::adopt`]), defers, unless it is bare ([`is_bare`]): no text to tell, as
//! a crash between this create and its row leaves it. The rest is a grown note's: the vault
//! tier records the class (`note_large_files`), the feed refuses the text and the file owes
//! its body, and the editor opens the document read-only.
//!
//! When the file shrinks under the class, the note is any other: [`left_class`] queues its
//! record ahead of the body the feed then gives it.

use rusqlite::Connection;

use super::identity::{
    Adopted, Deferral, FileNote, created_content, live_place, mints_beside_electron, unfiled_notes,
};
use super::new_files::create_unqueued;
use super::{ITEM_TYPE, failed};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::crdt::update_log;
use crate::sync::{body_debt, outbox};

/// The note of the large-file class `file` no row names: a new record with `new_id` and no
/// outbox row, or deferred. One transaction. `file.body` is not read.
pub fn adopt_large(
    conn: &Connection,
    file: &FileNote<'_>,
    new_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Adopted, CrdtError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let candidates = unfiled_notes(&tx, file.title, file.folder_path)?;
    if !candidates.is_empty() {
        let mut bare = None;
        for id in candidates {
            if !is_bare(&tx, &id)? {
                return Ok(Adopted::Deferred(Deferral::Undecided));
            }
            bare.get_or_insert(id);
        }
        return Ok(bare.map_or(Adopted::Deferred(Deferral::Undecided), Adopted::Existing));
    }
    if file.electron_db_beside && !mints_beside_electron(&tx)? {
        return Ok(Adopted::Deferred(Deferral::ElectronNotImported));
    }
    create_unqueued(&tx, file, new_id, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(Adopted::Created(new_id.to_owned()))
}

/// Whether the note has no text anywhere: no document, an empty `content` and no body owed a
/// pull. A large file's note is one until its file shrinks; a removal or a claim of it loses
/// nothing.
pub(super) fn is_bare(conn: &Connection, note_id: &str) -> Result<bool, CrdtError> {
    Ok(!body_debt::is_owed(conn, note_id)?
        && update_log::load_plan(conn, note_id)?.is_empty()
        && created_content(conn, ITEM_TYPE, note_id)?.is_empty())
}

/// The note's file left the large-file class: its record is queued, ahead of the body the feed
/// gives it next, as a new note's is ([`super::new_files`]). A large file's note never queued
/// it; one that did queues the same record again. Nothing for a note that is not live.
pub fn left_class(conn: &Connection, note_id: &str, now_ms: i64) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if live_place(&tx, note_id)?.is_none() {
        return Ok(());
    }
    outbox::enqueue(&tx, &outbox::Change::upsert(ITEM_TYPE, note_id), now_ms)?;
    tx.commit().map_err(failed)
}
