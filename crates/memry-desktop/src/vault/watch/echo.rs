//! The app's own writes must not come back as outside edits.
//!
//! A writer (12e's write-back, a rename, a delete) records what it is about to put on disk
//! before it does. When the watcher sees that path it compares the file's hash with the
//! recorded one and drops the event on a match. There is no time window: a recorded entry stays
//! until the file is seen with other content (an outside edit, which then passes and clears the
//! entry) or until it is evicted, oldest first, past [`CAPACITY`]. An evicted entry costs one
//! redundant event, which the consumer's own hash check settles.
//!
//! A folder the app moves away whole is one record for the folder and everything below it
//! ([`EchoGuard::will_remove_tree`]): an entry-wise move (#2206) reports each entry's going, and
//! one record per note would crowd out the oldest entries past [`CAPACITY`]. Until the mover says
//! the folder is gone ([`EchoGuard::removed_tree`]) no sighting ends it, since the folder is
//! still there while its entries leave; after that, it ends as a folder's record does.
//!
//! A removal's record (a file or a folder the app removes or moves away) lives while the app's
//! removal is all the watcher could see of that path: it ends once the path is seen present
//! again, or a folder that holds it is seen back with it, or a rescan, which stands in for
//! events the OS lost, finds it on disk. The watcher looks at the disk once more when it ends one,
//! under the record's lock, and [`EchoGuard::removing`] records and removes under that lock,
//! so a removal the app makes after the watcher's own look keeps its record.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::sync::Mutex;

pub const CAPACITY: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Expected {
    Hash(String),
    Gone,
    /// The path and everything below it; `settled` once the mover saw it go.
    GoneTree {
        settled: bool,
    },
}

impl Expected {
    /// A removal record that a sighting of its path, back on disk, ends.
    fn ends_when_seen(&self) -> bool {
        matches!(self, Self::Gone | Self::GoneTree { settled: true })
    }

    fn is_removal(&self) -> bool {
        matches!(self, Self::Gone | Self::GoneTree { .. })
    }
}

#[derive(Default)]
struct State {
    order: VecDeque<String>,
    by_path: HashMap<String, Expected>,
}

impl State {
    fn put(&mut self, path: &str, what: Expected) {
        if self.by_path.insert(path.to_owned(), what).is_none() {
            self.order.push_back(path.to_owned());
            while self.order.len() > CAPACITY {
                if let Some(oldest) = self.order.pop_front() {
                    self.by_path.remove(&oldest);
                }
            }
        }
    }

    fn forget(&mut self, path: &str) {
        if self.by_path.remove(path).is_some() {
            self.order.retain(|p| p != path);
        }
    }
}

#[derive(Default)]
pub struct EchoGuard {
    state: Mutex<State>,
}

impl EchoGuard {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The app is about to write `path` with bytes whose hash is `hash`.
    pub fn will_write(&self, path: &str, hash: &str) {
        self.lock().put(path, Expected::Hash(hash.to_owned()));
    }

    /// The write told with [`Self::will_write`] did not happen (a file was there first): what
    /// is seen at `path` from now on is not the app's, the same bytes included.
    pub fn cancel_write(&self, path: &str) {
        let mut state = self.lock();
        if matches!(state.by_path.get(path), Some(Expected::Hash(_))) {
            state.forget(path);
        }
    }

    /// The app is about to remove `path`.
    pub fn will_remove(&self, path: &str) {
        self.lock().put(path, Expected::Gone);
    }

    /// The app is about to move the folder `path` away with everything below it (module doc).
    pub fn will_remove_tree(&self, path: &str) {
        self.lock().put(path, Expected::GoneTree { settled: false });
    }

    /// The folder told with [`Self::will_remove_tree`] is gone: a sighting of it from now on is
    /// the folder back, which ends the record.
    pub fn removed_tree(&self, path: &str) {
        if let Some(Expected::GoneTree { settled }) = self.lock().by_path.get_mut(path) {
            *settled = true;
        }
    }

    /// The move told with [`Self::will_remove_tree`] did not happen, or only in part: `still_gone`
    /// keeps a record each, and the folder's record ends, as one step, so no absence below the
    /// folder goes unrecorded in between.
    pub fn narrow_tree(&self, path: &str, still_gone: impl IntoIterator<Item = String>) {
        let mut state = self.lock();
        for gone in still_gone {
            state.put(&gone, Expected::Gone);
        }
        if matches!(state.by_path.get(path), Some(Expected::GoneTree { .. })) {
            state.forget(path);
        }
    }

    /// The app removes or moves away `path` with `remove`, recorded as one step with it: the
    /// watcher, ending records in [`Self::seen_file`] and [`Self::seen_folder`], sees the path
    /// before both or after both. A failed `remove` puts back the record it replaced (an own
    /// write the file still holds), or none. The lock is held for the one call, so `remove` is a
    /// single file system call, and for a journal rename that row's write before it and after a
    /// failed try (`FileMove::run_each`): never a wait on anything that takes this lock. Lock
    /// order: the rows' lane, then this, then the core's database writer.
    pub fn removing<T>(&self, path: &str, remove: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        let mut state = self.lock();
        let before = state.by_path.get(path).cloned();
        state.put(path, Expected::Gone);
        remove().inspect_err(|_| match before {
            Some(before) => state.put(path, before),
            None => state.forget(path),
        })
    }

    /// The hash the app last wrote at `path`, when one is recorded. The watcher hashes the
    /// file only then.
    pub fn expected_hash(&self, path: &str) -> Option<String> {
        match self.lock().by_path.get(path) {
            Some(Expected::Hash(hash)) => Some(hash.clone()),
            _ => None,
        }
    }

    /// `path` was seen with `observed`. True when that is the app's own write, which stays
    /// recorded; any other content is an outside edit and clears the record. A removal's
    /// record is [`Self::seen_file`]'s to end.
    pub fn absorbs_write(&self, path: &str, observed: &str) -> bool {
        let mut state = self.lock();
        match state.by_path.get(path) {
            Some(Expected::Hash(expected)) if expected == observed => true,
            Some(Expected::Hash(expected)) => {
                // DIAG (temporary, #3967)
                tracing::warn!(path, expected, observed, "DIAG-3967 echo mismatch");
                state.forget(path);
                false
            }
            Some(Expected::Gone | Expected::GoneTree { .. }) | None => false,
        }
    }

    /// The file at `path` was seen present. The app's removal of it is over if `there` (a look
    /// at the disk, under the lock) still finds it: a later delete of it is not the app's.
    pub fn seen_file(&self, path: &str, there: impl Fn(&str) -> bool) {
        let mut state = self.lock();
        if state
            .by_path
            .get(path)
            .is_some_and(Expected::ends_when_seen)
            && there(path)
        {
            state.forget(path);
        }
    }

    /// [`Self::seen_file`] for a folder, and for every path below it with a removal recorded:
    /// a folder moved in brings what it holds, and the OS may report only the folder. A folder
    /// above it that came back is ended by its own report, or, when the OS lost that, by the
    /// rescan that stands in for it ([`Self::seen_all`]).
    pub fn seen_folder(&self, path: &str, there: impl Fn(&str) -> bool) {
        let below = format!("{path}/");
        self.end_removals(|at| at == path || at.starts_with(&below), there);
    }

    /// Every path with a removal recorded, looked at as [`Self::seen_file`] does: for a rescan,
    /// whose walk sees only files and only those it reports.
    pub fn seen_all(&self, there: impl Fn(&str) -> bool) {
        self.end_removals(|_| true, there);
    }

    fn end_removals(&self, of: impl Fn(&str) -> bool, there: impl Fn(&str) -> bool) {
        let mut state = self.lock();
        let ended: Vec<String> = state
            .by_path
            .iter()
            .filter(|(at, what)| what.ends_when_seen() && of(at))
            .map(|(at, _)| at.clone())
            .filter(|at| there(at))
            .collect();
        for path in ended {
            state.forget(&path);
        }
    }

    /// The removal of `path` told with [`Self::will_remove`] did not happen, or is to be
    /// reported after all: an absence seen from now on is not the app's.
    pub fn cancel_removal(&self, path: &str) {
        let mut state = self.lock();
        if state.by_path.get(path).is_some_and(Expected::is_removal) {
            state.forget(path);
        }
    }

    /// `path` was seen missing. True when the app removed it, or a folder above it.
    pub fn absorbs_removal(&self, path: &str) -> bool {
        let mut state = self.lock();
        if state.by_path.get(path).is_some_and(Expected::is_removal) {
            return true;
        }
        let in_a_tree = path
            .match_indices('/')
            .map(|(at, _)| &path[..at])
            .any(|folder| matches!(state.by_path.get(folder), Some(Expected::GoneTree { .. })));
        if in_a_tree {
            return true;
        }
        state.forget(path);
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_own_write_is_absorbed_until_the_content_differs() {
        let echo = EchoGuard::default();
        echo.will_write("a.md", "h1");
        assert!(echo.absorbs_write("a.md", "h1"));
        assert!(
            echo.absorbs_write("a.md", "h1"),
            "several events of one write"
        );
        assert!(!echo.absorbs_write("a.md", "h2"), "an outside edit passes");
        assert!(!echo.absorbs_write("a.md", "h1"), "and clears the record");
        assert!(
            !echo.absorbs_write("b.md", "h1"),
            "another path is never absorbed"
        );
    }

    fn on_disk(path: &str) -> bool {
        !path.ends_with("gone")
    }

    #[test]
    fn an_own_removal_is_absorbed_and_a_recreated_file_is_not() {
        let echo = EchoGuard::default();
        echo.will_remove("a.md");
        assert!(echo.absorbs_removal("a.md"));
        echo.seen_file("a.md", on_disk);
        assert!(
            !echo.absorbs_write("a.md", "h"),
            "back with content: an outside create"
        );
        assert!(!echo.absorbs_removal("a.md"));
    }

    #[test]
    fn a_removal_record_is_spent_once_the_file_is_seen_back() {
        let echo = EchoGuard::default();
        echo.will_remove("a.pdf");
        echo.seen_file("a.pdf", on_disk);
        assert!(!echo.absorbs_removal("a.pdf"));
        echo.will_write("a.md", "h");
        echo.seen_file("a.md", on_disk);
        assert!(
            echo.absorbs_write("a.md", "h"),
            "a write record is not touched"
        );
    }

    /// The watcher looked, then the app removed the path: the look is stale, and the disk,
    /// looked at again, says so.
    #[test]
    fn a_removal_outlives_a_look_that_the_disk_no_longer_bears_out() {
        let echo = EchoGuard::default();
        echo.will_remove("a.gone");
        echo.seen_file("a.gone", on_disk);
        echo.seen_folder("a.gone", on_disk);
        assert!(!echo.absorbs_write("a.gone", "h"));
        assert!(echo.absorbs_removal("a.gone"));
    }

    #[test]
    fn a_folder_seen_ends_the_removals_below_it_that_are_back() {
        let echo = EchoGuard::default();
        for path in ["j/2025", "j/2025/Jan", "j/2025/Feb.gone", "j/20255", "j"] {
            echo.will_remove(path);
        }
        echo.seen_folder("j/2025", on_disk);
        let kept = [
            ("j/2025", false),
            ("j/2025/Jan", false),
            ("j/2025/Feb.gone", true),
            ("j/20255", true),
            ("j", true),
        ];
        for (path, kept) in kept {
            assert_eq!(echo.absorbs_removal(path), kept, "{path}");
        }
    }

    #[test]
    fn a_rescan_ends_every_removal_that_is_back() {
        let echo = EchoGuard::default();
        for path in ["j/2025", "j/2025/Jan", "a.md", "b.gone"] {
            echo.will_remove(path);
        }
        echo.seen_all(on_disk);
        let kept = [
            ("j/2025", false),
            ("j/2025/Jan", false),
            ("a.md", false),
            ("b.gone", true),
        ];
        for (path, kept) in kept {
            assert_eq!(echo.absorbs_removal(path), kept, "{path}");
        }
    }

    #[test]
    fn a_tree_record_absorbs_everything_below_it_and_no_sighting_ends_it_mid_move() {
        let echo = EchoGuard::default();
        echo.will_remove_tree("Work");
        for path in ["Work", "Work/Plan.md", "Work/Sub/Deep.md"] {
            assert!(echo.absorbs_removal(path), "{path}");
        }
        assert!(!echo.absorbs_removal("Workshop/a.md"));
        // The folder is still there while its entries leave: neither a rescan nor its sighting
        // ends the record before the mover says it is gone.
        echo.seen_all(on_disk);
        echo.seen_folder("Work", on_disk);
        echo.seen_file("Work", on_disk);
        assert!(echo.absorbs_removal("Work/Plan.md"));

        echo.removed_tree("Work");
        echo.seen_folder("Work", on_disk);
        assert!(!echo.absorbs_removal("Work/Plan.md"), "the folder is back");
        assert!(!echo.absorbs_removal("Work"));
    }

    #[test]
    fn a_narrowed_tree_record_keeps_only_what_is_still_gone() {
        let echo = EchoGuard::default();
        echo.will_remove_tree("Work");
        echo.narrow_tree("Work", ["Work/Staged.md".to_owned()]);
        assert!(echo.absorbs_removal("Work/Staged.md"));
        assert!(!echo.absorbs_removal("Work/Plan.md"));
        assert!(!echo.absorbs_removal("Work"));
    }

    #[test]
    fn a_removal_that_fails_leaves_the_record_as_it_was() {
        let echo = EchoGuard::default();
        let failed = || Err::<(), _>(io::ErrorKind::Other.into());
        assert!(echo.removing("a.md", failed).is_err());
        assert!(!echo.absorbs_removal("a.md"));
        echo.will_write("c.md", "h");
        assert!(echo.removing("c.md", failed).is_err());
        assert!(
            echo.absorbs_write("c.md", "h"),
            "the own write was forgotten"
        );
        echo.removing("b.md", || Ok(())).unwrap();
        assert!(echo.absorbs_removal("b.md"));
    }

    #[test]
    fn the_record_is_bounded_and_drops_the_oldest() {
        let echo = EchoGuard::default();
        for n in 0..CAPACITY + 10 {
            echo.will_write(&format!("{n}.md"), "h");
        }
        assert!(!echo.absorbs_write("0.md", "h"));
        assert!(echo.absorbs_write(&format!("{}.md", CAPACITY + 9), "h"));
        assert_eq!(echo.lock().by_path.len(), CAPACITY);
    }
}
