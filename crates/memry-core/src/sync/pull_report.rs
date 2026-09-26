//! What one record pull did, or failed with (chapter 05 §5.14).
//!
//! Split out of [`super::pull`], which re-exports both, so the loop stays
//! under the line ceiling. Nothing here does I/O.

use crate::api::errors::{ApiError, StorageError};

/// What a pull pass failed with. A per-item failure is **not** one of these:
/// it is a count in [`PullReport`].
#[derive(Debug, thiserror::Error)]
pub enum PullError {
    #[error("{source}")]
    Api {
        #[from]
        source: ApiError,
    },
    #[error("{source}")]
    Storage {
        #[from]
        source: StorageError,
    },
}

/// What one pass did. Counts rather than a boolean, because the breaker needs
/// three separate facts about the same page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PullReport {
    pub pages: u32,
    pub applied: usize,
    pub deleted: usize,
    /// Chapter 06 §6.3.1: the local clock dominated, so the remote was not
    /// applied. **Not corrupt and not nothing**: the item was processed, the
    /// cursor advances past it, and it counts as the page having yielded —
    /// or one legitimately skipped item on a page with one bad one would trip
    /// §5.14's breaker and refuse a run that did its work.
    pub skipped: usize,
    pub corrupt: usize,
    /// Past the 90-day `task_activity` horizon (chapter 13 §13.12). **Not
    /// corrupt**: the row is expired and the cursor still advances past it.
    pub expired: usize,
    /// Responses that were not a pull envelope at all (§5.14). Such a page
    /// holds the cursor and refuses the run (#2285).
    pub dropped_pages: u32,
    /// The cursor now stored, after applying.
    pub cursor: Option<String>,
    pub has_more: bool,
    /// The run is unsuccessful and **no success state may be written**:
    /// either the breaker tripped, and the cursor advanced, or a pull response
    /// was not an envelope, and the cursor held.
    pub refused: bool,
    /// The documents whose body log a tombstone on this pass actually emptied
    /// (chapter 07 §7.15).
    ///
    /// §7.15's first consequence has two halves and this loop can only do one
    /// of them. The local update log and both snapshot rows are gone by the
    /// time this is read; the **in-memory** `Y.Doc` is not, because the pull
    /// owns no [`crate::crdt::DocumentRegistry`]. A caller that holds one
    /// releases each id here. Reporting them is the point: a purge that left
    /// the caller believing the body was gone everywhere would be worse than
    /// one that failed loudly.
    pub purged_documents: Vec<String>,
    /// Documents whose update log gained a body from the feed on this pass
    /// (chapter 07 §7.17), so a **resident** document is behind its log.
    pub advanced_documents: Vec<String>,
}
