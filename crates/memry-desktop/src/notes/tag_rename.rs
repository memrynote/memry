//! A tag renamed across the vault (`tags:rename`, Electron `renameTagEverywhere`,
//! `tags/rename-tag.ts`): `old` and every `old/…` child take `new`, and a name the vault already
//! holds is merged into.
//!
//! The rename is recorded first with its plan and cleared last
//! (`memry_core::domain::tag_rename::begin`): the name pairs and the holders, each struck off as
//! it is done, so a rename the app did not finish is finished by the next open
//! ([`NotesService::register_resume`], Electron `resumeTagRename`) visiting only what is left.
//! Nothing is renamed twice, which matters when the new name sits under the old one (`a` to
//! `a/b` must never make `a/b/b`):
//! 1. what no file holds, in the core (`TagHub::rename_shared`): the tasks' tags, the
//!    `tag_definition` items (moved to the new name, or dropped for the one the new name has),
//!    and the other tags' schema references;
//! 2. each note and journal day carrying the tag (`Search::tag_rename_holders`: its record, its
//!    body's `#tags`, its file's header as the index read it), in its own write turn, through
//!    [`AppEdit`] with [`Precondition::Held`]: its file's frontmatter `tags:` (a note's only: a
//!    day's are the author's bytes and never written, decision on #3530) and its body's `#tags`
//!    when the new name can be one; then, once the file holds them, its record's `tags` and
//!    `pinnedTags` (`TagHub::rename_in`, one outbox row, the holder struck off in the same
//!    transaction). Before its file is written the plan records the file's hashes before and
//!    after, and the record's lists (`TagHub::rename_start`): a rename stopped between the file
//!    and the record finds the after text on resume and renames the record alone: what the
//!    rename made of the lists it had, with what an edit read meanwhile changed (a note's
//!    renamed header carried into it, a tag a day's header added). Text that is neither changed
//!    since, by an edit outside: whether the file took the rename cannot be told, so it is not
//!    written again, its record is treated so, and it is answered in `failed_note_ids`. Each note's turn reads its
//!    holder and its begun edit afresh, so it acts on what the plan holds then.
//!    The note event goes out as
//!    [`ChangeSource::AppEdit`], so an open editor takes the new text. A note with no file to
//!    edit (no row, its file gone, not markdown) has its record renamed alone.
//!
//! A note the seam keeps (an outside edit not read yet, a document ahead of its file, a body not
//! pulled, a frontmatter that does not parse) keeps the old tag in its file and its record. It
//! is tried once more after the write-back ran what it had scheduled; one still kept is answered
//! in `failed_note_ids`, as Electron answers a note it could not write. It stays in the plan and
//! the rename stays recorded: the same rename asked again, or the next open, tries what is left
//! with the plan it has, so nothing renamed is renamed again; another rename is refused until
//! then, or until it is stopped (`notes::tag_rename_unfinished`). One rename runs at a time: one
//! asked while one runs is refused, and a resume waits for it, then finishes what it left.
//!
//! A case-only rename (`Work` to `work`) respells the files and records and leaves the
//! `tag_definition` under its id: the two spellings are one tag (§13.7.7), and a definition under
//! the second spelling is what the core's projection cannot hold beside the first (#3847).
//!
//! Divergences from Electron, stated: a renamed pin reads as pinned when this device applied the
//! rename (the projection stamps a newly pinned spelling), where Electron kept the pin's time;
//! a day's frontmatter `tags:` keep the old name.

use std::cell::Cell;
#[cfg(feature = "test-hooks")]
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::{Duration, Instant};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::StorageError;
use memry_core::api::tag_hub::TagHub;
use memry_core::domain::body_tags::extract_markdown;
use memry_core::domain::header_tags;
use memry_core::domain::note_stats::header_tags as file_header_tags;
use memry_core::domain::tag_body_rename::{is_inline_tag_name, rewrite_markdown};
pub use memry_core::domain::tag_rename::RenameJob;
use memry_core::domain::tag_rename::{Holder, Recorded, RenamePlan};
use memry_core::domain::tags::{renamed_list, tag_key};
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, parse_markdown_note, serialize_updated_note,
};
use tokio::sync::broadcast::{Receiver, error::TryRecvError};

use super::error::{NotesError, SCOPE, kept_is_retryable};
use super::service::NotesService;
use crate::session::{OpenStage, OpenVault, Session};
use crate::vault::app_edit::{AppEdit, Edited, Kept, Precondition};
use crate::vault::consumer::{Applied, ChangeSource};
use crate::vault::hash::content_hash;

/// How long a kept note waits for the write-back before its second try.
const SETTLE: Duration = Duration::from_secs(2);
/// How often the progress is told, at most (`PROGRESS_INTERVAL_MS`).
const PROGRESS_EVERY: Duration = Duration::from_millis(100);

/// What a rename came to (`RenameTagResponse`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TagRenamed {
    /// The notes and days whose file or record took the new name.
    pub written: Vec<String>,
    /// The notes and days that keep the old name.
    pub failed_note_ids: Vec<String>,
    /// The new name cannot be an inline `#tag`, so the bodies keep the old one.
    pub body_skipped: bool,
}

/// One holder's rename.
enum InNote {
    Written,
    Unchanged,
    /// Kept by an edit the file or the document has and the other has not yet.
    Again,
    Failed,
    /// The vault closed under it: the rename stays recorded for the next open.
    Stopped,
    /// Changed outside since a stopped run began its file: the record took the new name, the
    /// file was left.
    Unsure,
}

impl NotesService {
    /// Renames `job.from` to `job.to` across the vault (see the module comment). `progress` is
    /// told `(done, total)` as the notes go. A rename running now is refused
    /// ([`NotesError::TagRenameInProgress`]), and so is another one recorded with notes left
    /// ([`NotesError::TagRenameUnfinished`]).
    pub fn rename_tag(
        &self,
        open: &OpenVault,
        job: &RenameJob,
        progress: &mut dyn FnMut(usize, usize),
    ) -> Result<TagRenamed, NotesError> {
        self.rename_tag_until(open, job, progress, &|| false)
    }

    /// [`Self::rename_tag`], ended between two notes once `stop` says so, as a quit or a crash
    /// ends it: the rename stays recorded for the next open.
    #[doc(hidden)]
    pub fn rename_tag_until(
        &self,
        open: &OpenVault,
        job: &RenameJob,
        progress: &mut dyn FnMut(usize, usize),
        stop: &dyn Fn() -> bool,
    ) -> Result<TagRenamed, NotesError> {
        if tag_key(&job.from).is_empty() || tag_key(&job.to).is_empty() {
            return Err(StorageError::Invalid {
                what: "a tag needs a name".to_owned(),
            }
            .into());
        }
        let Some(_running) = self.claim_rename() else {
            let running = recorded_plan(open)?.map_or_else(|| job.clone(), |plan| plan.job);
            return Err(NotesError::TagRenameInProgress {
                from: running.from,
                to: running.to,
            });
        };
        let hub = self.tag_hub(open)?;
        let holders = open.search.tag_rename_holders(&job.from)?;
        if let Some(other) = hub.rename_begin(job, holders)? {
            let left = recorded_plan(open)?.map_or(0, |plan| plan.holders.len());
            return Err(NotesError::TagRenameUnfinished {
                from: other.from,
                to: other.to,
                left,
            });
        }
        self.run_rename(open, &hub, progress, stop)
    }

    /// Finishes the rename an earlier run recorded and did not finish, if any, once a rename
    /// running ends; `None` when there is none, or `stop` ended it between two notes, leaving it
    /// recorded.
    /// A record that does not read (another layout) is dropped, and logged; a database that
    /// fails to answer is an error, and drops nothing. Nothing is read under the device's
    /// identity unless a rename is recorded.
    pub fn resume_tag_rename(
        &self,
        open: &OpenVault,
        stop: &dyn Fn() -> bool,
    ) -> Result<Option<TagRenamed>, NotesError> {
        // Waits: a rename refused holds the lock a moment, and one that ran may leave notes.
        let _running = self.renaming.lock().unwrap_or_else(PoisonError::into_inner);
        // A close while it waited: nothing is read or written for a vault closing.
        if stop() {
            return Ok(None);
        }
        match open.vault.tag_rename_recorded()? {
            None => return Ok(None),
            Some(Recorded::Unreadable(what)) => {
                tracing::warn!(
                    scope = SCOPE,
                    "dropping a tag rename that does not read: {what}"
                );
                self.tag_hub(open)?.rename_finish()?;
                return Ok(None);
            }
            Some(Recorded::Plan(_)) => {}
        }
        tracing::info!(scope = SCOPE, "resuming an interrupted tag rename");
        let hub = self.tag_hub(open)?;
        match self.run_rename(open, &hub, &mut |_, _| {}, stop) {
            Err(NotesError::Closed) => {
                tracing::info!(
                    scope = SCOPE,
                    "a resumed tag rename stopped; the next open goes on"
                );
                Ok(None)
            }
            renamed => renamed.map(Some),
        }
    }

    /// The rename lock, `None` while a rename runs. A run that panicked left nothing it holds
    /// to the lock: the plan is in the database.
    pub(super) fn claim_rename(&self) -> Option<MutexGuard<'_, ()>> {
        match self.renaming.try_lock() {
            Ok(running) => Some(running),
            Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }

    /// Resumes a recorded rename in the background of every open, once the open walk offered
    /// every file, so the rows the rename reads are read (Electron resumes after its index).
    pub fn register_resume(self: &Arc<Self>, session: &Session) {
        let facts: Arc<Mutex<Option<Receiver<Applied>>>> = Arc::default();
        let (notes, slot) = (self.clone(), facts.clone());
        // Before the `Watcher` stage, whose walk publishes `Indexed`.
        session.on_open(
            "tag-rename-resume",
            OpenStage::LockGuard,
            Arc::new(move |_| {
                *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(notes.tier.subscribe());
                Ok(())
            }),
        );
        let notes = self.clone();
        session.on_background(
            "tag-rename-resume",
            Arc::new(move |open, cancel| {
                let taken = facts.lock().unwrap_or_else(PoisonError::into_inner).take();
                let Some(mut facts) = taken else {
                    return Ok(());
                };
                // Most opens have nothing to finish; a record that does not read is dropped below.
                if matches!(open.vault.tag_rename_recorded(), Ok(None)) {
                    return Ok(());
                }
                if !walked(&mut facts, &|| cancel.is_cancelled()) {
                    return Ok(());
                }
                drop(facts);
                match notes.resume_tag_rename(open, &|| cancel.is_cancelled()) {
                    Ok(Some(renamed)) if !renamed.failed_note_ids.is_empty() => tracing::warn!(
                        scope = SCOPE,
                        failed = ?renamed.failed_note_ids,
                        "a resumed tag rename could not write some notes"
                    ),
                    Ok(_) => {}
                    Err(error) => return Err(format!("resuming a tag rename failed: {error}")),
                }
                Ok(())
            }),
        );
    }

    pub(super) fn tag_hub(&self, open: &OpenVault) -> Result<TagHub, NotesError> {
        ensure_device_identity(self.store.clone())?;
        Ok(open.vault.tag_hub(self.store.clone())?)
    }

    /// Runs what the recorded rename has left, and clears it when nothing is.
    fn run_rename(
        &self,
        open: &OpenVault,
        hub: &TagHub,
        progress: &mut dyn FnMut(usize, usize),
        stop: &dyn Fn() -> bool,
    ) -> Result<TagRenamed, NotesError> {
        hub.rename_shared()?;
        let Some(plan) = recorded_plan(open)? else {
            return Ok(TagRenamed::default());
        };
        let (from, to) = (plan.job.from.as_str(), plan.job.to.trim());
        let holders = &plan.holders;
        let edit = AppEdit::new(&self.tier, &self.store, open)?;
        let mut renamed = TagRenamed {
            body_skipped: !is_inline_tag_name(to),
            ..TagRenamed::default()
        };
        let mut again = Vec::new();
        let mut told: Option<Instant> = None;
        for (at, holder) in holders.iter().enumerate() {
            if stop() {
                return Err(NotesError::Closed);
            }
            match self.rename_one(&edit, hub, holder, from, to) {
                InNote::Written => renamed.written.push(holder.id.clone()),
                InNote::Unchanged => {}
                InNote::Again => again.push(holder),
                InNote::Failed | InNote::Unsure => renamed.failed_note_ids.push(holder.id.clone()),
                InNote::Stopped => return Err(NotesError::Closed),
            }
            let done = at + 1;
            if done == holders.len() || told.is_none_or(|told| told.elapsed() >= PROGRESS_EVERY) {
                told = Some(Instant::now());
                progress(done, holders.len());
            }
        }
        if holders.is_empty() {
            progress(0, 0);
        }
        if !again.is_empty() {
            // A refused edit wrote nothing, so one more try is safe; the flush writes a document
            // that is ahead of its file out first.
            self.tier.flush(SETTLE);
        }
        for holder in again {
            match self.rename_one(&edit, hub, holder, from, to) {
                InNote::Written => renamed.written.push(holder.id.clone()),
                InNote::Unchanged => {}
                InNote::Again | InNote::Failed | InNote::Unsure => {
                    renamed.failed_note_ids.push(holder.id.clone());
                }
                InNote::Stopped => return Err(NotesError::Closed),
            }
        }
        if recorded_plan(open)?.is_some_and(|plan| plan.holders.is_empty()) {
            hub.rename_finish()?;
        }
        Ok(renamed)
    }

    /// Renames the tag in one holder's file, then its record, in the holder's write turn,
    /// reading in it whether the plan still lists the holder and the file edit a stopped run
    /// began on it. A note left as it was is logged.
    fn rename_one(
        &self,
        edit: &AppEdit,
        hub: &TagHub,
        holder: &Holder,
        from: &str,
        to: &str,
    ) -> InNote {
        let id = holder.id.as_str();
        let (mut record, mut unsure, mut began) = (false, false, false);
        // The renamed body's `#tags`, from the edit to the record's write after it.
        let body_tags = Cell::new(None);
        let renamed = self.order.run(id, |turn| {
            let edited = edit.run_then(
                turn,
                Precondition::Held,
                ChangeSource::AppEdit,
                |text| {
                    if !hub.rename_listed(id)? {
                        return Ok(None);
                    }
                    let before = content_hash(text);
                    if let Some(started) = hub.rename_started(id)? {
                        if before == started.after {
                            return Ok(None);
                        }
                        if before != started.before {
                            unsure = true;
                            return Ok(None);
                        }
                    }
                    #[cfg(feature = "test-hooks")]
                    if self.fail_rename_edit.swap(false, Ordering::Relaxed) {
                        return Err(NotesError::Storage(StorageError::Invalid {
                            what: "a test failed this edit".to_owned(),
                        }));
                    }
                    let Some((next, tags)) = next_text(text, holder.day, from, to)? else {
                        return Ok(None);
                    };
                    hub.rename_start(id, &before, &content_hash(&next))?;
                    began = true;
                    body_tags.set(Some(tags));
                    Ok(Some(next))
                },
                || {
                    #[cfg(feature = "test-hooks")]
                    if self.crash_after_rename_write.swap(false, Ordering::Relaxed) {
                        return Err(NotesError::Closed);
                    }
                    record = hub.rename_in(id)?;
                    if let Some(tags) = body_tags.take() {
                        self.cache_body_tags(hub, id, &tags);
                    }
                    Ok::<_, NotesError>(record)
                },
                &mut || {
                    #[cfg(feature = "test-hooks")]
                    if let Some(hook) = self
                        .rename_lands
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .take()
                    {
                        hook();
                    }
                },
            )?;
            Ok::<_, NotesError>(match edited {
                Edited::Unchanged if unsure => {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id = id,
                        "a note changed outside since a stopped tag rename began it; its file is left"
                    );
                    InNote::Unsure
                }
                Edited::Wrote { .. } => InNote::Written,
                Edited::Unchanged if record => InNote::Written,
                Edited::Unchanged => InNote::Unchanged,
                // No file holds the tags: the record is the note's only copy.
                Edited::Kept(Kept::NoRow | Kept::NoFile | Kept::NotMarkdown) => {
                    match hub.rename_in(id)? {
                        true => InNote::Written,
                        false => InNote::Unchanged,
                    }
                }
                Edited::Kept(kept) => {
                    // Its file was not written: the edit this attempt began on it is moot. One a
                    // stopped run began stays: it is what that run wrote.
                    if began {
                        hub.rename_unstart(id)?;
                    }
                    tracing::info!(
                        scope = SCOPE,
                        note_id = id,
                        ?kept,
                        "a tag rename left a note"
                    );
                    match kept_is_retryable(&kept) {
                        true => InNote::Again,
                        false => InNote::Failed,
                    }
                }
            })
        });
        renamed.unwrap_or_else(|error| {
            if matches!(error, NotesError::Closed) {
                return InNote::Stopped;
            }
            tracing::warn!(
                scope = SCOPE,
                note_id = id,
                "a tag rename could not write a note: {error}"
            );
            InNote::Failed
        })
    }
}

impl NotesService {
    /// The renamed body's `#tags` cached ([`TagHub::cache_body_tags`]). The cache is derived:
    /// one that fails is logged, and the vault's read back of the file writes it again.
    fn cache_body_tags(&self, hub: &TagHub, id: &str, tags: &[String]) {
        #[cfg(feature = "test-hooks")]
        let failed = self.fail_rename_body_cache.swap(false, Ordering::Relaxed);
        #[cfg(not(feature = "test-hooks"))]
        let failed = false;
        let cached = match failed {
            true => Err(StorageError::Invalid {
                what: "a test failed this cache write".to_owned(),
            }),
            false => hub.cache_body_tags(id, tags),
        };
        if let Err(error) = cached {
            tracing::warn!(
                scope = SCOPE,
                note_id = id,
                "a renamed body's tags were not cached; the next read of its file caches them: {error}"
            );
        }
    }
}

/// The recorded rename's plan; a row that does not read is an error here (the resume at open
/// drops it).
pub(super) fn recorded_plan(open: &OpenVault) -> Result<Option<RenamePlan>, NotesError> {
    match open.vault.tag_rename_recorded()? {
        None => Ok(None),
        Some(Recorded::Plan(plan)) => Ok(Some(plan)),
        Some(Recorded::Unreadable(what)) => Err(StorageError::Failed { what }.into()),
    }
}

/// Waits for the open walk's end (`Indexed`), `false` when `cancel` or the tier ends it first.
/// Facts the receiver lost (`Lagged`) may hold it or not: the wait goes on, so the resume
/// never starts beside the walk; an `Indexed` lost so leaves the rename to the next open.
fn walked(facts: &mut Receiver<Applied>, cancel: &dyn Fn() -> bool) -> bool {
    loop {
        if cancel() {
            return false;
        }
        match facts.try_recv() {
            Ok(Applied::Indexed { .. }) => return true,
            Ok(_) | Err(TryRecvError::Lagged(_)) => {}
            Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(50)),
            Err(TryRecvError::Closed) => return false,
        }
    }
}

/// The file's next text and its body's `#tags`, `None` when it does not carry the tag: a note's
/// header tags and the body's `#tags` renamed, every other key keeping its lines. A day's header
/// is left.
fn next_text(
    text: &str,
    day: bool,
    from: &str,
    to: &str,
) -> Result<Option<(String, Vec<String>)>, NotesError> {
    let parsed = parse_markdown_note(text)?;
    let frontmatter = match &parsed.frontmatter {
        YamlValue::Map(map) => (**map).clone(),
        _ => YamlMap::new(),
    };
    let before = file_header_tags(&frontmatter);
    let change = match day {
        true => None,
        false => {
            let after = renamed_list(&before, from, to);
            header_tags::compare(&before, &after).map(|change| (after, change))
        }
    };
    let body = rewrite_markdown(&parsed.content, from, to);
    if change.is_none() && body.is_none() {
        return Ok(None);
    }
    let mut next = frontmatter.clone();
    if let Some((after, change)) = &change {
        header_tags::set_tags(&mut next, after, Some(change));
    }
    let content = body.unwrap_or_else(|| parsed.content.clone());
    let edited = change.is_some();
    let tags = extract_markdown(&content);
    let text = serialize_updated_note(parsed, &frontmatter, next, &content, edited)?;
    Ok(Some((text, tags)))
}

#[cfg(test)]
mod tests {
    use tokio::sync::broadcast;

    use super::*;

    fn removed() -> Applied {
        Applied::Removed {
            note_id: "n".into(),
            path: "n.md".into(),
            source: ChangeSource::Watcher,
        }
    }

    /// Facts lost to a slow receiver may or may not hold the walk's end: the wait goes on until
    /// `Indexed` comes, or the wait is cancelled.
    #[test]
    fn lost_facts_do_not_end_the_wait_for_the_walk() {
        let (tx, mut facts) = broadcast::channel(2);
        for _ in 0..4 {
            tx.send(removed()).unwrap();
        }
        let polls = std::cell::Cell::new(0);
        let cancel = || {
            polls.set(polls.get() + 1);
            polls.get() > 5
        };
        assert!(
            !walked(&mut facts, &cancel),
            "the lost facts ended the wait"
        );

        for _ in 0..4 {
            tx.send(removed()).unwrap();
        }
        tx.send(Applied::Indexed { complete: true }).unwrap();
        assert!(walked(&mut facts, &|| false));
    }
}
