//! What the watcher has already told the sink.
//!
//! The tier writes no row, so until a consumer records what an event described, `note_files`
//! still shows the old state and the next OS event for the same file would repeat the
//! report: a second `Added` for a file whose `Renamed` was just sent would create a duplicate
//! note. This remembers, per path, the state last reported, and is the baseline a file is
//! compared with before the row is.
//!
//! Bounded: oldest entries go first past [`CAPACITY`]. An evicted path costs at most one
//! repeated event, which is idempotent for the consumer (it compares hashes itself).

use std::collections::{HashMap, VecDeque};

pub const CAPACITY: usize = 200_000;

/// The state of a file as last reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Seen {
    /// Content hash, for markdown.
    pub hash: Option<String>,
    /// Size and modification time (ms), for every other kind.
    pub stat: (u64, i64),
    /// The note the report named, when it named one (`Changed`, `Renamed`).
    pub note_id: Option<String>,
}

#[derive(Default)]
pub struct Reported {
    order: VecDeque<String>,
    by_path: HashMap<String, Seen>,
}

impl Reported {
    pub fn get(&self, path: &str) -> Option<&Seen> {
        self.by_path.get(path)
    }

    pub fn put(&mut self, path: &str, seen: Seen) {
        if self.by_path.insert(path.to_owned(), seen).is_none() {
            self.order.push_back(path.to_owned());
            while self.order.len() > CAPACITY {
                if let Some(oldest) = self.order.pop_front() {
                    self.by_path.remove(&oldest);
                }
            }
        }
    }

    /// Forgets `path` and everything below it (a folder that went).
    pub fn forget_tree(&mut self, path: &str) {
        let below = format!("{path}/");
        if self.by_path.remove(path).is_some() || self.by_path.keys().any(|p| p.starts_with(&below))
        {
            self.by_path
                .retain(|p, _| p != path && !p.starts_with(&below));
            self.order.retain(|p| self.by_path.contains_key(p));
        }
    }

    pub fn clear(&mut self) {
        self.order.clear();
        self.by_path.clear();
    }

    pub fn len(&self) -> usize {
        self.by_path.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_path.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(hash: &str) -> Seen {
        Seen {
            hash: Some(hash.into()),
            stat: (1, 1),
            note_id: None,
        }
    }

    #[test]
    fn a_folder_forgets_everything_below_it_and_nothing_beside_it() {
        let mut r = Reported::default();
        for p in ["a/x.md", "a/b/y.md", "ab/z.md", "a.md"] {
            r.put(p, seen("h"));
        }
        r.forget_tree("a");
        assert!(r.get("a/x.md").is_none() && r.get("a/b/y.md").is_none());
        assert!(r.get("ab/z.md").is_some() && r.get("a.md").is_some());
    }

    #[test]
    fn the_oldest_entries_go_past_the_capacity() {
        let mut r = Reported::default();
        for n in 0..CAPACITY + 5 {
            r.put(&format!("{n}.md"), seen("h"));
        }
        assert_eq!(r.len(), CAPACITY);
        assert!(r.get("0.md").is_none());
        assert!(r.get(&format!("{}.md", CAPACITY + 4)).is_some());
    }
}
