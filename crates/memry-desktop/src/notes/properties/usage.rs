//! Which notes use each property, for Settings (`notes:get-property-usage` and
//! `notes:list-notes-with-property` of `ipc/notes-handlers.ts`, 2b3a512960), read from the
//! index's `note_properties` rows. A property's type is vault-wide, so a note can hold a value
//! that type cannot show (`rating: good` under a number property): such a note is a mismatch.

use std::path::Path;

use memry_core::api::errors::StorageError;
use serde::Serialize;

use crate::session::OpenVault;

/// `PropertyUsage` of `properties-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyUsageView {
    pub name: String,
    pub note_count: u32,
    pub mismatch_count: u32,
}

/// `PropertyNoteUsage` of `properties-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PropertyNoteUsageView {
    pub id: String,
    pub title: String,
    pub path: String,
    pub emoji: Option<String>,
    pub mismatch: bool,
}

/// Every property name the index holds, by name, with how many notes use it (`listPropertyUsage`).
pub fn property_usage(open: &OpenVault) -> Result<Vec<PropertyUsageView>, StorageError> {
    Ok(open
        .search
        .property_usage()?
        .into_iter()
        .map(|used| PropertyUsageView {
            name: used.name,
            note_count: used.note_count,
            mismatch_count: used.mismatch_count,
        })
        .collect())
}

/// The notes that use `name`, by title (`listNotesWithProperty`). A journal day is titled by
/// its file's name, as Electron's index titles it; a row whose note has no file is left out.
pub fn notes_with_property(
    open: &OpenVault,
    name: &str,
) -> Result<Vec<PropertyNoteUsageView>, StorageError> {
    let files = open.vault.note_files();
    let mut notes = Vec::new();
    for (id, mismatch) in open.search.notes_with_property(name.to_owned())? {
        let note = match files.listed_by_id(&id)? {
            Some(listed) => PropertyNoteUsageView {
                id,
                title: listed.title,
                path: listed.path,
                emoji: listed.emoji,
                mismatch,
            },
            None => {
                let Some(file) = files.by_id(&id)? else {
                    continue;
                };
                let title = Path::new(&file.path)
                    .file_stem()
                    .map_or_else(String::new, |stem| stem.to_string_lossy().into_owned());
                PropertyNoteUsageView {
                    id,
                    title,
                    path: file.path,
                    emoji: None,
                    mismatch,
                }
            }
        };
        notes.push(note);
    }
    // `ORDER BY title COLLATE NOCASE`: ASCII letters fold, nothing else does.
    notes.sort_by(|a, b| {
        a.title
            .to_ascii_lowercase()
            .cmp(&b.title.to_ascii_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(notes)
}
