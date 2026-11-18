//! The take of an owed file (#3534 L5): the port of Electron's `takeOwedFile`
//! (`crdt-external-feed.ts:127`) and `CrdtProvider.takeFileAfterMerge` (`crdt-provider.ts:886`).
//!
//! A note owes its file body when an outside edit of its file could not be fed because its server
//! body had not been pulled ([`memry_core::domain::owed_file_body`]). Once the body is pulled, the
//! file goes on top of it: the document takes the file's text, the server body it replaces is kept
//! as a version (the feed's own rule, `note_snapshots::Reason::OutsideWrite`), the marker is
//! cleared in the feed's transaction, the row records the file's hash, and the write-back is
//! scheduled. Taken when a body pull settles ([`crate::sync::disk`]) and at every open, once the
//! open walk ended ([`super::writeback::after_walk`]), so a marker recorded just as its debt
//! settled is still taken.
//!
//! - **Once.** The marker is read again under the rows' lane, and the feed clears it in the
//!   transaction that replaces the body, so a second take finds nothing owed and keeps no second
//!   version.
//! - **Typing first.** As the consumer does for an outside edit, the windows that have the note
//!   open send their typing before the take, and only then is the lane taken: the same order as
//!   `apply::watched`, so the take and the consumer never wait on each other in reverse.
//! - **Still owed is left owed.** A server body not pulled yet, or one this build cannot write out
//!   whole, leaves the marker (the feed records it again): the file stays as it is and the take
//!   runs again after the next body pull. Electron drops the marker when its document refuses the
//!   file; the core keeps it (`owed_file_body`, "A feed this build refused records the marker
//!   too"), so the file is never written over by a build that cannot read the body.

use std::path::PathBuf;
use std::sync::{Arc, Weak};

use memry_core::api::vault::Vault;
use memry_core::domain::external_feed::{FeedInput, FeedOutcome};
use memry_core::seams::secure_store::SecureStore;

use super::super::body::writing_of;
use super::super::rows::{RowOwner, RowSession, RowStat};
use super::super::{Applied, ChangeSource, converter_for};
use crate::editor::{BARRIER_WAIT, EditorHost};
use crate::vault::embeds::Resolved;
use crate::vault::file_types::FileType;
use crate::vault::note_file::read_note;
use crate::vault::writeback::WriteBack;

const SCOPE: &str = "vault_owed_file";

/// What a take came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Taken {
    /// The document took the file (or already held its text); the marker is gone.
    Took,
    /// The note owes nothing (taken already, never owed), no vault or another one is open, or its
    /// note is gone.
    NotOwed,
    /// The server body is not pulled yet, or the document refused the file: the marker stays.
    StillOwed,
    /// The file is gone: nothing is left to take, and the marker is cleared.
    NoFile,
    /// A read or a write failed; the marker stays for the next take.
    Failed,
}

/// The take of one open vault.
pub(crate) struct OwedFiles {
    pub(super) root: PathBuf,
    pub(super) vault: Arc<Vault>,
    pub(super) rows: Arc<RowOwner>,
    pub(super) session: RowSession,
    pub(super) store: Arc<dyn SecureStore>,
    pub(super) editor: Weak<EditorHost>,
    pub(super) writeback: Arc<WriteBack>,
}

impl OwedFiles {
    /// Takes every owed file of a live note.
    pub(crate) fn sweep(&self) {
        let owed = match self.vault.note_files().owed_file_bodies() {
            Ok(owed) => owed,
            Err(error) => {
                tracing::error!(scope = SCOPE, "the owed files were not listed: {error}");
                return;
            }
        };
        for note_id in &owed {
            self.take(note_id);
        }
    }

    pub(crate) fn take(&self, note_id: &str) -> Taken {
        match self.vault.note_files().owes_file_body(note_id) {
            Ok(true) => {}
            Ok(false) => return Taken::NotOwed,
            Err(error) => {
                tracing::error!(scope = SCOPE, note_id, "the marker was not read: {error}");
                return Taken::Failed;
            }
        }
        let editor = self.editor.upgrade();
        let _typing = editor.and_then(|editor| editor.hold_typing(note_id, BARRIER_WAIT));
        let Ok(mut lane) = self.rows.lane_of(self.session) else {
            return Taken::NotOwed;
        };
        let failed = |what: &str, error: &dyn std::fmt::Display| {
            tracing::error!(scope = SCOPE, note_id, "an owed file {what}: {error}");
            Taken::Failed
        };
        match lane.files().owes_file_body(note_id) {
            Ok(true) => {}
            Ok(false) => return Taken::NotOwed,
            Err(error) => return failed("marker was not read", &error),
        }
        let row = match lane.files().by_id(note_id) {
            Ok(Some(row)) => row,
            Ok(None) => return Taken::NotOwed,
            Err(error) => return failed("row was not read", &error),
        };
        let file = match read_note(&self.root, &row.path) {
            Ok(Some(file)) => file,
            Ok(None) => {
                if let Err(error) = lane.files().clear_owed_file_body(note_id) {
                    return failed("marker was not cleared", &error);
                }
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "the file a note owes does not exist; nothing is left to take"
                );
                return Taken::NoFile;
            }
            Err(error) => return failed("was not read", &error),
        };
        let feed = match self.vault.external_feed(self.store.clone()) {
            Ok(feed) => feed,
            Err(error) => return failed("has no device to write under", &error),
        };
        let split = file.split();
        let embeds = Resolved::of_markdown(&self.root, lane.files(), split.body, &row.path);
        let settings = self.vault.app_settings(self.store.clone()).ok();
        let input = FeedInput {
            note_id,
            markdown: split.body,
            note_path: Some(&row.path),
            writing: writing_of(&file),
            frontmatter: split.block,
            embeds: Some(&embeds),
        };
        match feed.feed(&converter_for(settings.as_ref()), input) {
            Ok(FeedOutcome::Fed | FeedOutcome::Unchanged) => {}
            Ok(FeedOutcome::NoNote) => return Taken::NotOwed,
            Ok(outcome) => {
                tracing::info!(
                    scope = SCOPE,
                    note_id,
                    outcome = ?outcome,
                    "the owed file stays owed"
                );
                return Taken::StillOwed;
            }
            Err(error) => return failed("was not fed", &error),
        }
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: file.raw.len() as u64,
            content_hash: Some(file.hash.clone()),
            file_hash: Some(file.hash.clone()),
        };
        if let Err(error) = lane.put(note_id, &row.path, stat) {
            // The body holds the file and the marker is gone; the row still names the older
            // file, so the write-back keeps this one until the consumer reads it again.
            tracing::error!(scope = SCOPE, note_id, "the row was not recorded: {error}");
        }
        lane.publish(Applied::Changed {
            note_id: note_id.to_owned(),
            path: row.path.clone(),
            content_hash: Some(file.hash),
            source: ChangeSource::Watcher,
        });
        drop(lane);
        self.writeback.schedule(note_id);
        tracing::info!(scope = SCOPE, note_id, "the note took the file it owed");
        Taken::Took
    }
}
