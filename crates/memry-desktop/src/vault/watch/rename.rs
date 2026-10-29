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
//! The hash a removed note is tracked under is the row's file hash: the bytes the tier last read
//! from the file, whether or not the note's document took them (too large, frontmatter that does
//! not parse, a body that was already there). So a note moved while the app was closed pairs as
//! long as its bytes did not change. A row with no file hash (its file was never read) can never
//! be claimed: Electron paired those on size and modification time, but `note_files` keeps no
//! modification time, and pairing on size alone would hand one note's id to another file. It
//! settles as a delete plus a new file. Among several identical removed files, a new file
//! claims the one with its own name; when its name does not single one out, it claims none and
//! each settles as a delete plus a new file. Handing it the oldest instead swaps two identical
//! notes moved together into folders that list in the other order.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::{Duration, Instant};

pub const RENAME_WINDOW: Duration = Duration::from_millis(500);

/// The instant a delete or a held new file is timed from: now, never earlier than the caller's
/// own `started`. A window opens at the moment ITS absence was observed, not at the start of
/// the operation that found it: a rescan of a big vault, or a batch of thousands of paths, can
/// run longer than the window, and a delete timed from the start would be reported on the next
/// tick without ever having stayed gone. (`started` keeps a caller that passes a later time,
/// a test's clock, in charge.)
pub fn observed(started: Instant) -> Instant {
    Instant::now().max(started)
}

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

    /// Tracks a removed note; its window runs from `now`, which the caller took when it saw
    /// the file gone (see [`observed`]). A note tracked again replaces its earlier entry.
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

    /// The pending delete the file at `path`, with this hash, was renamed from: the only one
    /// with the hash, or among several, the only one with the file's name. Several the name
    /// does not tell apart claim nothing.
    pub fn claim(&mut self, hash: &str, path: &str) -> Option<Pending> {
        let bucket = self.by_hash.get(hash)?;
        let seq = if bucket.len() == 1 {
            bucket[0]
        } else {
            let name = file_name(path);
            let mut named = bucket
                .iter()
                .filter(|seq| file_name(&self.entries[seq].pending.path) == name);
            let first = *named.next()?;
            if named.next().is_some() {
                return None;
            }
            first
        };
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

/// The last component of a vault-relative path.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
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
    fn identical_files_claim_by_name_and_never_by_age() {
        let now = Instant::now();
        let mut t = RenameTracker::default();
        t.track(pending("1", "a.md", Some("h")), now, None);
        t.track(pending("2", "b.md", Some("h")), now, None);
        t.track(pending("3", "x/b.md", Some("h")), now, None);
        // Neither name, and two named b.md: no claim.
        assert!(t.claim("h", "dir/c.md").is_none());
        assert!(t.claim("h", "dir/b.md").is_none());
        assert_eq!(t.claim("h", "dir/a.md").unwrap().note_id, "1");
        assert_eq!(t.len(), 2);
        assert!(t.drop_note("3"));
        // The only one left with this hash goes to any name.
        assert_eq!(t.claim("h", "dir/c.md").unwrap().note_id, "2");
        assert!(t.claim("h", "dir/b.md").is_none());
        assert!(t.is_empty());
    }

    #[test]
    fn a_row_without_a_hash_is_never_claimed_and_still_expires() {
        let now = Instant::now();
        let mut t = RenameTracker::default();
        t.track(pending("1", "a.md", None), now, None);
        assert!(t.claim("", "a.md").is_none());
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
        assert_eq!(t.claim("h1", "a.md").unwrap().note_id, "1");
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
        assert!(t.claim("h", "a.md").is_none());
    }

    #[test]
    fn tracking_a_note_again_replaces_its_entry() {
        let now = Instant::now();
        let mut t = RenameTracker::default();
        t.track(pending("1", "a.md", Some("old")), now, None);
        t.track(pending("1", "b.md", Some("new")), now, None);
        assert_eq!(t.len(), 1);
        assert!(t.claim("old", "b.md").is_none());
        assert_eq!(t.claim("new", "b.md").unwrap().path, "b.md");
    }
}
