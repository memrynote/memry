//! A tag rename left with notes it could not write (#3530 13j-4c): the notes named, and a way
//! out. A note that can never be written (a frontmatter that does not parse, a body the file
//! cannot hold) keeps the rename recorded (`notes::tag_rename`), and every other rename is
//! refused until the same rename finishes it or it is stopped. Stopping clears the record: the
//! notes the rename wrote keep the new name, the ones it left keep the old. Electron has no such
//! state: it forgets the notes it could not write.

use std::path::Path;

use memry_core::domain::tag_rename::RenameJob;

use super::error::{NotesError, SCOPE};
use super::service::NotesService;
use super::tag_rename::recorded_plan;
use crate::session::OpenVault;
use crate::vault::hash::content_hash;
use crate::vault::note_file::read_note;

/// How many of the notes it left an unfinished rename names.
const NAMED: usize = 3;

/// A recorded rename, how many notes it has left, and the first [`NAMED`] of them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnfinishedRename {
    pub job: RenameJob,
    pub left: usize,
    pub notes: Vec<UnfinishedNote>,
}

/// A note a rename left, named by its file's name (its id when it has no file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnfinishedNote {
    pub id: String,
    pub title: String,
}

impl NotesService {
    /// The recorded rename, the number of notes it has left and the first of them; `None` when
    /// none is recorded, or while one runs (a running rename is not stuck).
    pub fn unfinished_tag_rename(
        &self,
        open: &OpenVault,
    ) -> Result<Option<UnfinishedRename>, NotesError> {
        let Some(_running) = self.claim_rename() else {
            return Ok(None);
        };
        let Some(plan) = recorded_plan(open)? else {
            return Ok(None);
        };
        let files = open.vault.note_files();
        let mut notes = Vec::with_capacity(NAMED);
        for holder in plan.holders.iter().take(NAMED) {
            let named = files.by_id(&holder.id)?.and_then(|row| {
                let stem = Path::new(&row.path).file_stem()?;
                Some(stem.to_string_lossy().into_owned())
            });
            notes.push(UnfinishedNote {
                title: named.unwrap_or_else(|| holder.id.clone()),
                id: holder.id.clone(),
            });
        }
        Ok(Some(UnfinishedRename {
            left: plan.holders.len(),
            job: plan.job,
            notes,
        }))
    }

    /// Stops the recorded rename, and answers it; `None` when none is recorded. A note whose
    /// file took the rename and whose record did not yet (a run stopped between the two) has its
    /// record renamed first, so it keeps no name its file no longer holds. One running is
    /// refused ([`NotesError::TagRenameInProgress`]).
    pub fn abandon_tag_rename(&self, open: &OpenVault) -> Result<Option<RenameJob>, NotesError> {
        // Nothing to stop, though the lock is held a moment (a refused rename, a query).
        let Some(recorded) = recorded_plan(open)? else {
            return Ok(None);
        };
        let Some(_running) = self.claim_rename() else {
            return Err(NotesError::TagRenameInProgress {
                from: recorded.job.from,
                to: recorded.job.to,
            });
        };
        let Some(plan) = recorded_plan(open)? else {
            return Ok(None);
        };
        let hub = self.tag_hub(open)?;
        let mut left = Vec::new();
        for holder in &plan.holders {
            let id = holder.id.as_str();
            let Some(begun) = hub.rename_started(id)? else {
                left.push(id);
                continue;
            };
            let written = self.order.run(id, |_turn| {
                let Some(row) = open.vault.note_files().by_id(id)? else {
                    return Ok(false);
                };
                let Some(file) = read_note(&open.path, &row.path)? else {
                    return Ok(false);
                };
                let text = file.raw.strip_prefix('\u{feff}').unwrap_or(&file.raw);
                if content_hash(text) != begun.after {
                    return Ok(false);
                }
                hub.rename_in(id)?;
                Ok::<_, NotesError>(true)
            })?;
            if !written {
                left.push(id);
            }
        }
        tracing::warn!(
            scope = SCOPE,
            from = plan.job.from,
            to = plan.job.to,
            ?left,
            "a tag rename was stopped; the notes it could not write keep the old name"
        );
        hub.rename_finish()?;
        Ok(Some(plan.job))
    }
}
