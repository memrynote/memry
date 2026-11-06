//! A tag merged into another (`tags:merge`) or deleted (`tags:delete`) across the vault, and a
//! tag taken off one note (`tags:remove-from-note`), after Electron's `ipc/tags-handlers.ts`: the
//! tag itself, never its `/` children or a body's `#tags` (`memry_core::domain::tag_retag`).
//!
//! Each note and journal day carrying it (`Search::tag_holders`: its record, a note's header as
//! the index read it) goes in its own write turn, as a rename's does (`super::tag_rename`): a
//! note's frontmatter `tags:` through [`AppEdit`] with [`Precondition::Held`], the body left as
//! Electron's `editNoteHeaderTags` leaves it; then, once the file holds it, its record's `tags`
//! and `pinnedTags` (`TagHub::retag_in`, one outbox row). A day's file is the author's (#3931):
//! its record alone. A note with no file to edit has its record alone. A note the seam keeps is
//! tried once more after the write-back ran what it had scheduled; one still kept keeps the tag
//! in its file and its record and is answered in `failed`, named, with whether asking again can
//! finish it (Electron logs a header write-back that failed and goes on). The tasks and the
//! definitions (`TagHub::merge_shared`, `TagHub::delete_shared`) go first, before any file: a
//! failure there leaves every file as it was, so no file written goes unannounced.
//!
//! Nothing is recorded: asked again, a merge or a delete finds what an earlier run left and
//! converges. A crash between a note's file and its record leaves the record with the tag its
//! header no longer carries: the tag list reads the header, so this device stops counting the
//! note under it while peers still do, until the merge or delete is asked again. Every header
//! edit through [`AppEdit`] has that window; a rename covers it with its start marks
//! (`super::tag_rename`), as running it twice is not safe.
//!
//! Each runs under the rename lock, so one asked while another tag change runs is refused
//! ([`NotesError::TagRenameInProgress`], [`NotesError::TagEditInProgress`]), and so is one asked
//! while a rename is recorded with notes left ([`NotesError::TagRenameUnfinished`]): the
//! rename's resume reads those notes' files as it left them.
//!
//! Divergences from Electron, stated: a delete takes the tag off the tasks too (the core's
//! delete, shared with iOS; the delete dialog counts the tasks among the items it takes the tag
//! off), where Electron's leaves them; a merged pin reads as pinned when this device merged it.

use memry_core::api::errors::StorageError;
use memry_core::api::tag_hub::TagHub;
use memry_core::domain::header_tags;
use memry_core::domain::note_stats::header_tags as file_header_tags;
use memry_core::domain::tag_rename::Holder;
use memry_core::domain::tag_retag::{Retag, merge_target, retagged_list};
/// The name a merged tag goes by in `tags:deleted`, as Electron's `tagKey`.
pub use memry_core::domain::tags::tag_key;
use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, parse_markdown_note, serialize_updated_note,
};

use super::error::{NotesError, SCOPE, kept_is_retryable};
use super::service::NotesService;
use super::tag_rename::{SETTLE, recorded_plan, running_change};
use super::tag_rename_unfinished::holder_title;
use crate::session::OpenVault;
use crate::vault::app_edit::{AppEdit, Edited, Kept, Precondition};
use crate::vault::consumer::ChangeSource;

/// What a merge or a delete came to (`MergeTagResponse`, `DeleteTagResponse`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TagRetagged {
    /// The notes and days whose file or record changed.
    pub written: Vec<String>,
    /// The notes and days that keep the tag: their file could not take the edit.
    pub failed: Vec<KeptNote>,
    /// The tasks retagged.
    pub tasks: u32,
}

/// A note or day that keeps the tag a merge or delete took off the others.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptNote {
    pub id: String,
    /// Its file's name, else its id.
    pub title: String,
    /// Asking again can finish it; `false` only when its file needs fixing first: frontmatter
    /// that does not read, or a value that cannot be written back.
    pub retry_finishes: bool,
}

/// One holder's edit.
enum InNote {
    Written,
    Unchanged,
    /// The seam kept its file: it keeps the tag in its file and its record.
    Kept(Kept),
    Failed(NotesError),
}

impl InNote {
    /// Kept by an edit the file or the document has and the other has not yet.
    fn again(&self) -> bool {
        matches!(self, Self::Kept(kept) if kept_is_retryable(kept))
    }
}

impl NotesService {
    /// Merges `source` into `target` in every note, journal day and task, and moves its
    /// definition (see the module comment). Two names of one tag are refused
    /// ([`NotesError::TagMergeSameTag`]).
    pub fn merge_tag(
        &self,
        open: &OpenVault,
        source: &str,
        target: &str,
    ) -> Result<TagRetagged, NotesError> {
        if tag_key(source).is_empty() || tag_key(target).is_empty() {
            return Err(blank());
        }
        let target = merge_target(source, target).map_err(|_| NotesError::TagMergeSameTag)?;
        self.retag_everywhere(open, source, Some(target))
    }

    /// Takes `tag` off every note, journal day and task, and deletes its definition.
    pub fn delete_tag(&self, open: &OpenVault, tag: &str) -> Result<TagRetagged, NotesError> {
        self.retag_everywhere(open, tag, None)
    }

    /// Takes `tag` off the note or journal day `id`; `false` when it did not carry it.
    pub fn remove_tag_from_note(
        &self,
        open: &OpenVault,
        id: &str,
        tag: &str,
    ) -> Result<bool, NotesError> {
        if id.trim().is_empty() {
            return Err(StorageError::Invalid {
                what: "a note needs an id".to_owned(),
            }
            .into());
        }
        let _running = self.retag_lock(open, tag)?;
        let holders = open.search.tag_holders(tag)?;
        let Some(holder) = holders.iter().find(|holder| holder.id == id) else {
            return Ok(false);
        };
        let (edit, hub) = (
            AppEdit::new(&self.tier, &self.store, open)?,
            self.tag_hub(open)?,
        );
        let mut outcome = self.retag_one(&edit, &hub, holder, tag, None);
        if outcome.again() {
            self.tier.flush(SETTLE);
            outcome = self.retag_one(&edit, &hub, holder, tag, None);
        }
        match outcome {
            InNote::Written => Ok(true),
            InNote::Unchanged => Ok(false),
            InNote::Kept(kept) => Err(NotesError::kept(id, kept)),
            InNote::Failed(error) => Err(error),
        }
    }

    fn retag_everywhere(
        &self,
        open: &OpenVault,
        source: &str,
        target: Option<&str>,
    ) -> Result<TagRetagged, NotesError> {
        let _running = self.retag_lock(open, source)?;
        let (edit, hub) = (
            AppEdit::new(&self.tier, &self.store, open)?,
            self.tag_hub(open)?,
        );
        let holders = open.search.tag_holders(source)?;
        let mut retagged = TagRetagged {
            tasks: match target {
                Some(target) => hub.merge_shared(source, target)?,
                None => hub.delete_shared(source)?,
            },
            ..TagRetagged::default()
        };
        let mut again = Vec::new();
        for holder in holders {
            match self.retag_one(&edit, &hub, &holder, source, target) {
                InNote::Written => retagged.written.push(holder.id),
                // A locked note keeps the tag, as Electron's `keepLockedNoteTags`.
                InNote::Unchanged | InNote::Kept(Kept::Locked) => {}
                outcome if outcome.again() => again.push(holder),
                outcome => retagged.failed.push(kept_note(open, holder.id, &outcome)),
            }
        }
        if !again.is_empty() {
            // A refused edit wrote nothing, so one more try is safe; the flush writes a document
            // that is ahead of its file out first.
            self.tier.flush(SETTLE);
        }
        for holder in again {
            match self.retag_one(&edit, &hub, &holder, source, target) {
                InNote::Written => retagged.written.push(holder.id),
                InNote::Unchanged => {}
                outcome => retagged.failed.push(kept_note(open, holder.id, &outcome)),
            }
        }
        if !retagged.failed.is_empty() {
            tracing::warn!(
                scope = SCOPE,
                failed = ?retagged.failed,
                "a tag merge or delete left notes it could not write with the tag"
            );
        }
        Ok(retagged)
    }

    /// The rename lock for an edit of `tag`, refused while another tag change runs or a rename
    /// is recorded with notes left.
    fn retag_lock(
        &self,
        open: &OpenVault,
        tag: &str,
    ) -> Result<std::sync::MutexGuard<'_, ()>, NotesError> {
        if tag_key(tag).is_empty() {
            return Err(blank());
        }
        let Some(running) = self.claim_rename() else {
            return Err(running_change(open)?);
        };
        if let Some(plan) = recorded_plan(open)? {
            return Err(NotesError::TagRenameUnfinished {
                from: plan.job.from,
                to: plan.job.to,
                left: plan.holders.len(),
            });
        }
        Ok(running)
    }

    /// `source` merged into `target`, or deleted, in one holder's file, then its record, in its
    /// write turn. A note left as it was is logged.
    fn retag_one(
        &self,
        edit: &AppEdit,
        hub: &TagHub,
        holder: &Holder,
        source: &str,
        target: Option<&str>,
    ) -> InNote {
        let id = holder.id.as_str();
        let record = |hub: &TagHub| match hub.retag_in(id, source, target)? {
            Retag::Wrote => Ok::<_, NotesError>(InNote::Written),
            Retag::Unchanged => Ok(InNote::Unchanged),
            Retag::Locked => Ok(InNote::Kept(Kept::Locked)),
        };
        let retagged = self.order.run(id, |turn| {
            // A day's file is its author's: its record owns its tags (#3931).
            if holder.day {
                return record(hub);
            }
            let mut changed = false;
            let edited = edit.run_then(
                turn,
                Precondition::Held,
                ChangeSource::AppEdit,
                |text| {
                    let next = |before: &[String]| Some(retagged_list(before, source, target));
                    Ok(tags_edited(text, next, |_| None)?.map(|(text, _)| text))
                },
                || {
                    changed = hub.retag_in(id, source, target)? == Retag::Wrote;
                    Ok::<_, NotesError>(changed)
                },
                &mut || {},
            )?;
            Ok(match edited {
                Edited::Wrote { .. } => InNote::Written,
                Edited::Unchanged { .. } if changed => InNote::Written,
                Edited::Unchanged { .. } => InNote::Unchanged,
                // No file holds the tags: the record is the note's only copy.
                Edited::Kept(Kept::NoRow | Kept::NoFile | Kept::NotMarkdown) => record(hub)?,
                Edited::Kept(kept) => {
                    tracing::info!(scope = SCOPE, note_id = id, ?kept, "a tag edit left a note");
                    InNote::Kept(kept)
                }
            })
        });
        retagged.unwrap_or_else(|error| {
            tracing::warn!(
                scope = SCOPE,
                note_id = id,
                "a tag edit could not write a note: {error}"
            );
            InNote::Failed(error)
        })
    }
}

/// The holder `id` an edit left as `outcome` said, named.
fn kept_note(open: &OpenVault, id: String, outcome: &InNote) -> KeptNote {
    let retry_finishes = !matches!(
        outcome,
        InNote::Kept(
            Kept::FrontmatterUnreadable | Kept::FrontmatterBroken | Kept::NotRepresentable
        )
    );
    let title = holder_title(open, &id).unwrap_or_else(|error| {
        tracing::warn!(scope = SCOPE, note_id = %id, "a kept note's name did not read: {error}");
        id.clone()
    });
    KeptNote {
        id,
        title,
        retry_finishes,
    }
}

fn blank() -> NotesError {
    StorageError::Invalid {
        what: "a tag needs a name".to_owned(),
    }
    .into()
}

/// `text` with its frontmatter `tags:` made what `header` makes of them (left when it makes
/// `None` or the same list) and its body made what `body` makes of it (left on `None`), every
/// other key keeping its lines; `None` when neither changes, else the text and its body.
pub(super) fn tags_edited(
    text: &str,
    header: impl FnOnce(&[String]) -> Option<Vec<String>>,
    body: impl FnOnce(&str) -> Option<String>,
) -> Result<Option<(String, String)>, NotesError> {
    let parsed = parse_markdown_note(text)?;
    let frontmatter = match &parsed.frontmatter {
        YamlValue::Map(map) => (**map).clone(),
        _ => YamlMap::new(),
    };
    let before = file_header_tags(&frontmatter);
    let change = header(&before)
        .and_then(|after| header_tags::compare(&before, &after).map(|change| (after, change)));
    let body = body(&parsed.content);
    if change.is_none() && body.is_none() {
        return Ok(None);
    }
    let mut next = frontmatter.clone();
    if let Some((after, change)) = &change {
        header_tags::set_tags(&mut next, after, Some(change));
    }
    let content = body.unwrap_or_else(|| parsed.content.clone());
    let edited = change.is_some();
    let text = serialize_updated_note(parsed, &frontmatter, next, &content, edited)?;
    Ok(Some((text, content)))
}
