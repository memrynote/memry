//! Who holds the editor's documents: a window's open and close, the sweep of unheld ones past
//! their grace period, and the queries over the holders.

use super::Editor;
use crate::api::tasks_write::now_ms;

impl Editor {
    /// `holder` closes `note_id`. False when it did not hold it.
    pub fn release(&self, note_id: &str, holder: &str) -> bool {
        self.resident().release(note_id, holder, now_ms())
    }

    /// A window that is gone lets go of everything it held; returns those ids.
    pub fn release_holder(&self, holder: &str) -> Vec<String> {
        self.resident().release_holder(holder, now_ms())
    }

    /// Unloads the documents nobody has held for the grace period; returns them.
    pub fn sweep(&self, now_ms: i64) -> Vec<String> {
        self.resident().sweep(now_ms)
    }

    /// Whether any holder has `note_id` open.
    pub fn is_open(&self, note_id: &str) -> bool {
        self.resident().is_held(note_id)
    }

    /// Whether a holder has `note_id` open, or the last one closed it less than the grace
    /// period ago (its last save may still be on the way).
    pub fn held_lately(&self, note_id: &str) -> bool {
        self.resident().held_lately(note_id, now_ms())
    }

    /// Every note some holder has open, sorted.
    pub fn open_note_ids(&self) -> Vec<String> {
        self.resident().held_ids()
    }
}
