//! The app's own writes must not come back as outside edits.
//!
//! A writer (12e's write-back, a rename, a delete) records what it is about to put on disk
//! before it does. When the watcher sees that path it compares the file's hash with the
//! recorded one and drops the event on a match. There is no time window: a recorded entry stays
//! until the file is seen with other content (an outside edit, which then passes and clears the
//! entry) or until it is evicted, oldest first, past [`CAPACITY`]. An evicted entry costs one
//! redundant event, which the consumer's own hash check settles.
//!
//! A removal's record (a file or a folder the app removes or moves away) lives while the app's
//! removal is all the watcher could see of that path: it ends once the path is seen present
//! again, or a folder that holds it is seen back with it. The watcher looks at the disk once more when it ends one,
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

    /// The app is about to remove `path`.
    pub fn will_remove(&self, path: &str) {
        self.lock().put(path, Expected::Gone);
    }

    /// The app removes or moves away `path` with `remove`, recorded as one step with it: the
    /// watcher, ending records in [`Self::seen_file`] and [`Self::seen_folder`], sees the path
    /// before both or after both. A failed `remove` withdraws the record. The lock is held for
    /// the one call, so `remove` is a single file system call, never a wait.
    pub fn removing<T>(&self, path: &str, remove: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        let mut state = self.lock();
        state.put(path, Expected::Gone);
        remove().inspect_err(|_| state.forget(path))
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
            Some(Expected::Hash(_)) => {
                state.forget(path);
                false
            }
            Some(Expected::Gone) | None => false,
        }
    }

    /// The file at `path` was seen present. The app's removal of it is over if `there` (a look
    /// at the disk, under the lock) still finds it: a later delete of it is not the app's.
    pub fn seen_file(&self, path: &str, there: impl Fn(&str) -> bool) {
        let mut state = self.lock();
        if state.by_path.get(path) == Some(&Expected::Gone) && there(path) {
            state.forget(path);
        }
    }

    /// [`Self::seen_file`] for a folder, and for every path below it with a removal recorded:
    /// a folder moved in brings what it holds, and the OS may report only the folder. The
    /// folders above it need no look: one that came back was reported itself.
    pub fn seen_folder(&self, path: &str, there: impl Fn(&str) -> bool) {
        let below = format!("{path}/");
        let mut state = self.lock();
        let ended: Vec<String> = state
            .by_path
            .iter()
            .filter(|(at, what)| {
                **what == Expected::Gone && (*at == path || at.starts_with(&below))
            })
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
        if state.by_path.get(path) == Some(&Expected::Gone) {
            state.forget(path);
        }
    }

    /// `path` was seen missing. True when the app removed it.
    pub fn absorbs_removal(&self, path: &str) -> bool {
        let mut state = self.lock();
        if state.by_path.get(path) == Some(&Expected::Gone) {
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
    fn a_removal_that_fails_leaves_no_record() {
        let echo = EchoGuard::default();
        let removed = echo.removing("a.md", || Err::<(), _>(io::ErrorKind::Other.into()));
        assert!(removed.is_err());
        assert!(!echo.absorbs_removal("a.md"));
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
