//! A note's other names edited in the app (`notes:edit-aliases`, `notes/note-aliases.ts`; Step
//! 13q-1, #3530), for a note or a journal day alike: the frontmatter `aliases` list.
//!
//! In the note's write turn, through the app-edit seam with [`Precondition::Held`]: the edit
//! (`applyAliasDelta`: its names removed by name key, then its names added) applies to the list
//! the file holds, normalized against the title, or a day's date. The `aliases` key is written
//! only when that list changes: the whole list, or no key once it is empty. Every other key
//! keeps its lines and the body is not touched (`serialize_updated_note`). A file the seam keeps
//! (an outside edit not fed yet, a document ahead of its file) is refused and left as it is.
//!
//! Once the file holds the new list, the record takes it whole
//! ([`NotesWriter::file_aliases`]), under the lane before the note event, so a refused write
//! leaves the record and a link by the new name resolves at once. The file owns a note's
//! names: the edit changed this one key, so only it reaches the record (the 13k-3 rule).
//!
//! Not here: Electron's update also moves a legacy nested `properties:` envelope to the top
//! level on any frontmatter edit; this leaves it as it is, as the editor's save does. The lock
//! check is Step 14's.

use std::cell::RefCell;

use memry_core::api::notes_write::NotesWriter;
use memry_core::domain::notes::names::{
    MAX_NOTE_ALIAS_LENGTH, MAX_NOTE_ALIASES, apply_alias_delta, normalize_aliases,
};
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, parse_markdown_note, serialize_updated_note,
};
use serde::{Deserialize, Serialize};

use super::error::{NotesError, SCOPE};
use super::frontmatter::aliases;
use super::service::NotesService;
use crate::journal::day_of_file;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Precondition};
use crate::vault::consumer::ChangeSource;

/// `NoteAliasEditSchema`: names to remove, then names to add.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteAliasEditInput {
    pub id: String,
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

/// `NoteAliasEditResponse`: the note's other names as its file holds them now.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteAliasesView {
    pub aliases: Vec<String>,
}

impl NotesService {
    /// `notes:edit-aliases` (see the module comment): the names the file holds after the edit.
    pub fn edit_aliases(
        &self,
        open: &OpenVault,
        input: &NoteAliasEditInput,
    ) -> Result<NoteAliasesView, NotesError> {
        let fits = |names: &[String]| {
            names.len() <= MAX_NOTE_ALIASES
                && names
                    .iter()
                    .all(|name| name.encode_utf16().count() <= MAX_NOTE_ALIAS_LENGTH)
        };
        if !fits(&input.add) || !fits(&input.remove) {
            return Err(NotesError::InvalidAliases);
        }
        let id = input.id.as_str();
        let writer = open.vault.notes_writer(self.store.clone())?;
        let seam = AppEdit::new(&self.tier, &self.store, open)?;
        self.order.run(id, |turn| {
            let title = title_of(open, id)?.ok_or_else(|| NotesError::NotFound(id.to_owned()))?;
            // The list the file holds after the edit, and whether the edit changed it.
            let names = RefCell::new(None::<(Vec<String>, bool)>);
            let done = seam.run_then(
                turn,
                Precondition::Held,
                ChangeSource::AppEdit,
                |text| {
                    let parsed = parse_markdown_note(text)?;
                    let read = match &parsed.frontmatter {
                        YamlValue::Map(map) => (**map).clone(),
                        _ if parsed.raw_frontmatter_block.is_none() => YamlMap::new(),
                        // A top level that is a list or a scalar is the author's; no key goes in.
                        _ => return Err(NotesError::FrontmatterNotAMap),
                    };
                    let before = normalize_aliases(&title, &aliases(&read));
                    let after = apply_alias_delta(&title, &before, &input.add, &input.remove);
                    if after == before {
                        *names.borrow_mut() = Some((before, false));
                        return Ok(None);
                    }
                    let mut next = read.clone();
                    match after.is_empty() {
                        true => {
                            next.remove("aliases");
                        }
                        false => {
                            let items = after.iter().cloned().map(YamlValue::String).collect();
                            next.insert("aliases".to_owned(), YamlValue::seq(items));
                        }
                    }
                    *names.borrow_mut() = Some((after, true));
                    let body = parsed.content.clone();
                    Ok(Some(serialize_updated_note(
                        parsed, &read, next, &body, true,
                    )?))
                },
                // Under the lane once the file holds the edit, before the note event.
                || {
                    if let Some((after, true)) = names.borrow().as_ref() {
                        mirror(&writer, id, after)?;
                    }
                    Ok(false)
                },
                &mut || {},
            )?;
            match done {
                Edited::Wrote { .. } | Edited::Unchanged => {
                    let (aliases, _) = names.into_inner().unwrap_or_default();
                    Ok(NoteAliasesView { aliases })
                }
                Edited::Kept(kept) => {
                    tracing::info!(
                        scope = SCOPE,
                        note_id = id,
                        ?kept,
                        "an alias edit was refused"
                    );
                    Err(NotesError::kept(id, kept))
                }
            }
        })
    }
}

/// What the names are normalized against: a note's title, a journal day's date; `None` for no
/// note or day by that id.
fn title_of(open: &OpenVault, id: &str) -> Result<Option<String>, NotesError> {
    let files = open.vault.note_files();
    if let Some(listed) = files.listed_by_id(id)? {
        return Ok(Some(listed.title));
    }
    let Some(row) = files.by_id(id)? else {
        return Ok(None);
    };
    Ok(day_of_file(&open.path, &row.path))
}

fn mirror(writer: &NotesWriter, id: &str, aliases: &[String]) -> Result<(), NotesError> {
    if !writer.file_aliases(id, aliases)? {
        tracing::warn!(
            scope = SCOPE,
            note_id = id,
            "a file took an alias edit its record could not: no live note or day"
        );
    }
    Ok(())
}
