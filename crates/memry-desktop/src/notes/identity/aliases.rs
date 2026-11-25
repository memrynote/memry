//! What a vault file's frontmatter `aliases` give its record: on an edit outside the app (#5599),
//! and when the tier first names the file, as a new file or in the open's walk (#5783).
//!
//! Invariant: **the file owns a note's or a journal day's names**. Every edit of the file reaches
//! the record's `aliases`: one in the app through `notes:edit-aliases` (`notes/aliases.rs`), one
//! outside it here, the list taken whole as desktop's watcher takes it (`extractAliases` in
//! `vault/note-sync.ts` and `vault/journal.ts`). An alias the record lacks is pushed with it, so
//! a pull of that record never writes it out of the file, and it resolves wiki-links. The core
//! normalizes the list against the title or the day's date, and an unchanged list writes nothing,
//! so a body edit queues no push ([`NotesWriter::file_aliases`]). A file that owes its record's
//! names ([`memry_core::domain::owed_file_aliases`]) answers with the record's list until it
//! holds it or its own list changes.

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::{EditedAliases, MatchedAliases};
use memry_core::markdown::frontmatter::{YamlValue, gray_matter_data};

use super::SCOPE;
use crate::notes::frontmatter::aliases;
#[cfg(doc)]
use crate::vault::consumer::identity::Adoption;
use crate::vault::consumer::identity::IdentityError;
use crate::vault::note_file::NoteFile;

/// The `aliases` a file's frontmatter declares: `Some(None)` without a block, in an empty one or
/// with no `aliases` key, which says nothing of them; an explicit `aliases: []` is the file's
/// answer, an empty list. `None` for a block that does not parse or is not a map.
fn of_file(file: &NoteFile) -> Option<Option<Vec<String>>> {
    match file.split().block.map(gray_matter_data) {
        None | Some(Ok(YamlValue::Null)) => Some(None),
        Some(Ok(YamlValue::Map(map))) => Some(map.contains_key("aliases").then(|| aliases(&map))),
        Some(_) => None,
    }
}

/// The tier first named the file of the note or day `id`: its record takes the file's
/// `aliases`, as desktop's indexer gives a found file's record (`syncNoteToCache`). A file whose
/// frontmatter does not read, or that has no `aliases` key, gives nothing. `matched` is the
/// file's modification time when it matched a record (`Adopted::Existing`) or a large file's
/// note reads it as a note's for the first time ([`super::large::left`]): a record modified
/// strictly after it keeps its names, and so does a record with names whose file has no
/// `aliases` key, whatever the times ([`NotesWriter::matched_file_aliases`]).
///
/// `true` when the record kept its names and the file owes them: the caller has the write-back
/// write its `aliases` key alone ([`Adoption::ExistingNewer`]).
pub(super) fn found(writer: &NotesWriter, id: &str, file: &NoteFile, matched: Option<i64>) -> bool {
    let Some(declared) = of_file(file) else {
        return false;
    };
    let taken = match (matched, declared) {
        (Some(file_modified_ms), declared) => {
            writer.matched_file_aliases(id, declared.as_deref(), file_modified_ms)
        }
        (None, None) => return false,
        (None, Some(names)) if names.is_empty() => return false,
        (None, Some(names)) => writer.file_aliases(id, &names).map(|taken| match taken {
            true => MatchedAliases::Taken,
            false => MatchedAliases::NoNote,
        }),
    };
    match taken {
        Ok(MatchedAliases::Taken) => false,
        Ok(MatchedAliases::RecordNewer) => true,
        Ok(MatchedAliases::NoNote) => {
            tracing::warn!(
                scope = SCOPE,
                note_id = id,
                "a found file's aliases were not taken: no live note or day"
            );
            false
        }
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                note_id = id,
                "a found file's aliases were not taken: {error}"
            );
            false
        }
    }
}

/// An edit outside the app replaced the file of the note or day `note_id`: its record takes the
/// file's `aliases`, a missing key an empty list. A frontmatter that does not parse, or is not a
/// map, says nothing of them: the record stays as it was. So does a file that owes its record's
/// names and still holds the list it had then, an edit of its body alone
/// ([`NotesWriter::edited_file_aliases`]): the write-back writes them.
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
    if writer.edited_file_aliases(note_id, names.as_deref())? == EditedAliases::NoNote {
        tracing::warn!(
            scope = SCOPE,
            note_id,
            "an outside edit's aliases were not taken: no live note or day"
        );
    }
    Ok(())
}
