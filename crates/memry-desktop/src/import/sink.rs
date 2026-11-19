//! [`ImportSink`]: every write an importer makes.
//!
//! An importer parses what the person picked and decides what to create. It never writes SQL
//! or vault files: it hands each write to the sink. Electron's importers called
//! `createImportedNote`, `saveAttachment` and `generateNoteId` directly; the sink gathers
//! those seams into one trait, so the same importer runs against two implementations:
//!
//! - the production sink (stage 32h2), over `NotesService::create`, `attachments::save` and
//!   the tasks service. It owns `createImportedNote`'s checklist step: a `- [ ] ...` line of a
//!   note's body becomes a task before the note is written
//!   (`apps/desktop/src/main/import/_shared/imported-note.ts`). An importer passes the body as
//!   it built it.
//! - a recording sink in the tests, which mints ids from a counter and records every call. The
//!   importer vectors (`packages/contracts/test-vectors/importers/`) are those recordings, made
//!   by the TypeScript importers with the same seams mocked.
//!
//! The trait grows with the importers that need more writes (journal entries, tasks and
//! projects, inbox links): each later stage adds the method it uses, with a default only when
//! a no-op is a correct answer.

use memry_core::markdown::frontmatter::YamlMap;

use crate::attachments::SavedAttachment;

/// A refused write, shown to the person as the failed item's error or the skip reason.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct SinkError(pub String);

/// `NoteCreateInput` as an importer fills it in.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportedNote {
    /// An id from [`ImportSink::new_note_id`] when attachments were saved under it first;
    /// `None` lets the sink mint one.
    pub id: Option<String>,
    pub title: String,
    pub content: String,
    /// Vault-relative folder with `/` separators; `None` is the default notes folder.
    pub folder: Option<String>,
    pub tags: Vec<String>,
    /// Frontmatter properties in the order they are written. A value keeps its YAML type: a
    /// date stays a date, as gray-matter's `Date` did.
    pub properties: YamlMap,
    /// ISO 8601 instants of the source file, when it has them.
    pub created: Option<String>,
    pub modified: Option<String>,
}

/// The writes of one import run. Called from the blocking thread the runner runs the importer
/// on, one call at a time.
pub trait ImportSink: Send + Sync {
    /// Mints the id a note will be created under (`generateNoteId`), so its attachments can be
    /// saved before the note exists and the note is written once, with its final body.
    fn new_note_id(&self) -> String;

    /// `saveAttachment(noteId, bytes, fileName)`: stores `bytes` in the note's attachments
    /// folder. `Err` is a refused file (its type, its size), which the importer reports as a
    /// skipped item and the import goes on.
    fn save_attachment(
        &self,
        note_id: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<SavedAttachment, SinkError>;

    /// `createImportedNote`: creates the note. `Err` fails that item; the import goes on.
    fn create_note(&self, note: ImportedNote) -> Result<(), SinkError>;

    /// Runs once after the importer returned, before the runner reports `done`: the production
    /// sink waits for the index to hold every note it wrote (`flushProjectionEvents`), so a
    /// refetch after the import sees them.
    fn finish(&self) {}
}
