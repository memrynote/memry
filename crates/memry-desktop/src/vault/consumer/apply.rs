//! One watcher fact, applied to the rows under the lane. Every handler reads the row as it is
//! when it runs, never as the event described it, so a fact applied twice, or applied after
//! the open walk already covered its path, changes nothing more.

use std::path::PathBuf;
use std::sync::Arc;

use memry_core::api::external_feed::ExternalFeed;
use memry_core::api::vault::Vault;
use memry_core::domain::app_settings::AppSettings;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::{
    CalloutTypes, sanitize_callout_type_definitions,
};
use memry_core::markdown::shared::writing_tools::{WritingFrontmatter, writing_of_yaml};

use super::identity::{Adoption, Candidate, IdentityCtx, NoteIdentity, Removal};
use super::rows::{Lane, RowOwner, RowSession, RowStat};
use super::{Applied, ChangeSource};
use crate::vault::activity::{ActivityInput, ActivityKind, ActivityLog, ActivitySource};
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::{NoteFile, read_note};
use crate::vault::watch::VaultEvent;
use crate::vault::watch::reconcile::modified_ms;

const SCOPE: &str = "vault_consumer";

/// What the run loop does after a fact.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    Done,
    /// The fact could not be applied for a reason that may pass (a locked file, a failed
    /// write): the watcher reports the path again later.
    Retry(String),
}

pub(super) struct Applier {
    pub(super) root: PathBuf,
    pub(super) vault: Arc<Vault>,
    pub(super) rows: Arc<RowOwner>,
    /// The rows' session of the open this consumer belongs to: a consumer that outlives its
    /// vault's close writes nothing into a later open's rows.
    pub(super) session: RowSession,
    pub(super) identity: Arc<dyn NoteIdentity>,
    /// `None` when this device has no signing key: nothing can be seeded or fed.
    pub(super) feed: Option<ExternalFeed>,
    pub(super) settings: Option<AppSettings>,
    pub(super) activity: Arc<ActivityLog>,
}

/// A file that stays unreadable is reported once in this window, not on every event.
const UNREADABLE_REPORT_MS: i64 = 60 * 60 * 1000;

/// Whether the note's document now holds the whole file: only then does the row record the
/// file's hash. `BodyPresent` is not: a seed answers it before it compares any text, so the
/// body it left alone can differ from the file. Nor is a file whose `writing` frontmatter
/// could not be read: the feed was not told it.
fn holds_file(outcome: FeedOutcome, writing: Option<&WritingFrontmatter>) -> bool {
    matches!(outcome, FeedOutcome::Fed | FeedOutcome::Unchanged) && writing.is_some()
}

/// The writing tools data the whole file says (none without the key, or with the author's
/// own), or `None` when its frontmatter does not parse and may hold some.
fn writing_of(file: &NoteFile) -> Option<WritingFrontmatter> {
    if file.split().block.is_none() {
        return Some(WritingFrontmatter::default());
    }
    file.parse()
        .ok()
        .map(|parsed| writing_of_yaml(&parsed.frontmatter))
}

/// What a body write came to.
enum Body {
    /// The feed answered; `holds_file` when the document now holds the whole file.
    Wrote { holds_file: bool },
    /// This device has no signing key: nothing was written (the tier said so once).
    NoKey,
    /// The write failed; the fact is retried.
    Failed,
}

impl Applier {
    pub(super) fn apply(&self, event: VaultEvent) -> Step {
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Step::Done;
        };
        match event {
            VaultEvent::Added {
                path,
                file_type,
                size,
                modified_ms,
                ..
            } => self.found(
                &mut lane,
                &path,
                file_type,
                size,
                modified_ms,
                ActivitySource::Watcher,
            ),
            VaultEvent::Changed {
                note_id,
                path,
                size,
                modified_ms,
                ..
            } => self.changed(&mut lane, &note_id, &path, size, modified_ms),
            VaultEvent::Removed { note_id, path } => {
                self.removed(&mut lane, &note_id, &path);
                Step::Done
            }
            VaultEvent::Renamed {
                note_id,
                old_path,
                new_path,
                ..
            } => {
                self.renamed(&mut lane, &note_id, &old_path, &new_path);
                Step::Done
            }
            other => {
                log_watch(&other);
                self.report(&other);
                lane.publish(Applied::Vault(other));
                Step::Done
            }
        }
    }

    /// The activity log's share of a fact that changes no row (`watcher.ts` reports these).
    fn report(&self, event: &VaultEvent) {
        match event {
            VaultEvent::Unsupported { path } => {
                self.activity
                    .record_skipped(&self.root, path, ActivitySource::Watcher);
            }
            VaultEvent::Unreadable { path, reason } => {
                self.activity.record(
                    &self.root,
                    ActivityInput::new(ActivityKind::Failed, ActivitySource::Watcher)
                        .path(path.as_str())
                        .reason("read-failed")
                        .message(reason.as_str())
                        .dedupe(format!("read-failed:{path}"), UNREADABLE_REPORT_MS),
                );
            }
            _ => {}
        }
    }

    /// A file the open walk found. Goes through the same handler as a watcher's `Added`. A
    /// row whose size is the file's and that was written after the file's last modification
    /// is not read again, as the rescan does: reading every file costs a vault-sized read. A
    /// markdown row without a hash is: its text never reached the note.
    pub(super) fn walked(&self, path: &str, meta: &std::fs::Metadata) -> Step {
        let Some(file_type) = file_type_of_extension(&extension(path)) else {
            return Step::Done;
        };
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Step::Done;
        };
        let modified = modified_ms(meta);
        if let Ok(Some(row)) = lane.row_at(path)
            && row.file_size == i64::try_from(meta.len()).ok()
            && modified <= row.indexed_at
            && (file_type != FileType::Markdown || row.content_hash.is_some())
        {
            return Step::Done;
        }
        self.found(
            &mut lane,
            path,
            file_type,
            meta.len(),
            modified,
            ActivitySource::Scan,
        )
    }

    fn ctx(&self) -> IdentityCtx<'_> {
        IdentityCtx {
            root: &self.root,
            vault: &self.vault,
        }
    }

    /// A file at `path`. A row there makes it a change of that row's note; otherwise the
    /// identity names its note. A file the watcher found that got a new note is `added` in the
    /// activity log, as Electron records an add no note claimed.
    fn found(
        &self,
        lane: &mut Lane<'_>,
        path: &str,
        file_type: FileType,
        size: u64,
        modified_ms: i64,
        origin: ActivitySource,
    ) -> Step {
        match lane.row_at(path) {
            Ok(Some(row)) => return self.changed(lane, &row.note_id, path, size, modified_ms),
            Ok(None) => {}
            Err(error) => {
                tracing::error!(scope = SCOPE, "note_files could not be read: {error}");
                return Step::Retry(path.to_owned());
            }
        }
        // Before the file is read: what nothing adopts costs nothing.
        if !self.identity.adopts() {
            return Step::Done;
        }
        if let Err(collision) = lane.check_free(path) {
            tracing::warn!(
                scope = SCOPE,
                note_id = collision.existing_note_id,
                "a new file is the same file as this note's on a case-insensitive volume; not indexed"
            );
            return Step::Done;
        }
        let file = match self.read(path, file_type) {
            Ok(file) => file,
            Err(step) => return step,
        };
        let candidate = Candidate {
            path,
            file_type,
            size,
            modified_ms,
            file: file.as_ref(),
        };
        let (note_id, created) = match self.identity.adopt_or_create(&self.ctx(), &candidate) {
            Ok(Adoption::Defer) => return Step::Done,
            Ok(Adoption::Existing(id)) => (id, false),
            Ok(Adoption::Created(id)) => (id, true),
            Err(error) => {
                tracing::error!(scope = SCOPE, "a new file got no note: {error}");
                return Step::Retry(path.to_owned());
            }
        };
        // Seeded on `Existing` too: a crash between a create and its seed leaves an empty
        // body, and a body that is there is left alone. Without a device key the row is
        // still recorded, so the note is not named twice, and the next open seeds it.
        let content_hash = match &file {
            None => None,
            Some(file) => match self.write_body(&note_id, path, file, Write::Seed) {
                Body::Wrote { holds_file } => holds_file.then(|| file.hash.clone()),
                Body::NoKey => None,
                Body::Failed => return Step::Retry(path.to_owned()),
            },
        };
        let stat = RowStat {
            file_type,
            size,
            content_hash,
        };
        if let Err(error) = lane.put(&note_id, path, stat) {
            tracing::error!(scope = SCOPE, note_id, "the row was not recorded: {error}");
            return Step::Retry(path.to_owned());
        }
        lane.publish(Applied::Added {
            note_id,
            path: path.to_owned(),
            created,
        });
        if created && origin == ActivitySource::Watcher {
            self.activity.record(
                &self.root,
                ActivityInput::new(ActivityKind::Added, origin).path(path),
            );
        }
        Step::Done
    }

    /// The note's file at `path` differs from its row.
    fn changed(
        &self,
        lane: &mut Lane<'_>,
        note_id: &str,
        path: &str,
        size: u64,
        modified_ms: i64,
    ) -> Step {
        let Some(file_type) = file_type_of_extension(&extension(path)) else {
            return Step::Done;
        };
        let row = match lane.files().by_id(note_id) {
            Ok(Some(row)) => row,
            Ok(None) => return Step::Done,
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "note_files could not be read: {error}"
                );
                return Step::Retry(path.to_owned());
            }
        };
        let content_hash = if file_type == FileType::Markdown {
            let file = match self.read(path, file_type) {
                Ok(Some(file)) => file,
                Ok(None) => return Step::Done,
                Err(step) => return step,
            };
            let write = match row.content_hash.as_deref() {
                // Read back as recorded: the row's time moves on, so the walk does not read it
                // again, unless the body moved since (a pass a crash cut short): then the note
                // stays behind its body for the reconcile.
                Some(hash) if hash == file.hash => {
                    let stat = RowStat {
                        file_type,
                        size,
                        content_hash: Some(file.hash),
                    };
                    if let Err(error) = lane.refresh(note_id, path, stat) {
                        tracing::warn!(
                            scope = SCOPE,
                            note_id,
                            "the row was not refreshed: {error}"
                        );
                    }
                    return Step::Done;
                }
                Some(_) => Write::Replace,
                // The row names no text the document holds, so the body may be one the file
                // never had (synced, kept, owed and since pulled): the file only fills an
                // empty body. A conflict between the two is the write-back's (12e-3, Step 17).
                None => Write::Seed,
            };
            match self.write_body(note_id, path, &file, write) {
                Body::Wrote { holds_file: true } => Some(file.hash),
                Body::Wrote { holds_file: false } | Body::NoKey => return Step::Done,
                Body::Failed => return Step::Retry(path.to_owned()),
            }
        } else {
            if row.file_size == i64::try_from(size).ok() && modified_ms <= row.indexed_at {
                return Step::Done;
            }
            None
        };
        let stat = RowStat {
            file_type,
            size,
            content_hash: content_hash.clone(),
        };
        if let Err(error) = lane.put(note_id, path, stat) {
            tracing::error!(scope = SCOPE, note_id, "the row was not recorded: {error}");
            return Step::Retry(path.to_owned());
        }
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            content_hash,
            source: ChangeSource::Watcher,
        });
        Step::Done
    }

    /// The record goes first; the row only once the identity deleted it.
    fn removed(&self, lane: &mut Lane<'_>, note_id: &str, path: &str) {
        match lane.files().by_id(note_id) {
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(error) => {
                return tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "note_files could not be read: {error}"
                );
            }
        }
        match self.identity.on_removed(&self.ctx(), note_id, path) {
            Ok(Removal::Deleted) => {}
            Ok(Removal::Kept) => {
                // The row stays, naming a file that is gone: it names no text any more, so a
                // file that shows up at its path later is not taken for this note's.
                if let Err(error) = lane.forget_hash(note_id) {
                    tracing::error!(
                        scope = SCOPE,
                        note_id,
                        "a kept note's row kept its hash: {error}"
                    );
                }
                return;
            }
            Err(error) => {
                // The row stays; the next open's rescan reports the removal again.
                return tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "a removed file's note was not deleted: {error}"
                );
            }
        }
        if let Err(error) = lane.remove(note_id) {
            return tracing::error!(scope = SCOPE, note_id, "the row was not removed: {error}");
        }
        lane.publish(Applied::Removed {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
        });
        self.activity.record(
            &self.root,
            ActivityInput::new(ActivityKind::Removed, ActivitySource::Watcher).path(path),
        );
    }

    fn renamed(&self, lane: &mut Lane<'_>, note_id: &str, old_path: &str, new_path: &str) {
        match lane.files().by_id(note_id) {
            Ok(Some(row)) if row.path == new_path => return,
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(error) => {
                return tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "note_files could not be read: {error}"
                );
            }
        }
        if let Err(collision) = lane.check(note_id, new_path) {
            return tracing::warn!(
                scope = SCOPE,
                note_id,
                "a moved file's row was not moved: {collision}"
            );
        }
        // The record first: on a failure both stay at the old path, and the next open's
        // rescan reports the move again.
        if let Err(error) = self
            .identity
            .on_renamed(&self.ctx(), note_id, old_path, new_path)
        {
            return tracing::error!(
                scope = SCOPE,
                note_id,
                "a moved file's note was not updated: {error}"
            );
        }
        if let Err(error) = lane.rename(note_id, new_path) {
            return tracing::error!(
                scope = SCOPE,
                note_id,
                "a moved file's row was not moved: {error}"
            );
        }
        lane.publish(Applied::Renamed {
            note_id: note_id.to_owned(),
            old_path: old_path.to_owned(),
            new_path: new_path.to_owned(),
        });
        self.activity.record(
            &self.root,
            ActivityInput::new(ActivityKind::Renamed, ActivitySource::Watcher)
                .path(new_path)
                .old_path(old_path),
        );
    }

    /// The markdown file at `path`, read once; `Ok(None)` for every other kind, and for a
    /// markdown file that is gone (its removal follows).
    fn read(&self, path: &str, file_type: FileType) -> Result<Option<NoteFile>, Step> {
        if file_type != FileType::Markdown {
            return Ok(None);
        }
        match read_note(&self.root, path) {
            Ok(Some(file)) => Ok(Some(file)),
            Ok(None) => Err(Step::Done),
            Err(error) => {
                tracing::warn!(scope = SCOPE, "a vault file could not be read: {error}");
                Err(Step::Retry(path.to_owned()))
            }
        }
    }

    /// Seeds or replaces the note's body with the file's text.
    fn write_body(&self, note_id: &str, path: &str, file: &NoteFile, write: Write) -> Body {
        let Some(feed) = &self.feed else {
            return Body::NoKey;
        };
        let split = file.split();
        // `None` for a frontmatter that does not parse says nothing about the writing state,
        // so the document keeps what it holds, and the file is not taken as read.
        let writing = writing_of(file);
        let input = FeedInput {
            note_id,
            markdown: split.body,
            note_path: Some(path),
            writing: writing.clone(),
            frontmatter: split.block,
        };
        let converter = converter_for(self.settings.as_ref());
        let outcome = match write {
            Write::Seed => feed.seed_body_if_empty(&converter, input),
            Write::Replace => feed.feed(&converter, input),
        };
        match outcome {
            Ok(outcome) => {
                if !matches!(outcome, FeedOutcome::Fed | FeedOutcome::Unchanged) {
                    tracing::warn!(
                        scope = SCOPE,
                        note_id,
                        outcome = ?outcome,
                        "a file's text did not reach its note"
                    );
                }
                Body::Wrote {
                    holds_file: holds_file(outcome, writing.as_ref()),
                }
            }
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "a file's text did not reach its note: {error}"
                );
                Body::Failed
            }
        }
    }
}

/// The converter with the vault's callout types. Read for every write, so a callout type added
/// in the app is known to the next feed and write-back.
pub(crate) fn converter_for(settings: Option<&AppSettings>) -> Converter {
    let raw = settings.and_then(|settings| {
        settings
            .get_path("editor.calloutTypes")
            .inspect_err(|error| {
                tracing::warn!(scope = SCOPE, "callout types could not be read: {error}");
            })
            .ok()
            .flatten()
    });
    let definitions = raw
        .map(|value| sanitize_callout_type_definitions(&value))
        .unwrap_or_default();
    Converter::new(CalloutTypes::new(definitions))
}

#[derive(Clone, Copy)]
enum Write {
    Seed,
    Replace,
}

fn log_watch(event: &VaultEvent) {
    match event {
        VaultEvent::WatchFailed { limit, .. } => {
            tracing::warn!(scope = SCOPE, limit, "the vault watcher failed");
        }
        VaultEvent::Unreachable | VaultEvent::Reachable => {
            tracing::warn!(
                scope = SCOPE,
                kind = event.kind(),
                "vault reachability changed"
            );
        }
        other => tracing::debug!(scope = SCOPE, kind = other.kind()),
    }
}
