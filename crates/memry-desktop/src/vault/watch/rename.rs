//! Rename detection (`vault/rename-tracker.ts`): the file system says "gone" and "appeared",
//! and the content hash says they are one file.
//!
//! A removed note is tracked as a pending delete under the hash the index holds for it. A file
//! that appears with the same hash inside the window claims it: that is a rename and the note
//! keeps its id. A delete nobody claims settles as a real one.
//!
//! Two ways to settle. A live delete has a window ([`RENAME_WINDOW`]) and expires with the
//! clock. A rescan knows every add up front, so it arms no window: it tracks its deletes in a
//! [`Batch`], lets every add claim one, and settles what is left after the last add. A window
//! would expire while a large folder move is still being added and delete the old ids.
//!
//! A row with no hash (the file was never read) can never be claimed: Electron paired those on
//! size and modification time, but `note_files` keeps no modification time, and pairing on size
//! alone would hand one note's id to another file. It settles as a delete plus a new file.
//! Identical files claim oldest first.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::{Duration, Instant};

pub const RENAME_WINDOW: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub note_id: String,
    pub path: String,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Batch(u64);

struct Entry {
    pending: Pending,
    /// `None`: settled by its batch, not by the clock.
    expires: Option<Instant>,
    batch: Option<Batch>,
}

#[derive(Default)]
pub struct RenameTracker {
    next: u64,
    /// By tracking order, so the oldest is first.
    entries: BTreeMap<u64, Entry>,
    by_hash: HashMap<String, VecDeque<u64>>,
    by_note: HashMap<String, u64>,
}

impl RenameTracker {
    pub fn has_pending(&self) -> bool {
        !self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn new_batch(&mut self) -> Batch {
        self.next += 1;
        Batch(self.next)
    }

    /// Tracks a removed note. A note tracked again replaces its earlier entry.
    pub fn track(&mut self, pending: Pending, now: Instant, batch: Option<Batch>) {
        self.forget_note(&pending.note_id);
        self.next += 1;
        let seq = self.next;
        if let Some(hash) = &pending.hash {
            self.by_hash.entry(hash.clone()).or_default().push_back(seq);
        }
        self.by_note.insert(pending.note_id.clone(), seq);
        self.entries.insert(
            seq,
            Entry {
                pending,
                expires: batch.is_none().then_some(now + RENAME_WINDOW),
                batch,
            },
        );
    }

    /// The oldest pending delete with this hash: the note a file with this content was
    /// renamed from.
    pub fn claim(&mut self, hash: &str) -> Option<Pending> {
        let seq = *self.by_hash.get(hash)?.front()?;
        self.take(seq)
    }

    /// Live deletes whose window is over, oldest first.
    pub fn expired(&mut self, now: Instant) -> Vec<Pending> {
        let due: Vec<u64> = self
            .entries
            .iter()
            .filter(|(_, e)| e.expires.is_some_and(|at| at <= now))
            .map(|(seq, _)| *seq)
            .collect();
        due.into_iter().filter_map(|seq| self.take(seq)).collect()
    }

    /// What a batch's adds left unclaimed, in tracking order.
    pub fn settle(&mut self, batch: Batch) -> Vec<Pending> {
        let seqs: Vec<u64> = self
            .entries
            .iter()
            .filter(|(_, e)| e.batch == Some(batch))
            .map(|(seq, _)| *seq)
            .collect();
        seqs.into_iter().filter_map(|seq| self.take(seq)).collect()
    }

    /// Drops a batch's unclaimed deletes without settling them, for a rescan that failed
    /// before its adds finished: every row stays and the next rescan decides.
    pub fn discard(&mut self, batch: Batch) -> usize {
        self.settle(batch).len()
    }

    pub fn clear(&mut self) {
        *self = Self {
            next: self.next,
            ..Self::default()
        };
    }

    /// Drops the pending delete of a note that turned out not to be gone (it was respelled in
    /// place). True when there was one.
    pub fn drop_note(&mut self, note_id: &str) -> bool {
        let had = self.by_note.contains_key(note_id);
        self.forget_note(note_id);
        had
    }

    fn forget_note(&mut self, note_id: &str) {
        if let Some(seq) = self.by_note.get(note_id).copied() {
            self.take(seq);
        }
    }

    fn take(&mut self, seq: u64) -> Option<Pending> {
        let entry = self.entries.remove(&seq)?;
        self.by_note.remove(&entry.pending.note_id);
        if let Some(hash) = &entry.pending.hash
            && let Some(bucket) = self.by_hash.get_mut(hash)
        {
            bucket.retain(|s| *s != seq);
            if bucket.is_empty() {
                self.by_hash.remove(hash);
            }
        }
        Some(entry.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(id: &str, path: &str, hash: Option<&str>) -> Pending {
        Pending {
            note_id: id.into(),
            path: path.into(),
            hash: hash.map(str::to_owned),
        }
    }

    #[test]
    fn a_file_with_the_same_hash_claims_the_delete_oldest_first() {
        let now = Instant::now();
        let mut t = RenameTracker::default();
        t.track(pending("1", "a.md", Some("h")), now, None);
        t.track(pending("2", "b.md", Some("h")), now, None);
        assert_eq!(t.claim("h").unwrap().note_id, "1");
        assert_eq!(t.claim("h").unwrap().note_id, "2");
        assert!(t.claim("h").is_none());
        assert!(t.is_empty());
    }

    #[test]
    fn a_row_without_a_hash_is_never_claimed_and_still_expires() {
        let now = Instant::now();
        let mut t = RenameTracker::default();
        t.track(pending("1", "a.md", None), now, None);
        assert!(t.claim("").is_none());
        assert!(
            t.expired(now + RENAME_WINDOW - Duration::from_millis(1))
                .is_empty()
        );
        let due = t.expired(now + RENAME_WINDOW);
        assert_eq!(due.len(), 1);
        assert!(t.is_empty());
    }

    #[test]
    fn a_batch_has_no_clock_and_settles_only_what_no_add_claimed() {
        let now = Instant::now();
        let mut t = RenameTracker::default();
        let batch = t.new_batch();
        t.track(pending("1", "a.md", Some("h1")), now, Some(batch));
        t.track(pending("2", "b.md", Some("h2")), now, Some(batch));
        t.track(pending("3", "c.md", Some("h3")), now, None);
        assert!(
            t.expired(now + Duration::from_secs(60)).len() == 1,
            "only the live one"
        );
        assert_eq!(t.claim("h1").unwrap().note_id, "1");
        let left = t.settle(batch);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].note_id, "2");
        assert!(t.is_empty());
    }

    #[test]
    fn a_discarded_batch_settles_nothing() {
        let now = Instant::now();
        let mut t = RenameTracker::default();
        let batch = t.new_batch();
        t.track(pending("1", "a.md", Some("h")), now, Some(batch));
        assert_eq!(t.discard(batch), 1);
        assert!(t.settle(batch).is_empty());
        assert!(t.claim("h").is_none());
    }

    #[test]
    fn tracking_a_note_again_replaces_its_entry() {
        let now = Instant::now();
        let mut t = RenameTracker::default();
        t.track(pending("1", "a.md", Some("old")), now, None);
        t.track(pending("1", "b.md", Some("new")), now, None);
        assert_eq!(t.len(), 1);
        assert!(t.claim("old").is_none());
        assert_eq!(t.claim("new").unwrap().path, "b.md");
    }
}
