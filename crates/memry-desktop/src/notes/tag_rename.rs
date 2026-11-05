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
//!    and the record finds the after text on resume and renames the record alone, from the
//!    lists it had (an outside edit read meanwhile may have carried the renamed header into it).
//!    Text that is neither changed since, by an edit outside: whether the file took the rename
//!    cannot be told, so it is not written again, its record takes the new name from the lists
//!    it had, and it is answered in `failed_note_ids`.
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
//! then.
//!
//! A case-only rename (`Work` to `work`) respells the files and records and leaves the
//! `tag_definition` under its id: the two spellings are one tag (§13.7.7), and a definition under
//! the second spelling is what the core's projection cannot hold beside the first (#3847).
//!
//! Divergences from Electron, stated: a renamed pin reads as pinned when this device applied the
//! rename (the projection stamps a newly pinned spelling), where Electron kept the pin's time;
//! a day's frontmatter `tags:` keep the old name.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use memry_core::api::auth::ensure_device_identity;
use memry_core::api::errors::StorageError;
use memry_core::api::tag_hub::TagHub;
use memry_core::domain::header_tags;
use memry_core::domain::note_stats::header_tags as file_header_tags;
use memry_core::domain::tag_body_rename::{is_inline_tag_name, rewrite_markdown};
pub use memry_core::domain::tag_rename::RenameJob;
use memry_core::domain::tag_rename::{Holder, Started};
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
    pub notes_written: u32,
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
        let hub = self.tag_hub(open)?;
        let Some(_running) = Running::claim(&self.renaming) else {
            let running = hub
                .rename_recorded()?
                .map_or_else(|| job.clone(), |plan| plan.job);
            return Err(NotesError::TagRenameInProgress {
                from: running.from,
                to: running.to,
            });
        };
        let holders = open.search.tag_rename_holders(&job.from)?;
        if let Some(other) = hub.rename_begin(job, holders)? {
            let left = hub.rename_recorded()?.map_or(0, |plan| plan.holders.len());
            return Err(NotesError::TagRenameUnfinished {
                from: other.from,
                to: other.to,
                left,
            });
        }
        self.run_rename(open, &hub, progress, stop)
    }

    /// Finishes the rename an earlier run recorded and did not finish, if any; `stop` ends it
    /// between two notes, leaving it recorded. A record that does not read (one with no plan)
    /// is dropped, and logged.
    pub fn resume_tag_rename(
        &self,
        open: &OpenVault,
        stop: &dyn Fn() -> bool,
    ) -> Result<Option<TagRenamed>, NotesError> {
        let hub = self.tag_hub(open)?;
        // A rename asked meanwhile runs the same plan.
        let Some(_running) = Running::claim(&self.renaming) else {
            return Ok(None);
        };
        match hub.rename_recorded() {
            Ok(Some(_)) => {}
            Ok(None) => return Ok(None),
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    "dropping a tag rename that does not read: {error}"
                );
                hub.rename_finish()?;
                return Ok(None);
            }
        }
        tracing::info!(scope = SCOPE, "resuming an interrupted tag rename");
        self.run_rename(open, &hub, &mut |_, _| {}, stop).map(Some)
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
                if matches!(
                    notes.tag_hub(open).map(|hub| hub.rename_recorded()),
                    Ok(Ok(None))
                ) {
                    return Ok(());
                }
                loop {
                    if cancel.is_cancelled() {
                        return Ok(());
                    }
                    match facts.try_recv() {
                        Ok(Applied::Indexed { .. }) | Err(TryRecvError::Lagged(_)) => break,
                        Ok(_) => {}
                        Err(TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(50)),
                        Err(TryRecvError::Closed) => return Ok(()),
                    }
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

    fn tag_hub(&self, open: &OpenVault) -> Result<TagHub, NotesError> {
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
        let Some(plan) = hub.rename_recorded()? else {
            return Ok(TagRenamed::default());
        };
        let (from, to) = (plan.job.from.as_str(), plan.job.to.trim());
        let (holders, started) = (&plan.holders, plan.started.as_ref());
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
            match self.rename_one(&edit, hub, holder, started, from, to) {
                InNote::Written => renamed.notes_written += 1,
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
            match self.rename_one(&edit, hub, holder, started, from, to) {
                InNote::Written => renamed.notes_written += 1,
                InNote::Unchanged => {}
                InNote::Again | InNote::Failed | InNote::Unsure => {
                    renamed.failed_note_ids.push(holder.id.clone());
                }
                InNote::Stopped => return Err(NotesError::Closed),
            }
        }
        if hub
            .rename_recorded()?
            .is_some_and(|plan| plan.holders.is_empty())
        {
            hub.rename_finish()?;
        }
        Ok(renamed)
    }

    /// Renames the tag in one holder's file, then its record, in the holder's write turn. A
    /// note left as it was is logged. `started` is the file edit a stopped run had begun.
    fn rename_one(
        &self,
        edit: &AppEdit,
        hub: &TagHub,
        holder: &Holder,
        started: Option<&Started>,
        from: &str,
        to: &str,
    ) -> InNote {
        let id = holder.id.as_str();
        let started = started.filter(|started| started.id == id);
        let (mut record, mut unsure) = (false, false);
        let renamed = self.order.run(id, |turn| {
            let edited = edit.run_then(
                turn,
                Precondition::Held,
                ChangeSource::AppEdit,
                |text| {
                    let before = content_hash(text);
                    if let Some(started) = started {
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
                    let next = next_text(text, holder.day, from, to)?;
                    if let Some(next) = &next {
                        hub.rename_start(id, &before, &content_hash(next))?;
                    }
                    Ok(next)
                },
                || {
                    #[cfg(feature = "test-hooks")]
                    if self.crash_after_rename_write.swap(false, Ordering::Relaxed) {
                        return Err(NotesError::Closed);
                    }
                    record = hub.rename_in(id)?;
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
                    // Its file was not written: what a stopped run began on it is moot.
                    hub.rename_unstart(id)?;
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

/// This service running a rename, until dropped.
struct Running<'a>(&'a AtomicBool);

impl<'a> Running<'a> {
    fn claim(flag: &'a AtomicBool) -> Option<Self> {
        (!flag.swap(true, Ordering::SeqCst)).then_some(Self(flag))
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// The file's next text, `None` when it does not carry the tag: a note's header tags and the
/// body's `#tags` renamed, every other key keeping its lines. A day's header is left.
fn next_text(text: &str, day: bool, from: &str, to: &str) -> Result<Option<String>, NotesError> {
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
    Ok(Some(serialize_updated_note(
        parsed,
        &frontmatter,
        next,
        &content,
        edited,
    )?))
}
