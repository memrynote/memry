//! A locked note's file the watcher reports changed or removed: the lock answers first
//! ([`Locks::restore`]), so its outside change reaches neither the document nor the record.

use super::{Applier, SCOPE, Step};
use crate::locks::Locks;
use crate::vault::note_file::NoteFile;

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
}
