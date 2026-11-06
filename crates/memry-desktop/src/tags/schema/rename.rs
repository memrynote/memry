//! `rename-field` (`renameField` of `tags/schema/field-rename.ts`): a field renamed across the
//! vault. A field name is a property key, so the rename reaches every holder of the key, in this
//! order:
//! 1. refused while another rename runs or is recorded for another pair
//!    (`errors:tagFields.renameRunning`), and, unless it resumes, when any schema refuses it,
//!    before anything is written;
//! 2. recorded in `meta` (`memry_core::domain::tag_schema::rename`) before the first write, and
//!    cleared after the last;
//! 3. the property definition, through its owner ([`PropertyDefinitions::rename`]);
//! 4. every tag schema and saved tag view, one definition write each;
//! 5. each note and journal day the index lists as holding the key, through the property writer
//!    ([`NotesService::rename_field_in_note`]: its turn, the app-edit seam with `Held`, the
//!    record's properties and their baseline in the same lane);
//! 6. each task holding a value under the key, in one task write ([`Tasks::rename_field`]); a
//!    task whose payload does not read refuses the run before step 2.
//!
//! Every step finds what an earlier run did and leaves it, so a run stopped anywhere (a quit, a
//! crash) is run again with `resuming` by the next open ([`register_resume`]) and comes to the
//! same end. A note the seam keeps for an edit its file or its document has not caught up with
//! is tried once more after the write-back ran; one still kept is answered in `kept` and holds
//! the job for the next open. Tauri has no note lock yet (Step 14), so `skippedLocked` is 0.
//!
//! [`Tasks::rename_field`]: memry_core::api::tasks::Tasks

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::{Duration, Instant};

use memry_core::api::errors::StorageError;
pub use memry_core::domain::tag_schema::rename::FieldRenameJob;
use memry_core::domain::tag_schema::rename::RecordedRename;
use memry_core::domain::tasks::FieldRenamed;
use serde::Serialize;
use tokio::sync::broadcast::Receiver;

use super::edit::field_name;
use super::{SchemaError, Schemas};
use crate::notes::error::{NotesError, kept_is_retryable};
use crate::notes::properties::FieldInNote;
use crate::notes::service::NotesService;
use crate::notes::tag_rename::{SETTLE, walked};
use crate::session::{OpenStage, Session};
use crate::vault::consumer::Applied;

#[cfg(doc)]
use crate::notes::property_definitions::PropertyDefinitions;

const SCOPE: &str = "FieldRename";
/// How often the progress is told, at most (`PROGRESS_INTERVAL_MS`).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// `FieldRenameResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldRenameView {
    pub notes: u32,
    pub tasks: u32,
    pub skipped_locked: u32,
    /// Notes and tasks that already had a value under the new name, left as they were.
    pub skipped_existing: u32,
    /// Notes that changed while the rename ran and keep the old name until the next open
    /// finishes them. Tauri only.
    pub kept: u32,
}

/// Told `(run id, done, total)` as the notes and tasks go.
pub type Progress<'a> = &'a mut dyn FnMut(&str, usize, usize);

/// One note's rename.
enum InNote {
    Done(FieldInNote),
    /// Kept by an edit its file or its document has and the other has not yet.
    Again,
    /// Not written for good (its frontmatter is broken, it is gone): logged.
    Failed,
}

impl Schemas {
    /// Renames `job.from` to `job.to` across the vault (see the module comment).
    pub(super) fn rename_field(
        &self,
        job: FieldRenameJob,
        progress: Progress<'_>,
    ) -> Result<FieldRenameView, SchemaError> {
        self.rename_field_until(job, progress, &|| false)
    }

    /// [`Self::rename_field`], ended before a step, a note or a task once `stop` says so, as a
    /// quit or a crash ends it: the job stays recorded for the next open.
    #[doc(hidden)]
    pub fn rename_field_until(
        &self,
        job: FieldRenameJob,
        progress: Progress<'_>,
        stop: &dyn Fn() -> bool,
    ) -> Result<FieldRenameView, SchemaError> {
        let job = checked(job)?;
        let Some(_running) = claim(&self.notes.field_renaming) else {
            let busy = self.recorded()?.unwrap_or(job);
            return Err(self.running(&busy));
        };
        let recorded = self.recorded()?;
        let resuming = recorded
            .as_ref()
            .is_some_and(|r| r.from == job.from && r.to == job.to);
        if let Some(other) = recorded.filter(|_| !resuming) {
            return Err(self.running(&other));
        }
        if !resuming {
            self.schemas
                .plan_field_rename(&job.from, &job.to)
                .map_err(|error| self.saved(error))?;
        }
        let tasks = self.carriers(&job.from)?;
        self.schemas.begin_field_rename(&job)?;
        self.run_job(&job, &tasks, resuming, progress, stop)
    }

    /// Finishes the rename an earlier run recorded (`resumeFieldRename`); `None` when there is
    /// none or one runs now.
    pub fn resume_field_rename(
        &self,
        stop: &dyn Fn() -> bool,
    ) -> Result<Option<FieldRenameView>, SchemaError> {
        let Some(_running) = claim(&self.notes.field_renaming) else {
            return Ok(None);
        };
        let Some(job) = self.recorded()? else {
            return Ok(None);
        };
        tracing::info!(scope = SCOPE, "resuming a recorded field rename");
        let tasks = self.carriers(&job.from)?;
        self.run_job(&job, &tasks, true, &mut |_, _, _| {}, stop)
            .map(Some)
    }

    /// The recorded job; one that does not read is dropped, and logged.
    fn recorded(&self) -> Result<Option<FieldRenameJob>, SchemaError> {
        match self.open.vault.field_rename_recorded()? {
            None => Ok(None),
            Some(RecordedRename::Job(job)) => Ok(Some(job)),
            Some(RecordedRename::Unreadable(what)) => {
                tracing::warn!(scope = SCOPE, "dropping a field rename job: {what}");
                self.schemas.finish_field_rename()?;
                Ok(None)
            }
        }
    }

    /// The live tasks holding a value under `from`. A task whose payload does not read refuses
    /// the run before it writes anything: whether it holds the field cannot be told.
    fn carriers(&self, from: &str) -> Result<Vec<String>, SchemaError> {
        let read = self.tasks.field_holders()?;
        if !read.unreadable.is_empty() {
            tracing::warn!(scope = SCOPE, tasks = ?read.unreadable, "tasks that do not read");
            return Err(StorageError::Failed {
                what: format!(
                    "{} tasks could not be read, so the field rename did not run",
                    read.unreadable.len()
                ),
            }
            .into());
        }
        Ok(read
            .holders
            .into_iter()
            .filter(|task| task.fields.iter().any(|name| name == from))
            .map(|task| task.id)
            .collect())
    }

    fn running(&self, job: &FieldRenameJob) -> SchemaError {
        self.refused(
            "tag_field_rename_running",
            "errors:tagFields.renameRunning",
            &[("from", &job.from), ("to", &job.to)],
        )
    }

    /// `runJob`: steps 3 to 6, then the job cleared unless a note is still kept.
    fn run_job(
        &self,
        job: &FieldRenameJob,
        tasks: &[String],
        resuming: bool,
        progress: Progress<'_>,
        stop: &dyn Fn() -> bool,
    ) -> Result<FieldRenameView, SchemaError> {
        let (from, to) = (job.from.as_str(), job.to.as_str());
        let stopped = || match stop() {
            true => Err(SchemaError::Stopped),
            false => Ok(()),
        };
        stopped()?;
        self.definitions.rename(from, to)?;
        stopped()?;
        self.schemas
            .rename_field(from, to, resuming)
            .map_err(|error| self.saved(error))?;
        let notes = self
            .open
            .search
            .notes_holding_properties(vec![from.to_owned()])?;
        let total = notes.len() + tasks.len();
        let (mut done, mut told) = (0, None::<Instant>);
        let mut tick = |progress: &mut dyn FnMut(&str, usize, usize)| {
            done += 1;
            if done == total || told.is_none_or(|told| told.elapsed() >= PROGRESS_EVERY) {
                told = Some(Instant::now());
                progress(&job.run_id, done, total);
            }
        };
        let mut view = FieldRenameView::default();
        let mut again = Vec::new();
        for id in &notes {
            stopped()?;
            match self.rename_in_note(id, from, to)? {
                InNote::Done(done) => count(&mut view, done),
                InNote::Again => again.push(id),
                InNote::Failed => {}
            }
            tick(progress);
        }
        if !again.is_empty() {
            // A refused edit wrote nothing, so one more try is safe; the flush writes a document
            // that is ahead of its file out first.
            self.notes.tier.flush(SETTLE);
        }
        for id in again {
            match self.rename_in_note(id, from, to)? {
                InNote::Done(done) => count(&mut view, done),
                InNote::Again => view.kept += 1,
                InNote::Failed => {}
            }
        }
        for id in tasks {
            stopped()?;
            match self.tasks.rename_field(id, from, to)? {
                FieldRenamed::Renamed { .. } => view.tasks += 1,
                FieldRenamed::Existing => view.skipped_existing += 1,
                FieldRenamed::Unchanged => {}
            }
            tick(progress);
        }
        if total == 0 {
            progress(&job.run_id, 0, 0);
        }
        if view.kept == 0 {
            self.schemas.finish_field_rename()?;
        }
        Ok(view)
    }

    fn rename_in_note(&self, id: &str, from: &str, to: &str) -> Result<InNote, SchemaError> {
        #[cfg(feature = "test-hooks")]
        if self
            .notes
            .field_rename_keeps
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_deref()
            == Some(id)
        {
            return Ok(InNote::Again);
        }
        match self.notes.rename_field_in_note(&self.open, id, from, to) {
            Ok(done) => Ok(InNote::Done(done)),
            Err(NotesError::EditKept(kept)) if kept_is_retryable(&kept) => Ok(InNote::Again),
            Err(NotesError::Closed) => Err(SchemaError::Stopped),
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id = id,
                    "a field rename could not write a note: {error}"
                );
                Ok(InNote::Failed)
            }
        }
    }
}

fn count(view: &mut FieldRenameView, done: FieldInNote) {
    match done {
        FieldInNote::Renamed => view.notes += 1,
        FieldInNote::Existing => view.skipped_existing += 1,
        FieldInNote::Unchanged => {}
    }
}

/// The command's input as zod checks it (`FieldName` twice, `runId` 1 to 100). The same name
/// twice is refused: Electron would delete the field's definition.
fn checked(job: FieldRenameJob) -> Result<FieldRenameJob, SchemaError> {
    let (from, to) = (field_name(&job.from)?, field_name(&job.to)?);
    let run_id = job.run_id.encode_utf16().count();
    if from == to || !(1..=100).contains(&run_id) {
        return Err(StorageError::Invalid {
            what: "a field rename takes two different names and a run id of 1 to 100 characters"
                .to_owned(),
        }
        .into());
    }
    Ok(FieldRenameJob { from, to, ..job })
}

/// The rename lock, `None` while a rename runs. A run that panicked left its job in the
/// database, not in the lock.
fn claim(lock: &Mutex<()>) -> Option<MutexGuard<'_, ()>> {
    match lock.try_lock() {
        Ok(running) => Some(running),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

/// Finishes a recorded field rename in the background of every open, once the open walk
/// offered every file, so the index rows the rename reads are read. `finished` runs after a
/// resume that ran (the shell tells the renderer the schemas changed).
pub fn register_resume(
    notes: &Arc<NotesService>,
    session: &Session,
    finished: Arc<dyn Fn() + Send + Sync>,
) {
    let facts: Arc<Mutex<Option<Receiver<Applied>>>> = Arc::default();
    let (tier, slot) = (notes.tier.clone(), facts.clone());
    // Before the `Watcher` stage, whose walk publishes `Indexed`.
    session.on_open(
        "field-rename-resume",
        OpenStage::LockGuard,
        Arc::new(move |_| {
            *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(tier.subscribe());
            Ok(())
        }),
    );
    let notes = notes.clone();
    session.on_background(
        "field-rename-resume",
        Arc::new(move |open, cancel| {
            let taken = facts.lock().unwrap_or_else(PoisonError::into_inner).take();
            let Some(mut facts) = taken else {
                return Ok(());
            };
            if cancel.is_cancelled() {
                return Ok(());
            }
            // Most opens have nothing to finish: nothing is opened under the device identity.
            if matches!(open.vault.field_rename_recorded(), Ok(None)) {
                return Ok(());
            }
            if !walked(&mut facts, &|| cancel.is_cancelled()) {
                return Ok(());
            }
            drop(facts);
            let resumed = Schemas::open(open, &notes, "en")
                .and_then(|schemas| schemas.resume_field_rename(&|| cancel.is_cancelled()));
            match resumed {
                Ok(Some(view)) => {
                    if view.kept > 0 {
                        tracing::warn!(
                            scope = SCOPE,
                            kept = view.kept,
                            "a resumed field rename left notes for the next open"
                        );
                    }
                    finished();
                    Ok(())
                }
                Ok(None) | Err(SchemaError::Stopped) => Ok(()),
                Err(error) => Err(format!("resuming a field rename failed: {error}")),
            }
        }),
    );
}
