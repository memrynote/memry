//! Local compaction of the editor's documents (desktop Step 14i, #3531;
//! Electron's `maybeCompact`, `crdt-provider.ts:2220-2251`).
//!
//! The editor counts the bytes each document's log takes: every committed
//! update its listeners hear, a window's edit, a repair or another writer's row.
//! The shell asks on its timer which documents grew by
//! [`COMPACTION_GROWTH_BYTES`] since their last compaction
//! ([`Editor::compaction_due`]) and compacts each ([`Editor::compact`]), which
//! folds the document's local namespace into one snapshot
//! ([`crate::crdt::compact`]).
//!
//! The fold reads the log, not the resident document: it runs on the writer in
//! one transaction, so it holds every row committed before it, whatever the
//! resident copy has caught up with, and a window's edit committed after it
//! lands above the fold point. The resident document is left as it is: it holds
//! the same items, so no window reloads. Pending outbox rows are not touched.
//!
//! Counting starts when the vault opens: a log that grew in an earlier launch
//! waits for this launch's growth. A document nobody opens is not counted.

use std::collections::HashMap;
use std::sync::{MutexGuard, PoisonError};

use super::{Editor, EditorError, Notice};
use crate::crdt::compact::{Folded, fold_compacted};

/// The growth after which a document is compacted: Electron's
/// `ACCUMULATED_BYTES_RECHECK_THRESHOLD` (`crdt-provider.ts:75`).
pub const COMPACTION_GROWTH_BYTES: usize = 512 * 1024;

impl Editor {
    /// Every document whose log took [`COMPACTION_GROWTH_BYTES`] or more since
    /// its last compaction, sorted.
    pub fn compaction_due(&self) -> Vec<String> {
        let mut due: Vec<String> = self
            .grown()
            .iter()
            .filter(|(_, bytes)| **bytes >= COMPACTION_GROWTH_BYTES)
            .map(|(id, _)| id.clone())
            .collect();
        due.sort();
        due
    }

    /// Folds `note_id`'s local namespace into one snapshot of its whole state.
    /// `None`: there was nothing to fold, the log waits on an update it lacks,
    /// or the snapshot would not be smaller, and nothing was written. The
    /// growth count restarts whatever the answer, as Electron's does, so a
    /// document that does not shrink is not tried again on every tick.
    pub fn compact(&self, note_id: &str) -> Result<Option<Folded>, EditorError> {
        self.grown().remove(note_id);
        self.on_writer(|conn| Ok(fold_compacted(conn, note_id)?))
    }

    /// Counts a committed update toward `note_id`'s next compaction; a purge
    /// starts the new document's count from nothing.
    pub(super) fn count_growth(&self, note_id: &str, notice: Notice<'_>) {
        let mut grown = self.grown();
        match notice {
            Notice::Update(update, _) => {
                let bytes = grown.entry(note_id.to_owned()).or_default();
                *bytes = bytes.saturating_add(update.len());
            }
            Notice::Purged => {
                grown.remove(note_id);
            }
        }
    }

    fn grown(&self) -> MutexGuard<'_, HashMap<String, usize>> {
        self.grown.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
