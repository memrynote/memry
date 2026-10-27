//! Collects the paths the OS reported until each has been quiet for a moment (the 100 ms
//! path debounce and `awaitWriteFinish` of the chokidar options). A file that is still being
//! written keeps resetting its path, up to `max_hold`, then goes through anyway.
//!
//! Bounded by paths, not time: past `max_paths` the map is dropped and [`Debouncer::take_overflow`]
//! says a full rescan must stand in for what was lost.

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const QUIET: Duration = Duration::from_millis(150);
pub const MAX_HOLD: Duration = Duration::from_secs(5);
pub const MAX_PATHS: usize = 100_000;

pub struct Debouncer {
    quiet: Duration,
    max_hold: Duration,
    max_paths: usize,
    /// path -> (first reported, last reported)
    pending: HashMap<String, (Instant, Instant)>,
    overflowed: bool,
}

impl Debouncer {
    pub fn new(quiet: Duration, max_hold: Duration, max_paths: usize) -> Self {
        Self {
            quiet,
            max_hold,
            max_paths,
            pending: HashMap::new(),
            overflowed: false,
        }
    }

    pub fn standard() -> Self {
        Self::new(QUIET, MAX_HOLD, MAX_PATHS)
    }

    pub fn touch(&mut self, path: String, now: Instant) {
        if let Some((_, last)) = self.pending.get_mut(&path) {
            *last = now;
            return;
        }
        if self.pending.len() >= self.max_paths {
            self.pending.clear();
            self.overflowed = true;
            return;
        }
        self.pending.insert(path, (now, now));
    }

    /// The paths that went quiet (or were held long enough), in the order first reported.
    pub fn due(&mut self, now: Instant) -> Vec<String> {
        let mut ready: Vec<(Instant, String)> = self
            .pending
            .iter()
            .filter(|(_, (first, last))| {
                now.duration_since(*last) >= self.quiet
                    || now.duration_since(*first) >= self.max_hold
            })
            .map(|(path, (first, _))| (*first, path.clone()))
            .collect();
        ready.sort();
        for (_, path) in &ready {
            self.pending.remove(path);
        }
        ready.into_iter().map(|(_, path)| path).collect()
    }

    pub fn take_overflow(&mut self) -> bool {
        std::mem::take(&mut self.overflowed)
    }

    pub fn is_idle(&self) -> bool {
        self.pending.is_empty()
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn a_path_is_due_once_it_has_been_quiet() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(ms(100), ms(1000), 10);
        d.touch("a.md".into(), t0);
        assert!(d.due(t0 + ms(99)).is_empty());
        d.touch("a.md".into(), t0 + ms(90));
        assert!(
            d.due(t0 + ms(150)).is_empty(),
            "the second report reset the wait"
        );
        assert_eq!(d.due(t0 + ms(190)), ["a.md"]);
        assert!(d.is_idle());
    }

    #[test]
    fn a_path_that_never_goes_quiet_is_released_at_the_hold_limit() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(ms(100), ms(1000), 10);
        for step in 0..=20 {
            d.touch("log.md".into(), t0 + ms(step * 50));
        }
        assert_eq!(d.due(t0 + ms(1000)), ["log.md"]);
    }

    #[test]
    fn paths_come_out_in_the_order_they_were_first_reported() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(ms(10), ms(1000), 10);
        d.touch("z.md".into(), t0);
        d.touch("a.md".into(), t0 + ms(1));
        assert_eq!(d.due(t0 + ms(50)), ["z.md", "a.md"]);
    }

    #[test]
    fn past_the_path_cap_the_map_is_dropped_and_a_rescan_is_owed() {
        let t0 = Instant::now();
        let mut d = Debouncer::new(ms(10), ms(1000), 3);
        for n in 0..4 {
            d.touch(format!("{n}.md"), t0);
        }
        assert!(d.is_idle());
        assert!(d.take_overflow());
        assert!(!d.take_overflow());
    }
}
