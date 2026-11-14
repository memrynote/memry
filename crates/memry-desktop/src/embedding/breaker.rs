//! The model-load circuit breaker of Electron's `EmbeddingModelBridge`
//! (`apps/desktop/src/main/lib/embeddings.ts:131-143, 246-262, 683-728`). A failed load is
//! almost always the download failing, so it is retried on a widening schedule, 60 s, 2 min,
//! 4 min, 8 min, and the fifth consecutive failure stops loads for the app session (#803, #840).
//! Enabling AI, a manual load or a rebuild clears it ([`Breaker::clear`]).

use std::time::{Duration, Instant};

/// `LOAD_RETRY_BASE_DELAY_MS`.
pub const RETRY_BASE: Duration = Duration::from_secs(60);
/// `MAX_CONSECUTIVE_LOAD_FAILURES`.
pub const MAX_CONSECUTIVE_FAILURES: u32 = 5;

#[derive(Debug)]
pub(crate) struct Breaker {
    base: Duration,
    consecutive: u32,
    /// Worker faults while embedding since the last delivered embedding. A load success does not
    /// clear them, or a model that loads and then fails every inference never opens the breaker
    /// (#3407).
    pub(crate) embed_failures: u32,
    latched: bool,
    retry_not_before: Option<Instant>,
}

impl Breaker {
    pub(crate) fn new(base: Duration) -> Self {
        Self {
            base,
            consecutive: 0,
            embed_failures: 0,
            latched: false,
            retry_not_before: None,
        }
    }

    /// `isBreakerOpen`: backing off, or stopped for the session.
    pub(crate) fn is_open(&self, now: Instant) -> bool {
        self.latched || self.retry_not_before.is_some_and(|at| now < at)
    }

    /// `recordFailure`: the delay before the next attempt, or `None` once loads stop.
    pub(crate) fn record_failure(&mut self, now: Instant) -> Option<Duration> {
        self.consecutive += 1;
        if self.consecutive >= MAX_CONSECUTIVE_FAILURES {
            self.latched = true;
            self.retry_not_before = None;
            return None;
        }
        let delay = self.base * 2u32.pow(self.consecutive - 1);
        self.retry_not_before = Some(now + delay);
        Some(delay)
    }

    /// `recordSuccess`.
    pub(crate) fn record_success(&mut self) {
        self.latched = false;
        self.consecutive = 0;
        self.retry_not_before = None;
    }

    /// `clearLoadFailure`.
    pub(crate) fn clear(&mut self) {
        self.record_success();
        self.embed_failures = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// embeddings.ts:131-143: 60 s, 2 min, 4 min, 8 min, then no more attempts; never a 16 min
    /// wait.
    #[test]
    fn delays_double_four_times_then_loads_stop_for_the_session() {
        let start = Instant::now();
        let mut breaker = Breaker::new(RETRY_BASE);
        let delays: Vec<_> = (0..4).map(|_| breaker.record_failure(start)).collect();
        let minutes = |m: u64| Some(Duration::from_secs(60 * m));
        assert_eq!(delays, [minutes(1), minutes(2), minutes(4), minutes(8)]);
        assert!(breaker.is_open(start + Duration::from_secs(479)));
        assert!(!breaker.is_open(start + Duration::from_secs(480)));

        for _ in 0..3 {
            assert_eq!(breaker.record_failure(start), None);
        }
        assert!(breaker.is_open(start + Duration::from_secs(24 * 3600)));
    }

    #[test]
    fn a_success_or_a_clear_reopens_loads_at_once() {
        let now = Instant::now();
        let mut breaker = Breaker::new(RETRY_BASE);
        for _ in 0..MAX_CONSECUTIVE_FAILURES {
            breaker.record_failure(now);
        }
        breaker.embed_failures = 2;
        breaker.record_success();
        assert!(!breaker.is_open(now));
        assert_eq!(breaker.embed_failures, 2);
        assert_eq!(breaker.record_failure(now), Some(RETRY_BASE));
        breaker.clear();
        assert!(!breaker.is_open(now));
        assert_eq!(breaker.embed_failures, 0);
    }
}
