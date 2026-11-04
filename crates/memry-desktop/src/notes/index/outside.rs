//! An edit of a note's file made outside the app reaches its record (#3530 13k-4c): the
//! property keys whose text the file changed since the index last read it, and the keys it
//! dropped, measured against the note's `note_properties` rows before the pass replaces them.
//!
//! Only those keys: every other key keeps the record's value, as an app edit's mirror leaves it
//! (`properties::mirror_file`), because a value a pull brought in is in the record and not in
//! the file yet (Step 17). A note the index never read has no rows, so every key its file holds
//! is set: a note found outside the app takes its properties into the record it was given, as
//! Electron's `syncNoteCreate` sends them. Nothing is mirrored for a pass that reads every note
//! because the index never recorded its definitions (an index from before the rows were filled,
//! whose rows say nothing of what the files held), for a frontmatter that does not parse (it
//! dropped nothing), or for a note whose last change was the app's own write, which mirrored
//! its record already.

use memry_core::api::errors::StorageError;
use memry_core::api::notes_write::NotesWriter;
use memry_core::api::search::Search;
use memry_core::domain::property_values::IndexedProperty;
use serde_json::{Map, Value};

/// Gives the note's record the keys its file set or dropped since the index last read it.
pub(super) fn mirror(
    search: &Search,
    writer: &NotesWriter,
    note_id: &str,
    now: &[IndexedProperty],
) -> Result<(), StorageError> {
    let before = search.note_properties(note_id)?;
    let changed: Map<String, Value> = now
        .iter()
        .filter(|property| {
            let held = before.iter().find(|row| row.name == property.name);
            held.map(|row| &row.text) != Some(&property.text)
        })
        .map(|property| (property.name.clone(), property.value.clone()))
        .collect();
    let removed: Vec<String> = before
        .iter()
        .filter(|row| !now.iter().any(|property| property.name == row.name))
        .map(|row| row.name.clone())
        .collect();
    if changed.is_empty() && removed.is_empty() {
        return Ok(());
    }
    if !writer.file_properties(note_id, changed, removed)? {
        tracing::warn!(
            scope = "note_index",
            note_id,
            "an outside edit of a note's properties has no record to reach"
        );
    }
    Ok(())
}
