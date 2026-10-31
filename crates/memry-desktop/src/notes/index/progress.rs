//! Which progress steps of a reindex reach the renderer.

use std::time::{Duration, Instant};

/// `built` of `total` notes measured or skipped so far.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexProgress {
    pub built: usize,
    pub total: usize,
}

/// Lets a step through when it is the first, the last (`built == total`), or `interval` after
/// the last one let through; never one below a step already let through.
pub struct ProgressThrottle {
    interval: Duration,
    last: Option<(Instant, usize)>,
}

impl ProgressThrottle {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last: None,
        }
    }

    pub fn offer(&mut self, step: IndexProgress, now: Instant) -> bool {
        let pass = match self.last {
            None => true,
            Some((at, built)) => {
                step.built >= built
                    && (step.built == step.total || now.duration_since(at) >= self.interval)
                    && !(step.built == built && built == step.total)
            }
        };
        if pass {
            self.last = Some((now, step.built));
        }
        pass
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_step_per_interval_never_backwards_and_the_last_always() {
        let mut throttle = ProgressThrottle::new(Duration::from_millis(250));
        let t0 = Instant::now();
        let at = |ms| t0 + Duration::from_millis(ms);
        let step = |built| IndexProgress { built, total: 10 };
        let passed: Vec<bool> = [
            (step(0), at(0)),
            (step(2), at(100)),
            (step(4), at(260)),
            (step(3), at(600)),
            (step(5), at(400)),
            (step(10), at(410)),
            (step(10), at(900)),
        ]
        .into_iter()
        .map(|(step, now)| throttle.offer(step, now))
        .collect();
        assert_eq!(passed, [true, false, true, false, false, true, false]);
    }

    #[test]
    fn an_empty_vault_reports_done_once() {
        let mut throttle = ProgressThrottle::new(Duration::from_millis(250));
        let now = Instant::now();
        let empty = IndexProgress { built: 0, total: 0 };
        assert!(throttle.offer(empty, now));
        assert!(!throttle.offer(empty, now));
    }
}
