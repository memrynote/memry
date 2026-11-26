//! A large-file class markdown file no row names is a read-only note of this device, as
//! Electron lists it (`backfillLargeFile`, `vault/ingest-backfill.ts`): the core creates its
//! record and queues no push ([`NotesWriter::adopt_large_file`]), and the consumer then records
//! the class and offers the text to the feed, which refuses it, as for a note that grew into
//! the class. The app opens it in the large-file viewer (`notes::read`). Its body is never
//! parsed: no tags or properties reach the record, as Electron keeps none for it. Its
//! frontmatter `aliases` do, as every first-named file's do ([`aliases::found`]), and a newer
//! record's names are written into its `aliases` key (`vault::writeback`, #5825).
//!
//! Once its file shrinks under the class, it is a new note's file ([`left`]). Its file's
//! removal deletes it while it has no text anywhere (`large_file::is_bare`).
//!
//! A day's path stays unnamed for now (Electron lists it as that day's entry): a day's record
//! is made from its body (`adopt_day`), which this never reads.

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::identity::{Adopted, FileNote};

use super::{NotesIdentity, SCOPE, aliases, created_ms, electron_db_beside, place, properties};
use crate::vault::consumer::identity::{Adoption, Candidate, IdentityCtx, IdentityError};
use crate::vault::journal_format::JournalDays;
use crate::vault::note_file::NoteFile;

pub(super) fn adopt(
    identity: &NotesIdentity,
    ctx: &IdentityCtx<'_>,
    writer: &NotesWriter,
    journal: &JournalDays,
    file: &Candidate<'_>,
) -> Result<Adoption, IdentityError> {
    if journal.day_of(file.path).is_some() {
        tracing::debug!(
            scope = SCOPE,
            "a large-file class file at a day's path is not named"
        );
        return Ok(Adoption::Defer);
    }
    let (folder_path, title) = place(file.path);
    let note = FileNote {
        path: file.path,
        title,
        folder_path,
        body: "",
        created_ms: created_ms(&ctx.root.join(file.path)).unwrap_or(file.modified_ms),
        modified_ms: file.modified_ms,
        electron_db_beside: electron_db_beside(ctx.root),
    };
    let adopted = writer
        .adopt_large_file(note)
        .map_err(|error| IdentityError::Other(error.to_string()))?;
    let mut owes_file = false;
    if let (Adopted::Created(id) | Adopted::Existing(id), Some(text)) = (&adopted, file.file) {
        let matched = matches!(adopted, Adopted::Existing(_)).then_some(file.modified_ms);
        // A strictly newer record that keeps its names owes them to the file: the write-back
        // writes its `aliases` key alone and copies the body it does not hold byte for byte
        // (#5825). Until then, the debt keeps the names when the file leaves the class ([`left`]).
        owes_file = aliases::found(writer, id, text, matched);
    }
    Ok(match identity.adoption(adopted, ctx.root, file.path) {
        Adoption::Existing(id) if owes_file => Adoption::ExistingNewer(id),
        adoption => adoption,
    })
}

/// The note's file left the class: its record is queued ahead of the body the feed gives it
/// next, and takes the file's property values, as a new note's file gives them
/// ([`properties::found`]), and its aliases as a matched file's, the file read as a note's for
/// the first time: a record modified after the file, `modified_ms`, keeps its names
/// ([`aliases::found`]), as does a record whose names the file owed since it was adopted and
/// still holds the list it had then. `true` when it did: the file owes them, and the consumer
/// has the write-back write its `aliases` key.
pub(super) fn left(
    identity: &NotesIdentity,
    ctx: &IdentityCtx<'_>,
    note_id: &str,
    file: &NoteFile,
    modified_ms: i64,
) -> Result<bool, IdentityError> {
    let writer = identity.writer(ctx)?;
    writer.large_file_left(note_id)?;
    let owes_file = aliases::found(&writer, note_id, file, Some(modified_ms));
    properties::found(&writer, ctx, identity.store.clone(), note_id, file)?;
    Ok(owes_file)
}
