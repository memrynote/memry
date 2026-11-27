//! A project write's linked markdown notes (`writeNames` of `project-item-links.ts`,
//! `rewriteLinkedNotes` of `project-name-propagation.ts`). A markdown note names its projects in
//! its file's `project` property, so a link, unlink, rename or delete reaches the file through
//! the property writer ([`NotesService::merge_properties`]): the file first, then its record,
//! baseline and project links, as an edit in the panel does. Core answers the notes and the edit
//! ([`NoteNames`]) and leaves their records to that writer.
//!
//! - **Link and unlink**: the note's property is the membership, so the file write is the write,
//!   and its failure is the answer, with no event (`writeNames` answers `setEntityProperties`).
//! - **Rename and delete**: the project write has committed and its events go out first. A note
//!   whose file does not take the names is logged and the others still go (Electron logs
//!   `propagate_failed` and succeeds); it never undoes or hides the project write.
//!
//! A write the file does not take (an outside edit not fed yet, an I/O error) is tried again
//! after the write-back's [`DEBOUNCE`], [`NOTE_TRIES`] tries in all, as a pulled place is.

use std::thread::sleep;

use memry_core::api::task_store::NoteNames;
use memry_core::domain::projects::{NameEdit, PROJECT_PROPERTY_KEY, project_names};
use serde_json::{Map, json};

use super::project_contract::ProjectMutation;
use super::service::TaskWritten;
use crate::notes::error::NotesError;
use crate::notes::service::NotesService;
use crate::session::OpenVault;
use crate::vault::writeback::DEBOUNCE;

const SCOPE: &str = "project_notes";

/// The tries a note's names get, the first included.
pub const NOTE_TRIES: u32 = 3;

/// A project command's answer and events, and the notes its write leaves to the property writer.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectWrite {
    pub written: TaskWritten<ProjectMutation>,
    pub notes: NoteWrite,
}

/// What a project write leaves to the linked notes' files.
#[derive(Debug, Clone, PartialEq)]
pub enum NoteWrite {
    None,
    /// A link or unlink of a markdown note: the file write is the write.
    Membership(NoteNames),
    /// A rename or delete that committed: each note follows it.
    Propagation(NoteNames),
}

impl ProjectWrite {
    pub fn without_notes(written: TaskWritten<ProjectMutation>) -> Self {
        Self {
            written,
            notes: NoteWrite::None,
        }
    }

    /// Writes the notes and sends the events (`announce`) in Electron's order; answers the
    /// command's envelope.
    pub fn finish(
        self,
        notes: &NotesService,
        open: &OpenVault,
        announce: impl FnOnce(&TaskWritten<ProjectMutation>),
    ) -> ProjectMutation {
        match self.notes {
            NoteWrite::None => announce(&self.written),
            NoteWrite::Membership(names) => {
                for note_id in &names.note_ids {
                    if let Err(error) = write_names(notes, open, note_id, &names.edit) {
                        tracing::error!(
                            scope = SCOPE,
                            note_id,
                            "a project link did not reach the note's file: {error}"
                        );
                        return ProjectMutation::refused(&error.to_string());
                    }
                }
                announce(&self.written);
            }
            NoteWrite::Propagation(names) => {
                announce(&self.written);
                let failed = names
                    .note_ids
                    .iter()
                    .filter(|note_id| {
                        write_names(notes, open, note_id, &names.edit)
                            .inspect_err(|error| {
                                tracing::error!(
                                    scope = SCOPE,
                                    note_id = note_id.as_str(),
                                    tries = NOTE_TRIES,
                                    "a project rename or delete did not reach the note's file; \
                                     the project write stands: {error}"
                                );
                            })
                            .is_err()
                    })
                    .count();
                if failed > 0 {
                    tracing::error!(scope = SCOPE, failed, "propagate_failed");
                }
            }
        }
        self.written.mutation
    }
}

/// [`write_once`], tried again after [`DEBOUNCE`] while it fails, [`NOTE_TRIES`] tries in all.
fn write_names(
    notes: &NotesService,
    open: &OpenVault,
    note_id: &str,
    edit: &NameEdit,
) -> Result<(), NotesError> {
    let mut tries = 1;
    loop {
        match write_once(notes, open, note_id, edit) {
            Ok(()) => return Ok(()),
            Err(error) if tries < NOTE_TRIES => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    tries,
                    "a note's project names wait for another try: {error}"
                );
                tries += 1;
                sleep(DEBOUNCE);
            }
            Err(error) => return Err(error),
        }
    }
}

/// The note's `project` names after `edit`, into its file; nothing when they do not change or
/// the note is gone (`getEntityPropertiesRecord` reading none).
fn write_once(
    notes: &NotesService,
    open: &OpenVault,
    note_id: &str,
    edit: &NameEdit,
) -> Result<(), NotesError> {
    let Some(listed) = open.vault.note_files().listed_by_id(note_id)? else {
        return Ok(());
    };
    let names = project_names(listed.properties.get(PROJECT_PROPERTY_KEY));
    let next = edit.apply(names.clone());
    if next == names {
        return Ok(());
    }
    let values = Map::from_iter([(PROJECT_PROPERTY_KEY.to_owned(), json!(next))]);
    notes.merge_properties(open, note_id, values)?;
    Ok(())
}
