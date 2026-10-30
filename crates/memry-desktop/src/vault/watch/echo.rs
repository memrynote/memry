//! The app's own writes must not come back as outside edits.
//!
//! A writer (12e's write-back, a rename, a delete) records what it is about to put on disk
//! before it does. When the watcher sees that path it compares the file's hash with the
//! recorded one and drops the event on a match. There is no time window: a recorded entry stays
//! until the file is seen with other content (an outside edit, which then passes and clears the
//! entry) or until it is evicted, oldest first, past [`CAPACITY`]. An evicted entry costs one
//! redundant event, which the consumer's own hash check settles.

use std::collections::{HashMap, VecDeque};
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

    /// The hash the app last wrote at `path`, when one is recorded. The watcher hashes the
    /// file only then.
    pub fn expected_hash(&self, path: &str) -> Option<String> {
        match self.lock().by_path.get(path) {
            Some(Expected::Hash(hash)) => Some(hash.clone()),
            _ => None,
        }
    }

    /// `path` was seen with `observed`. True when that is the app's own write, which stays
    /// recorded; any other content is an outside edit and clears the record.
    pub fn absorbs_write(&self, path: &str, observed: &str) -> bool {
        let mut state = self.lock();
        match state.by_path.get(path) {
            Some(Expected::Hash(expected)) if expected == observed => true,
            Some(_) => {
                state.forget(path);
                false
            }
            None => false,
        }
    }

    /// `path` was seen present with no hash to compare (a file that is not markdown, or a
    /// folder). The app's removal of it is over: a later outside delete must pass.
    pub fn seen_present(&self, path: &str) {
        self.cancel_removal(path);
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

    #[test]
    fn an_own_removal_is_absorbed_and_a_recreated_file_is_not() {
        let echo = EchoGuard::default();
        echo.will_remove("a.md");
        assert!(echo.absorbs_removal("a.md"));
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
        echo.seen_present("a.pdf");
        assert!(!echo.absorbs_removal("a.pdf"));
        echo.will_write("a.md", "h");
        echo.seen_present("a.md");
        assert!(
            echo.absorbs_write("a.md", "h"),
            "a write record is not touched"
        );
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
