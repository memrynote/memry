//! A locked note's file the watcher reports changed or removed: the lock answers first
//! ([`Locks::restore`]), so its outside change reaches neither the document nor the record.

use super::{Applier, SCOPE, Step};
use crate::locks::Locks;
use crate::vault::note_file::{NoteFile, read_note_lossy};

impl Applier {
    /// `Some` when the file is the lock's to answer: its locked text is back (`Done`), or that
    /// failed after its version was kept (`Retry`; a removal waits for the next open's rescan).
    /// `None` when it goes on as any file's.
    pub(super) fn restored(
        &self,
        note_id: &str,
        path: &str,
        changed: Option<&NoteFile>,
    ) -> Option<Step> {
        match Locks::new(&self.root, &self.vault).restore(note_id, path, changed) {
            Ok(true) => Some(Step::Done),
            Ok(false) => None,
            Err(error) => {
                tracing::error!(
                    scope = SCOPE,
                    note_id,
                    "a locked note's outside change was not put back: {error}"
                );
                Some(Step::Retry(path.to_owned()))
            }
        }
    }

    /// [`Self::restored`] for a locked note's file this build cannot read as text: one that is
    /// not UTF-8 is kept as the text Electron reads it as, then the locked text is written
    /// back. One past the read cap is left as it is: no version could hold it, and writing over
    /// it would lose it.
    pub(super) fn restored_unreadable(&self, note_id: &str, path: &str) -> Option<Step> {
        match self.vault.locks().is_note_locked(note_id, Some(path)) {
            Ok(true) => {}
            Ok(false) => return None,
            Err(error) => {
                tracing::error!(scope = SCOPE, note_id, "the lock was not read: {error}");
                return None;
            }
        }
        match read_note_lossy(&self.root, path) {
            Ok(Some(file)) => self.restored(note_id, path, Some(&file)),
            Ok(None) => None,
            Err(error) => {
                tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "a locked note's file that cannot be read stays as it is: {error}"
                );
                None
            }
        }
    }
}
