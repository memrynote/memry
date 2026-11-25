//! What a vault file's frontmatter `aliases` give its record: on an edit outside the app (#5599),
//! and when the tier first names the file, as a new file or in the open's walk (#5783).
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

/// The `aliases` a file's frontmatter declares: none without a block or in an empty one, and
/// `None` for a block that does not parse or is not a map, which says nothing of them.
fn of_file(file: &NoteFile) -> Option<Vec<String>> {
    match file.split().block.map(gray_matter_data) {
        None | Some(Ok(YamlValue::Null)) => Some(Vec::new()),
        Some(Ok(YamlValue::Map(map))) => Some(aliases(&map)),
        Some(_) => None,
    }
}

/// The tier first named the file of the note or day `id`: its record takes the file's
/// `aliases`, as desktop's indexer gives a found file's record (`syncNoteToCache`). A file that
/// declares none, or whose frontmatter does not read, takes nothing from the record: a record
/// the file matched (`Adopted::Existing`) keeps the names it holds.
pub(super) fn found(writer: &NotesWriter, id: &str, file: &NoteFile) {
    let Some(names) = of_file(file).filter(|names| !names.is_empty()) else {
        return;
    };
    match writer.file_aliases(id, &names) {
        Ok(true) => {}
        Ok(false) => tracing::warn!(
            scope = SCOPE,
            note_id = id,
            "a found file's aliases were not taken: no live note or day"
        ),
        Err(error) => tracing::warn!(
            scope = SCOPE,
            note_id = id,
            "a found file's aliases were not taken: {error}"
        ),
    }
}

/// An edit outside the app replaced the file of the note or day `note_id`: its record takes the
/// file's `aliases`. A frontmatter that does not parse, or is not a map, says nothing of them:
/// the record stays as it was.
pub(super) fn edited(
    writer: &NotesWriter,
    note_id: &str,
    file: &NoteFile,
) -> Result<(), IdentityError> {
    let names = match of_file(file) {
        Some(names) => names,
        None => {
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
