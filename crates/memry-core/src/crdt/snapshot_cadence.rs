//! §7.13.3's snapshot cadence, split from `snapshots.rs` for the 600-line
//! ceiling. Re-exported from [`super::snapshots`].

/// §7.13.3's cadence: **30 s quiet, 120 s from the first request**.
///
/// The chapter's table mixes two kinds of trigger. "Document close", "shutdown"
/// and "no editor open" are **shell** facts the core cannot see. The timing rule
/// is not — it is arithmetic over two instants, and it belongs here for the same
/// reason [`crate::crdt::text_extract::cross_shell_digest`] does: every shell
/// following §7.13.3 must reach the same answer, and a cadence each one
/// re-derives is a cadence they will disagree about.
///
/// The 120 s cap is the half worth stating. Quiet-only debouncing never fires
/// on a document being typed into continuously — which is exactly the document
/// whose log is growing fastest, and exactly the one §7.13.1 warns grows
/// unboundedly.
///
/// **This is a SHOULD, not a MUST.** §7.13.1: correctness never depends on a
/// snapshot and a client that pushes none is conforming. Nothing here overrides
/// [`super::snapshots::SnapshotGate`], which is the MUST and must still pass.
pub const SNAPSHOT_QUIET_MS: i64 = 30_000;

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The ceiling on debouncing, measured from the **first** request in a run.
pub const SNAPSHOT_MAX_WAIT_MS: i64 = 120_000;

/// Whether §7.13.3's timing says a snapshot is due.
///
/// `first_requested_at` is when the current run of requests began and
/// `last_requested_at` the most recent one; both are this device's clock, the
/// same one the index watermarks use and never a server instant (data-model
/// §A.5's reasoning applies — a server instant is not monotone here).
///
/// Returns `false` when there is nothing pending, so a caller can poll it on a
/// timer without tracking that itself.
pub fn snapshot_is_due(
    first_requested_at: Option<i64>,
    last_requested_at: Option<i64>,
    now_ms: i64,
) -> bool {
    let (Some(first), Some(last)) = (first_requested_at, last_requested_at) else {
        return false;
    };
    // `>=` on both, so an instant landing exactly on a boundary fires rather
    // than waiting a whole further interval. Saturating, because a clock that
    // steps backwards must not wrap into "due in 49 days".
    now_ms.saturating_sub(last) >= SNAPSHOT_QUIET_MS
        || now_ms.saturating_sub(first) >= SNAPSHOT_MAX_WAIT_MS
}

/// The documents that asked for a snapshot, each with its first and last
/// request instant. The push wave requests one for each document whose updates
/// the server stored (`note-body-push.ts:96`); the driver takes the due ones.
#[derive(Default)]
pub struct SnapshotRequests(Mutex<BTreeMap<String, (i64, i64)>>);

impl SnapshotRequests {
    /// Records that `doc_id` changed and wants a snapshot.
    pub fn request(&self, doc_id: &str, now_ms: i64) {
        self.lock()
            .entry(doc_id.to_owned())
            .and_modify(|(_, last)| *last = now_ms)
            .or_insert((now_ms, now_ms));
    }

    /// Whether any request is due at `now_ms`; takes nothing.
    pub fn any_due(&self, now_ms: i64) -> bool {
        self.lock()
            .values()
            .any(|(first, last)| snapshot_is_due(Some(*first), Some(*last), now_ms))
    }

    /// The documents due at `now_ms`, taken off the list.
    pub fn take_due(&self, now_ms: i64) -> Vec<String> {
        let mut pending = self.lock();
        let due: Vec<String> = pending
            .iter()
            .filter(|(_, (first, last))| snapshot_is_due(Some(*first), Some(*last), now_ms))
            .map(|(doc_id, _)| doc_id.clone())
            .collect();
        for doc_id in &due {
            pending.remove(doc_id);
        }
        due
    }

    /// Every pending document, due or not, taken off the list (shutdown).
    pub fn take_all(&self) -> Vec<String> {
        std::mem::take(&mut *self.lock()).into_keys().collect()
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, (i64, i64)>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_pending_is_never_due() {
        // A caller may poll this on a timer without tracking pendingness.
        assert!(!snapshot_is_due(None, None, 1_000_000));
        assert!(!snapshot_is_due(Some(0), None, 1_000_000));
        assert!(!snapshot_is_due(None, Some(0), 1_000_000));
    }

    #[test]
    fn the_quiet_window_fires_only_after_thirty_seconds_of_silence() {
        let first = 1_000_000;
        // One request, then silence. Not due at 29.999 s, due at exactly 30 s.
        assert!(!snapshot_is_due(
            Some(first),
            Some(first),
            first + SNAPSHOT_QUIET_MS - 1
        ));
        assert!(snapshot_is_due(
            Some(first),
            Some(first),
            first + SNAPSHOT_QUIET_MS
        ));
    }

    #[test]
    fn the_cap_fires_on_a_document_that_is_never_quiet() {
        // The half that matters. A document typed into continuously resets the
        // quiet window forever, and it is exactly the document whose log grows
        // fastest — §7.13.1's unbounded growth. The 120 s cap from the FIRST
        // request is what makes it snapshot at all.
        let first = 1_000_000;
        let busy_now = first + SNAPSHOT_MAX_WAIT_MS;
        let never_quiet = busy_now - 1; // a request one millisecond ago
        assert!(
            !snapshot_is_due(Some(first), Some(never_quiet), busy_now - 1),
            "quiet alone must not fire here, or the cap proves nothing"
        );
        assert!(
            snapshot_is_due(Some(first), Some(never_quiet), busy_now),
            "the 120 s cap must fire even though the document is still busy"
        );
    }

    #[test]
    fn a_clock_that_steps_backwards_is_not_due_rather_than_wrapping() {
        // Saturating arithmetic: a backwards step must not read as 49 days.
        let first = 1_000_000;
        assert!(!snapshot_is_due(Some(first), Some(first), first - 10_000));
    }

    #[test]
    fn the_cadence_constants_are_the_chapter_s() {
        // §7.13.3's table, pinned so a tuning edit has to change the chapter.
        assert_eq!(SNAPSHOT_QUIET_MS, 30_000);
        assert_eq!(SNAPSHOT_MAX_WAIT_MS, 120_000);
    }
}
