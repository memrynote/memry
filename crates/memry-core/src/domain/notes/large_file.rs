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
//! ([`super::identity::adopt`]), defers. The rest is a grown note's: the vault tier records
//! the class (`note_large_files`), the feed refuses the text and the file owes its body, and
//! the editor opens the document read-only.

use rusqlite::Connection;

use super::failed;
use super::identity::{Adopted, Deferral, FileNote, mints_beside_electron, unfiled_notes};
use super::new_files::create_unqueued;
use crate::crdt::errors::CrdtError;

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
    if !unfiled_notes(&tx, file.title, file.folder_path)?.is_empty() {
        return Ok(Adopted::Deferred(Deferral::Undecided));
    }
    if file.electron_db_beside && !mints_beside_electron(&tx)? {
        return Ok(Adopted::Deferred(Deferral::ElectronNotImported));
    }
    create_unqueued(&tx, file, new_id, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(Adopted::Created(new_id.to_owned()))
}
