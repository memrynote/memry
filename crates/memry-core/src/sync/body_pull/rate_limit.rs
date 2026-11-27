//! The 429s a first sync's body reads wait out themselves (#5570, #5423).
//!
//! A refused probe or manifest page otherwise falls back to a route pull per
//! document, and a refused document pull is `retryOn429: false` (§7.10), so
//! it would fail the run. The wait goes through the client's sleeper
//! ([`super::BodyPull::wait`], or the bodies pass's queue), so a paused driver
//! cuts it as it cuts a retry's sleep, and the next request answers the pause.

use std::time::Duration;

use crate::api::errors::ApiError;

/// The longest `Retry-After` a body read waits out itself. `crdt_pull` is a
/// sixty-second fixed window, so anything longer is not this limiter and is
/// returned to the caller instead of sat through.
pub const MAX_RATE_LIMIT_PAUSE_S: u64 = 60;

/// How many 429s in a row one bodies pass waits out, its probes and its
/// document pulls together, before it gives up. A read the server answers
/// starts the count again: a bucket that refills (the unelevated thirty batch
/// requests a minute) never runs it out, and a server that refuses every read
/// holds the pass for at most this many windows. The run is resumable, so
/// giving up loses no work.
pub const MAX_RATE_LIMIT_PAUSES: u32 = 8;

/// The 429 pauses a read, or a whole pass, may still take in a row.
#[derive(Debug)]
pub(in crate::sync) struct RateLimitPauses {
    cap: u32,
    in_a_row: u32,
}

impl RateLimitPauses {
    pub(in crate::sync) const fn new(cap: u32) -> Self {
        Self { cap, in_a_row: 0 }
    }

    /// The wait `error` asks for, counted as one more 429 in a row. `None`
    /// when it is no 429, asks for more than [`MAX_RATE_LIMIT_PAUSE_S`], or
    /// `cap` 429s in a row were waited out already.
    pub(in crate::sync) fn take(&mut self, error: &ApiError) -> Option<Duration> {
        // One second at least, the server's own floor (#5547's owner).
        let wait_s = error.rate_limit_wait_s()?;
        if self.in_a_row >= self.cap || wait_s > MAX_RATE_LIMIT_PAUSE_S {
            return None;
        }
        self.in_a_row += 1;
        Some(Duration::from_secs(wait_s))
    }

    /// The server answered a request: its window turned.
    pub(in crate::sync) fn answered(&mut self) {
        self.in_a_row = 0;
    }
}

/// `wait` in whole milliseconds for [`crate::protocol::http::HttpClient::sleep_ms`],
/// rounded up so the wait never ends early.
pub(in crate::sync) fn ceil_ms(wait: Duration) -> u64 {
    u64::try_from(wait.as_micros().div_ceil(1_000)).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate_limited(retry_after_s: Option<u64>) -> ApiError {
        ApiError::RateLimited {
            message: "slow down".to_owned(),
            retry_after_s,
        }
    }

    #[test]
    fn refusals_in_a_row_run_the_budget_out_and_an_answer_restores_it() {
        let mut pauses = RateLimitPauses::new(2);
        assert_eq!(
            pauses.take(&rate_limited(None)),
            Some(Duration::from_secs(1))
        );
        assert!(pauses.take(&rate_limited(Some(3))).is_some());
        assert_eq!(pauses.take(&rate_limited(Some(3))), None, "out");

        pauses.answered();
        assert_eq!(
            pauses.take(&rate_limited(Some(MAX_RATE_LIMIT_PAUSE_S))),
            Some(Duration::from_secs(MAX_RATE_LIMIT_PAUSE_S))
        );
        assert_eq!(
            pauses.take(&rate_limited(Some(MAX_RATE_LIMIT_PAUSE_S + 1))),
            None,
            "not this limiter"
        );
        assert_eq!(
            RateLimitPauses::new(0).take(&rate_limited(Some(1))),
            None,
            "a read that never waits"
        );
    }
}
