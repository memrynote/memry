//! The paths whose fact failed, retried with doubling delays until the next open.

use std::collections::HashMap;
use std::time::Instant;

use super::{FIRST_RETRY, MAX_RETRIES};

/// Paths whose fact failed, with their next attempt.
#[derive(Default)]
pub(super) struct Retries {
    by_path: HashMap<String, Retry>,
}

struct Retry {
    attempts: u32,
    due: Option<Instant>,
}

impl Retries {
    pub(super) fn schedule(&mut self, path: String, now: Instant) {
        let retry = self.by_path.entry(path).or_insert(Retry {
            attempts: 0,
            due: None,
        });
        retry.attempts += 1;
        if retry.attempts > MAX_RETRIES {
            if retry.attempts == MAX_RETRIES + 1 {
                tracing::warn!(
                    scope = "vault_consumer",
                    "a vault file failed {MAX_RETRIES} times; the next open tries again"
                );
            }
            retry.due = None;
            return;
        }
        retry.due = Some(now + FIRST_RETRY * 2u32.pow(retry.attempts - 1));
    }

    /// A path that was applied starts its count again the next time it fails.
    pub(super) fn succeeded(&mut self, path: &str) -> bool {
        self.by_path.remove(path).is_some()
    }

    /// No path waits for a retry, nor gave up until the next open.
    pub(super) fn is_empty(&self) -> bool {
        self.by_path.is_empty()
    }

    pub(super) fn next_due(&self) -> Option<Instant> {
        self.by_path.values().filter_map(|r| r.due).min()
    }

    pub(super) fn due(&mut self, now: Instant) -> Vec<String> {
        let mut due = Vec::new();
        for (path, retry) in &mut self.by_path {
            if retry.due.is_some_and(|at| at <= now) {
                retry.due = None;
                due.push(path.clone());
            }
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn a_path_is_retried_with_doubling_delays_and_then_left_for_the_next_open() {
        let t0 = Instant::now();
        let mut retries = Retries::default();
        let mut at = t0;
        for n in 0..MAX_RETRIES {
            retries.schedule("a.md".into(), at);
            let due = retries.next_due().expect("a retry is due");
            assert_eq!(due - at, FIRST_RETRY * 2u32.pow(n));
            assert!(retries.due(due - Duration::from_millis(1)).is_empty());
            assert_eq!(retries.due(due), vec!["a.md".to_owned()]);
            at = due;
        }
        retries.schedule("a.md".into(), at);
        assert_eq!(retries.next_due(), None, "a sixth attempt was scheduled");
    }

    #[test]
    fn a_path_that_was_applied_starts_its_count_again() {
        let t0 = Instant::now();
        let mut retries = Retries::default();
        for _ in 0..MAX_RETRIES {
            retries.schedule("a.md".into(), t0);
        }
        retries.succeeded("a.md");
        retries.schedule("a.md".into(), t0);
        assert_eq!(retries.next_due(), Some(t0 + FIRST_RETRY));
    }
}
