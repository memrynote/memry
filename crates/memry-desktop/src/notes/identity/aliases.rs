//! What a vault file's frontmatter `aliases` give its record on an edit outside the app (#5599).
//!
//! Invariant: **the file owns a note's or a journal day's names**. Every edit of the file reaches
//! the record's `aliases`: one in the app through `notes:edit-aliases` (`notes/aliases.rs`), one
//! outside it here, the list taken whole as desktop's watcher takes it (`extractAliases` in
//! `vault/note-sync.ts` and `vault/journal.ts`). An alias the record lacks is pushed with it, so
//! a pull of that record never writes it out of the file, and it resolves wiki-links. The core
//! normalizes the list against the title or the day's date, and an unchanged list writes nothing,
//! so a body edit queues no push ([`NotesWriter::file_aliases`]).

use memry_core::api::notes_write::NotesWriter;
use memry_core::markdown::frontmatter::{YamlValue, gray_matter_data};

use super::SCOPE;
use crate::notes::frontmatter::aliases;
use crate::vault::consumer::identity::IdentityError;
use crate::vault::note_file::NoteFile;

/// An edit outside the app replaced the file of the note or day `note_id`: its record takes the
/// file's `aliases`. A frontmatter that does not parse, or is not a map, says nothing of them:
/// the record stays as it was.
pub(super) fn edited(
    writer: &NotesWriter,
    note_id: &str,
    file: &NoteFile,
) -> Result<(), IdentityError> {
    let names = match file.split().block.map(gray_matter_data) {
        None | Some(Ok(YamlValue::Null)) => Vec::new(),
        Some(Ok(YamlValue::Map(map))) => aliases(&map),
        Some(_) => {
            tracing::info!(
                scope = SCOPE,
                note_id,
                "an outside edit's frontmatter does not read as a map; the record keeps its aliases"
            );
            return Ok(());
        }
    };
    if !writer.file_aliases(note_id, &names)? {
        tracing::warn!(
            scope = SCOPE,
            note_id,
            "an outside edit's aliases were not taken: no live note or day"
        );
    }
    Ok(())
}
