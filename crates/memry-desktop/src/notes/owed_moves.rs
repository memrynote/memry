//! The moves a note's or journal day's record is owed (Step 13m-6, #3530): a move that changes
//! what the file is ([`keeps_kind`]) is made at the next open's walk ([`crossings`]), the
//! record deleted for the consumer to make the file anew, as Electron does
//! (`renameKeepsJournalDate`, `vault/watcher.ts`).

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::identity::Removed;

use crate::vault::consumer::identity::{Crossed, IdentityError};
use crate::vault::journal_format::JournalDays;

const SCOPE: &str = "note_identity";

/// Whether the record `id` at `path` is what it was: its day (none for a note) is the day
/// `path` names.
pub(super) fn keeps_kind(
    journal: &JournalDays,
    writer: &NotesWriter,
    id: &str,
    path: &str,
) -> Result<bool, IdentityError> {
    Ok(writer.journal_date(id)? == journal.day_of(path))
}

/// Each owed move that changes what its file is, with its record deleted as the watcher's move
/// deletes it ([`NotesWriter::file_crossed`]); one whose record stays is left owed.
pub(super) fn crossings(journal: &JournalDays, writer: &NotesWriter) -> Vec<Crossed> {
    let owed = match writer.owed_places() {
        Ok(owed) => owed,
        Err(error) => {
            tracing::error!(scope = SCOPE, "the owed moves could not be read: {error}");
            return Vec::new();
        }
    };
    let mut crossed = Vec::new();
    for owed in owed {
        let removed = keeps_kind(journal, writer, &owed.note_id, &owed.path).and_then(|keeps| {
            if keeps {
                return Ok(None);
            }
            let to_day = journal.day_of(&owed.path);
            Ok(Some(writer.file_crossed(
                &owed.note_id,
                &owed.from_path,
                to_day.as_deref(),
            )?))
        });
        match removed {
            Ok(Some(Removed::Deleted)) => crossed.push(Crossed {
                note_id: owed.note_id,
                path: owed.path,
            }),
            Ok(_) => {}
            Err(error) => tracing::error!(
                scope = SCOPE,
                note_id = owed.note_id,
                "an owed move between note and journal day was not made: {error}"
            ),
        }
    }
    crossed
}
