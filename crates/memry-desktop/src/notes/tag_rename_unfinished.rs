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

/// A recorded rename and the notes it has left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnfinishedRename {
    pub job: RenameJob,
    pub notes: Vec<UnfinishedNote>,
}

/// A note a rename left, named by its file's name (its id when it has no file).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnfinishedNote {
    pub id: String,
    pub title: String,
}

impl NotesService {
    /// The recorded rename and the notes it has left; `None` when none is recorded, or while
    /// one runs (a running rename is not stuck).
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
        let mut notes = Vec::with_capacity(plan.holders.len());
        for holder in plan.holders {
            let named = files.by_id(&holder.id)?.and_then(|row| {
                let stem = Path::new(&row.path).file_stem()?;
                Some(stem.to_string_lossy().into_owned())
            });
            notes.push(UnfinishedNote {
                title: named.unwrap_or_else(|| holder.id.clone()),
                id: holder.id,
            });
        }
        Ok(Some(UnfinishedRename {
            job: plan.job,
            notes,
        }))
    }

    /// Stops the recorded rename, and answers it; `None` when none is recorded. One running is
    /// refused ([`NotesError::TagRenameInProgress`]).
    pub fn abandon_tag_rename(&self, open: &OpenVault) -> Result<Option<RenameJob>, NotesError> {
        let Some(_running) = self.claim_rename() else {
            let running = recorded_plan(open)?.map(|plan| plan.job);
            let (from, to) = running.map_or_else(Default::default, |job| (job.from, job.to));
            return Err(NotesError::TagRenameInProgress { from, to });
        };
        let Some(plan) = recorded_plan(open)? else {
            return Ok(None);
        };
        let left: Vec<&str> = plan
            .holders
            .iter()
            .map(|holder| holder.id.as_str())
            .collect();
        tracing::warn!(
            scope = SCOPE,
            from = plan.job.from,
            to = plan.job.to,
            ?left,
            "a tag rename was stopped; the notes it could not write keep the old name"
        );
        self.tag_hub(open)?.rename_finish()?;
        Ok(Some(plan.job))
    }
}
