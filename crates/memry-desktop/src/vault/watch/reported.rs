//! What the watcher has already told the sink.
//!
//! The tier writes no row, so until a consumer records what an event described, `note_files`
//! still shows the old state. This record is the overlay on top of it: the table as it would
//! read had every report been applied. Every removal, rescan and pairing reads it before the
//! row, so no later event contradicts an earlier one:
//!
//! - a path holds the state last reported for it (the baseline a file is compared with), and
//!   the note it named, when it named one;
//! - a note that was reported at another path (`Renamed`) has moved: its row, still at the old
//!   path, is stale, and the note's removal is a removal at its new path;
//! - a note reported `Removed` is gone: its row is skipped until the row itself changes;
//! - a path whose report a consumer could not apply is owed: its entry stays, and the next look
//!   at the file reports it again even when its bytes did not change.
//!
//! Paths are keyed by [`folded_key`], so a case-only or Unicode-normalization respelling of a
//! path is the same entry. The record is scoped to one watcher, so one vault session.
//!
//! Bounded: oldest path entries go first past [`CAPACITY`], and the note index is derived from
//! the entries, so an evicted entry takes its note mapping with it and the next rescan pairs the
//! file again (a repeated, idempotent `Renamed`) instead of treating the stale row as a
//! removal. Evicted removal marks cost one repeated `Removed`.

use std::collections::{HashMap, HashSet, VecDeque};

use memry_core::domain::note_files::NoteFile;

use crate::vault::path_key::folded_key;

pub const CAPACITY: usize = 200_000;

/// The state of a file as last reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    /// The spelling the OS reported.
    pub path: String,
    /// Content hash, for markdown.
    pub hash: Option<String>,
    /// Size and modification time (ms), for every other kind.
    pub stat: (u64, i64),
    /// The note the report named, when it named one (`Changed`, `Renamed`).
    pub note_id: Option<String>,
}

/// A row as it was when its note was reported removed. A row the consumer changes afterwards
/// (restored, re-indexed) no longer matches, so the mark stops hiding it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct RowSignature {
    path: String,
    indexed_at: i64,
    content_hash: Option<String>,
}

impl RowSignature {
    fn of(row: &NoteFile) -> Self {
        Self {
            path: row.path.clone(),
            indexed_at: row.indexed_at,
            content_hash: row.content_hash.clone(),
        }
    }
}

#[derive(Default)]
pub struct Reported {
    /// Keys in the order they were first put; may hold keys already removed.
    order: VecDeque<String>,
    by_key: HashMap<String, Seen>,
    /// note id -> key of the entry that names it.
    by_note: HashMap<String, String>,
    removed: HashMap<String, RowSignature>,
    removed_order: VecDeque<String>,
    /// Keys of entries owed a report again; each one is a key of `by_key`.
    owed: HashSet<String>,
}

impl Reported {
    pub fn get(&self, path: &str) -> Option<&Seen> {
        self.by_key.get(&folded_key(path))
    }

    /// Where the note was last reported.
    pub fn of_note(&self, note_id: &str) -> Option<&Seen> {
        self.by_key.get(self.by_note.get(note_id)?)
    }

    pub fn put(&mut self, seen: Seen) {
        let key = folded_key(&seen.path);
        self.owed.remove(&key);
        if let Some(replaced) = self.by_key.get(&key)
            && let Some(id) = &replaced.note_id
            && self.by_note.get(id) == Some(&key)
        {
            self.by_note.remove(id);
        }
        if let Some(id) = &seen.note_id
            && let Some(old_key) = self.by_note.insert(id.clone(), key.clone())
            && old_key != key
        {
            // The note moved: its earlier entry is stale.
            self.by_key.remove(&old_key);
            self.owed.remove(&old_key);
        }
        if self.by_key.insert(key.clone(), seen).is_none() {
            self.order.push_back(key);
        }
        self.evict();
    }

    fn evict(&mut self) {
        while self.by_key.len() > CAPACITY {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.drop_key(&oldest);
        }
        if self.order.len() > 2 * CAPACITY {
            self.order.retain(|k| self.by_key.contains_key(k));
        }
    }

    fn drop_key(&mut self, key: &str) {
        self.owed.remove(key);
        if let Some(seen) = self.by_key.remove(key)
            && let Some(id) = seen.note_id
            && self.by_note.get(&id).is_some_and(|k| k == key)
        {
            self.by_note.remove(&id);
        }
    }

    pub fn remove(&mut self, path: &str) {
        self.drop_key(&folded_key(path));
    }

    /// A consumer could not apply what was reported at `path`. The entry stays, since it names
    /// where its note lives and the bytes last reported, and the next look at the file reports
    /// it again: the report pays the debt, and so does the entry's removal.
    pub fn owe(&mut self, path: &str) {
        let key = folded_key(path);
        if self.by_key.contains_key(&key) {
            self.owed.insert(key);
        }
    }

    pub fn is_owed(&self, path: &str) -> bool {
        self.owed.contains(&folded_key(path))
    }

    fn keys_in_tree(&self, path: &str, only_unowned: bool) -> Vec<String> {
        let (key, below) = (folded_key(path), format!("{}/", folded_key(path)));
        self.by_key
            .iter()
            .filter(|(k, _)| **k == key || k.starts_with(&below))
            .filter(|(_, seen)| !only_unowned || seen.note_id.is_none())
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// Forgets `path` and everything below it (a folder that went).
    pub fn forget_tree(&mut self, path: &str) {
        for key in self.keys_in_tree(path, false) {
            self.drop_key(&key);
        }
    }

    /// Forgets the entry that names `note_id`, and no other: on a case-sensitive volume the
    /// folded key of a removed path can belong to a different file.
    pub fn forget_note(&mut self, note_id: &str) {
        if let Some(key) = self.by_note.get(note_id).cloned() {
            self.drop_key(&key);
        }
    }

    /// Forgets the entries at and below `path` that name no note. The ones that name a note
    /// stay until that note's removal is settled, since the note's home is what a removal
    /// reads.
    pub fn forget_unowned_tree(&mut self, path: &str) {
        for key in self.keys_in_tree(path, true) {
            self.drop_key(&key);
        }
    }

    /// `row`'s note was reported removed.
    pub fn mark_removed(&mut self, row: &NoteFile) {
        let sig = RowSignature::of(row);
        if self.removed.insert(row.note_id.clone(), sig).is_none() {
            self.removed_order.push_back(row.note_id.clone());
            while self.removed_order.len() > CAPACITY {
                if let Some(oldest) = self.removed_order.pop_front() {
                    self.removed.remove(&oldest);
                }
            }
        }
    }

    /// Whether `row` is the row of a note already reported removed.
    pub fn is_removed(&self, row: &NoteFile) -> bool {
        self.removed
            .get(&row.note_id)
            .is_some_and(|sig| *sig == RowSignature::of(row))
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn len(&self) -> usize {
        self.by_key.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_key.is_empty()
    }

    #[cfg(test)]
    fn note_count(&self) -> usize {
        self.by_note.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(path: &str, note: Option<&str>) -> Seen {
        Seen {
            path: path.into(),
            hash: Some("h".into()),
            stat: (1, 1),
            note_id: note.map(str::to_owned),
        }
    }

    fn row(id: &str, path: &str, indexed_at: i64) -> NoteFile {
        NoteFile {
            note_id: id.into(),
            path: path.into(),
            file_type: "markdown".into(),
            mime_type: None,
            file_size: Some(1),
            content_hash: Some("h".into()),
            file_hash: Some("h".into()),
            local_only: false,
            indexed_at,
        }
    }

    #[test]
    fn a_folder_forgets_everything_below_it_and_nothing_beside_it() {
        let mut r = Reported::default();
        for p in ["a/x.md", "a/b/y.md", "ab/z.md", "a.md"] {
            r.put(seen(p, None));
        }
        r.forget_tree("a");
        assert!(r.get("a/x.md").is_none() && r.get("a/b/y.md").is_none());
        assert!(r.get("ab/z.md").is_some() && r.get("a.md").is_some());
    }

    #[test]
    fn the_oldest_entries_go_past_the_capacity_and_take_their_note_with_them() {
        let mut r = Reported::default();
        r.put(seen("0.md", Some("n0")));
        for n in 1..CAPACITY + 5 {
            r.put(seen(&format!("{n}.md"), None));
        }
        assert_eq!(r.len(), CAPACITY);
        assert!(r.get("0.md").is_none());
        assert!(
            r.of_note("n0").is_none(),
            "a note with no entry has no home"
        );
        assert!(r.get(&format!("{}.md", CAPACITY + 4)).is_some());
    }

    #[test]
    fn a_note_has_one_home_and_a_respelled_path_is_the_same_entry() {
        let mut r = Reported::default();
        r.put(seen("a.md", Some("n1")));
        r.put(seen("b.md", Some("n1")));
        assert!(r.get("a.md").is_none(), "the old entry is stale");
        assert_eq!(r.of_note("n1").unwrap().path, "b.md");
        assert_eq!(r.get("B.MD").unwrap().path, "b.md");
        assert_eq!(r.note_count(), 1);
    }

    #[test]
    fn forgetting_a_note_leaves_the_entry_of_another_file_with_the_same_folded_path() {
        let mut r = Reported::default();
        r.put(seen("note.md", Some("n1")));
        r.forget_note("n2");
        assert!(
            r.get("note.md").is_some(),
            "a note with no entry forgets nothing"
        );
        r.forget_note("n1");
        assert!(r.get("note.md").is_none() && r.of_note("n1").is_none());
    }

    #[test]
    fn a_folder_keeps_the_entries_that_name_a_note_until_the_removal_settles() {
        let mut r = Reported::default();
        r.put(seen("d/a.md", Some("n1")));
        r.put(seen("d/b.md", None));
        r.forget_unowned_tree("d");
        assert!(r.get("d/a.md").is_some() && r.get("d/b.md").is_none());
    }

    #[test]
    fn a_debt_is_owed_only_by_an_entry_and_goes_with_its_report_or_its_removal() {
        let mut r = Reported::default();
        r.owe("none.md");
        assert!(!r.is_owed("none.md"), "a path with no entry owes nothing");
        r.put(seen("a.md", Some("n1")));
        r.owe("A.md");
        assert!(
            r.is_owed("a.md") && r.get("a.md").is_some(),
            "the entry stays"
        );
        r.put(seen("a.md", Some("n1")));
        assert!(!r.is_owed("a.md"), "a report pays it");
        r.owe("a.md");
        r.put(seen("b.md", Some("n1")));
        assert!(!r.is_owed("a.md"), "the note moved");
        r.owe("b.md");
        r.forget_note("n1");
        assert!(!r.is_owed("b.md"), "the entry went");
        assert!(r.owed.is_empty());
    }

    #[test]
    fn a_removal_mark_hides_the_row_it_was_made_for_and_not_a_changed_one() {
        let mut r = Reported::default();
        r.mark_removed(&row("n1", "a.md", 5));
        assert!(r.is_removed(&row("n1", "a.md", 5)));
        assert!(!r.is_removed(&row("n1", "a.md", 6)), "re-indexed since");
        assert!(!r.is_removed(&row("n2", "a.md", 5)));
    }
}
