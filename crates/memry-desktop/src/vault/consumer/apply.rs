//! One watcher fact, applied to the rows under the lane. Every handler reads the row as it is
//! when it runs, never as the event described it, so a fact applied twice, or applied after
//! the open walk already covered its path, changes nothing more.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::Instant;

use memry_core::api::external_feed::ExternalFeed;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::app_settings::AppSettings;

use super::activity::report_unread;
use super::body::{Body, Emptied, Write};
use super::identity::{
    Adoption, Candidate, IdentityCtx, IdentityError, NoteIdentity, Removal, Rename,
};
use super::rows::{Lane, RowOwner, RowSession, RowStat};
use super::{Applied, ChangeSource, MAX_RETRIES, MoveKind};
use crate::editor::EditorHost;
use crate::vault::activity::{ActivityLog, ScanActivity};
use crate::vault::app_edit::OwnFiles;
use crate::vault::file_types::{FileType, extension, file_type_of_extension};
use crate::vault::note_file::{NoteFile, large_by_size, large_file_class, record_large_file};
use crate::vault::watch::filter::WatchFilter;
use crate::vault::watch::{VaultEvent, WatchHandle};
use crate::vault::writeback::WriteBack;

mod crossing;
mod locked;
mod read;
mod watched;

use read::Unread;
use watched::refresh_read_back;

const SCOPE: &str = "vault_consumer";

/// What the run loop does after a fact.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Step {
    Done,
    /// The fact could not be applied for a reason that may pass (a locked file, a file
    /// missing mid-save, a failed write): the watcher reports the path again later.
    Retry(String),
    /// The fact waits for the file to settle: the watcher looks at the path again from the
    /// instant on (its next debounce), and the wait is no failure, so it never counts against
    /// [`MAX_RETRIES`].
    Wait(String, Instant),
}

pub(super) struct Applier {
    pub(super) root: PathBuf,
    pub(super) vault: Arc<Vault>,
    pub(super) search: Arc<Search>,
    pub(super) rows: Arc<RowOwner>,
    /// The rows' session of the open this consumer belongs to: a consumer that outlives its
    /// vault's close writes nothing into a later open's rows.
    pub(super) session: RowSession,
    pub(super) identity: Arc<dyn NoteIdentity>,
    /// `None` when this device has no signing key: nothing can be seeded or fed.
    pub(super) feed: Option<ExternalFeed>,
    pub(super) settings: Option<AppSettings>,
    pub(super) activity: Arc<ActivityLog>,
    pub(super) own_files: Arc<OwnFiles>,
    /// The editor whose windows send their typing before an outside edit of their note applies.
    pub(super) editor: Weak<EditorHost>,
    /// `None` in a test that runs no watcher.
    pub(super) watch: Option<WatchHandle>,
    /// The places the exclude patterns cover, whose records never cross (`apply::crossing`).
    pub(super) filter: WatchFilter,
    /// By note id, how many times in a row an outside edit did not reach its record.
    pub(super) untaken: Mutex<HashMap<String, u32>>,
    /// By note id, when its file was first read empty over a row that names other bytes
    /// ([`Applier::emptying`]).
    pub(super) emptied: Mutex<HashMap<String, Emptied>>,
    /// The open's write-back, which writes a body that won over an outside edit; `None` in a
    /// test that runs none.
    pub(super) writeback: Option<Arc<WriteBack>>,
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
            } => self.found(&mut lane, &path, file_type, size, modified_ms, None),
            VaultEvent::Changed {
                note_id,
                path,
                size,
                modified_ms,
                ..
            } => self.watched_change(lane, &note_id, &path, size, modified_ms),
            VaultEvent::Removed { note_id, path } => {
                self.removed(&mut lane, &note_id, &path);
                Step::Done
            }
            VaultEvent::Renamed {
                note_id,
                old_path,
                new_path,
                ..
            } => self.renamed(&mut lane, &note_id, &old_path, &new_path),
            other => {
                log_watch(&other);
                self.report(&other);
                if matches!(other, VaultEvent::WatchFailed { limit: true, .. }) {
                    self.identity.watch_limited(&self.ctx());
                }
                lane.publish(Applied::Vault(other));
                Step::Done
            }
        }
    }

    pub(super) fn ctx(&self) -> IdentityCtx<'_> {
        IdentityCtx {
            root: &self.root,
            vault: &self.vault,
            search: &self.search,
        }
    }

    /// Tells the identity of an outside edit of the note's file (`on_changed`); `false` when its
    /// record did not take it and the fact is to be retried. Once it failed past the retries,
    /// the edit goes on without it, the record keeping what it had, so the row names the file
    /// the document holds and the app's edits of it are not refused for good.
    pub(super) fn told(&self, note_id: &str, previous: &str, file: &NoteFile) -> bool {
        let Err(error) = self
            .identity
            .on_changed(&self.ctx(), note_id, previous, file)
        else {
            self.untaken
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(note_id);
            return true;
        };
        let mut untaken = self.untaken.lock().unwrap_or_else(PoisonError::into_inner);
        let failures = untaken.entry(note_id.to_owned()).or_default();
        *failures += 1;
        if *failures <= MAX_RETRIES {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "an outside edit did not reach the note's record, retried: {error}"
            );
            return false;
        }
        untaken.remove(note_id);
        tracing::error!(
            scope = SCOPE,
            note_id,
            "an outside edit did not reach the note's record after {MAX_RETRIES} retries; its \
             record keeps what it had: {error}"
        );
        true
    }

    /// The identity's [`NoteIdentity::left_large_class`], when the note's file was large.
    fn left_large(
        &self,
        lane: &Lane<'_>,
        note_id: &str,
        file: &NoteFile,
    ) -> Result<(), IdentityError> {
        if !lane.files().is_large_file(note_id)? {
            return Ok(());
        }
        self.identity.left_large_class(&self.ctx(), note_id, file)
    }

    /// A file at `path`. A row there makes it a change of that row's note; otherwise the
    /// identity names its note. `scan` is the open walk's, `None` for a watcher's fact.
    pub(super) fn found(
        &self,
        lane: &mut Lane<'_>,
        path: &str,
        file_type: FileType,
        size: u64,
        modified_ms: i64,
        scan: Option<&mut ScanActivity>,
    ) -> Step {
        let source = walk_or_watcher(scan.as_deref());
        match lane.row_at(path) {
            Ok(Some(row)) => {
                return self.changed(lane, &row.note_id, path, size, modified_ms, scan);
            }
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
            Err(Unread::Missing) => return Step::Retry(path.to_owned()),
            Err(Unread::Failed { failure, .. }) => {
                report_unread(scan, path, failure);
                return Step::Retry(path.to_owned());
            }
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
        if let Some(file) = &file {
            let large = large_file_class(&file.raw).is_some();
            record_large_file(lane.files(), &note_id, large);
        }
        // Seeded on `Existing` too: a crash between a create and its seed leaves an empty
        // body, and a body that is there is left alone; one that is already the file's text
        // answers `Unchanged`, so the row records the file's hash, which a move of the file is
        // paired by. Without a device key the row is still recorded, so the note is not named
        // twice, and the next open seeds it.
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
            file_hash: file.map(|file| file.hash),
        };
        if let Err(error) = lane.put(&note_id, path, stat) {
            tracing::error!(scope = SCOPE, note_id, "the row was not recorded: {error}");
            return Step::Retry(path.to_owned());
        }
        lane.publish(Applied::Added {
            note_id,
            path: path.to_owned(),
            created,
            source,
        });
        self.report_found(path, created, scan);
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
        scan: Option<&mut ScanActivity>,
    ) -> Step {
        let source = walk_or_watcher(scan.as_deref());
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
                Err(Unread::Missing) => return Step::Retry(path.to_owned()),
                Err(Unread::Failed { file_hash, failure }) => {
                    if let Some(step) = self.restored_unreadable(lane, note_id, path) {
                        return step;
                    }
                    // A kept note's file is back, read or not: it is no longer a removal.
                    if row.content_hash.is_none() {
                        self.identity.file_returned(&self.ctx(), note_id);
                    }
                    report_unread(scan, path, failure);
                    // Too large to read whole (past the read cap) is large by its size.
                    if large_by_size(size).is_some() {
                        record_large_file(lane.files(), note_id, true);
                    }
                    record_file_hash(
                        lane,
                        note_id,
                        row.file_hash.as_deref(),
                        file_hash.as_deref(),
                    );
                    return Step::Retry(path.to_owned());
                }
            };
            // Before the feed: whatever it does with the text, the file is what it is. A large
            // file's note that shrank queues its record ahead of the body it is about to get.
            let large = large_file_class(&file.raw).is_some();
            if row.content_hash.is_none()
                && !large
                && let Err(error) = self.left_large(lane, note_id, &file)
            {
                tracing::error!(scope = SCOPE, note_id, "a shrunk large file waits: {error}");
                return Step::Retry(path.to_owned());
            }
            record_large_file(lane.files(), note_id, large);
            if let Some(until) = self.emptying(note_id, row.content_hash.as_deref(), &file) {
                return Step::Wait(path.to_owned(), until);
            }
            // A locked note's outside edit is kept as a version and its locked text written
            // back: it never reaches the document or the peers (`restoreLockedNoteFile`). The
            // lock answers before the typing rule (`outside_edit`), which tells the record.
            if row.content_hash.as_deref() != Some(file.hash.as_str())
                && let Some(step) = self.restored(lane, note_id, path, Some(&file))
            {
                return step;
            }
            let write = match row.content_hash.as_deref() {
                Some(hash) if hash == file.hash => {
                    refresh_read_back(lane, note_id, path, size, file.hash);
                    return Step::Done;
                }
                Some(previous) => {
                    match self.outside_edit(
                        lane,
                        (note_id, source),
                        path,
                        (previous, row.indexed_at),
                        &file,
                    ) {
                        Ok(mark) => Write::Replace(mark),
                        Err(step) => return step,
                    }
                }
                // The row names no text the document holds, so the body may be one the file
                // never had (synced, kept, owed and since pulled): the file only fills an
                // empty body. A conflict between the two is the write-back's (12e-3, Step 17).
                None => {
                    self.identity.file_returned(&self.ctx(), note_id);
                    Write::Seed
                }
            };
            match self.write_body(note_id, path, &file, write) {
                Body::Wrote { holds_file: true } => {
                    // An outside edit of the file the row named (a seed's row names none):
                    // what its frontmatter says reaches the record. Bytes the app wrote carry
                    // their record already.
                    if let Some(previous) = row.content_hash.as_deref()
                        && self.own_files.writer(note_id, &file.hash).is_none()
                        && !self.told(note_id, previous, &file)
                    {
                        // The bytes were read: a move before the retry pairs on them.
                        record_file_hash(lane, note_id, row.file_hash.as_deref(), Some(&file.hash));
                        return Step::Retry(path.to_owned());
                    }
                    Some(file.hash)
                }
                // The document did not take the text: the row keeps naming what it holds, and
                // only the bytes it pairs on move, so a move while closed stays a move.
                Body::Wrote { holds_file: false } | Body::NoKey => {
                    record_file_hash(lane, note_id, row.file_hash.as_deref(), Some(&file.hash));
                    return Step::Done;
                }
                // The bytes were read: a move before the retry stores them pairs on them.
                Body::Failed => {
                    record_file_hash(lane, note_id, row.file_hash.as_deref(), Some(&file.hash));
                    return Step::Retry(path.to_owned());
                }
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
            file_hash: content_hash.clone(),
        };
        if let Err(error) = lane.put(note_id, path, stat) {
            tracing::error!(scope = SCOPE, note_id, "the row was not recorded: {error}");
            return Step::Retry(path.to_owned());
        }
        // The bytes a save wrote that its document did not take (`AppEdit`, `disown`)
        // are its writer's: reported as an outside edit, they would make an open editor drop
        // what was typed since. Any other bytes replaced the app's file; the body took them, so
        // a write-back over them replaces no outside text (#4124).
        let writer = content_hash
            .as_deref()
            .and_then(|hash| self.own_files.writer(note_id, hash));
        let source = match writer {
            Some(writer) if source == ChangeSource::Watcher => writer,
            Some(_) => source,
            None => {
                self.own_files.read_outside(note_id, None);
                source
            }
        };
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: path.to_owned(),
            content_hash,
            source,
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
        // A locked note's file comes back instead of a delete that would reach every device.
        if self.restored(lane, note_id, path, None).is_some() {
            return;
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
            source: ChangeSource::Watcher,
        });
        self.report_removed(path);
    }

    fn renamed(&self, lane: &mut Lane<'_>, note_id: &str, old_path: &str, new_path: &str) -> Step {
        match lane.files().by_id(note_id) {
            Ok(Some(row)) if row.path == new_path => return Step::Done,
            Ok(Some(_)) => {}
            Ok(None) => return Step::Done,
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "note_files could not be read: {error}"
                );
                return Step::Done;
            }
        }
        if let Err(collision) = lane.check(note_id, new_path) {
            tracing::warn!(
                scope = SCOPE,
                note_id,
                "a moved file's row was not moved: {collision}"
            );
            return Step::Done;
        }
        if self.crosses_from_cover(note_id, old_path, new_path) {
            return self.made_anew(lane, new_path);
        }
        // The record first: on a failure both stay at the old path, and the next open's
        // rescan reports the move again.
        match self
            .identity
            .on_renamed(&self.ctx(), note_id, old_path, new_path)
        {
            Ok(Rename::Followed) => {}
            Ok(Rename::Crossed) => return self.recreate(lane, note_id, old_path, new_path),
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "a moved file's note was not updated: {error}"
                );
                return Step::Done;
            }
        }
        if let Err(error) = lane.rename(note_id, new_path) {
            tracing::error!(
                scope = SCOPE,
                note_id,
                "a moved file's row was not moved: {error}"
            );
            return Step::Done;
        }
        lane.publish(Applied::Renamed {
            note_id: note_id.to_owned(),
            old_path: old_path.to_owned(),
            new_path: new_path.to_owned(),
            kind: MoveKind::Renamed,
        });
        self.report_renamed(old_path, new_path);
        Step::Done
    }
}

/// Who found a file: the open walk, which hands its activity in, or the watcher.
fn walk_or_watcher(scan: Option<&ScanActivity>) -> ChangeSource {
    if scan.is_some() {
        ChangeSource::Walk
    } else {
        ChangeSource::Watcher
    }
}

/// Moves the row's pairing hash from `had` to the bytes on disk now, or to none when they are
/// unknown; a hash already there is not written again.
fn record_file_hash(lane: &Lane<'_>, note_id: &str, had: Option<&str>, now: Option<&str>) {
    if had == now {
        return;
    }
    if let Err(error) = lane.record_file_hash(note_id, now) {
        tracing::warn!(
            scope = SCOPE,
            note_id,
            "the file hash was not recorded: {error}"
        );
    }
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
