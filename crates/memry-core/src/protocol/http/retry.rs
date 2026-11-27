//! The retry ladder for one call (chapter 07 §7.10, chapter 03 §3.9, chapter 05 §5.6).

/// Chapter 07 §7.10 and chapter 03 §3.9 both spell the same ladder.
pub const DEFAULT_MAX_RETRIES: u32 = 3;

/// The longest a retry may sleep, however long the server asked for.
///
/// Chapter 00 §0.6's ceiling covers one request's socket; this covers the
/// ladder's own waiting, which that ceiling never saw. Thirty seconds is longer
/// than any transient hiccup and shorter than a user's patience — past it, the
/// error goes back so the caller can say what happened.
pub const MAX_RETRY_DELAY_MS: u64 = 30_000;
pub const DEFAULT_BASE_DELAY_MS: u64 = 2_000;

/// The longest a [`RetryPolicy::walk`] waits: one rate-limit window of the
/// routes a walk reads, which answer `Retry-After` with the rest of a 60 s
/// window (`apps/sync-server/src/middleware/rate-limit.ts`).
pub const MAX_WALK_RETRY_DELAY_MS: u64 = 60_000;

/// The retry ladder for one call.
///
/// The knobs are the ones the chapters name — `maxRetries`, `baseDelayMs`,
/// `retryOn429`, `retryOn5xx` (chapter 07 §7.10, chapter 03 §3.9, chapter 05
/// §5.6). The delay is `base * 2^attempt` with no jitter, the shape chapter 02
/// §2.10 uses for refresh; the socket's jittered ladder (chapter 09 §9.10) is a
/// different mechanism and is not this one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub retry_on_429: bool,
    pub retry_on_5xx: bool,
    /// A wait longer than this returns the error instead of sleeping.
    pub max_delay_ms: u64,
    /// Whether a timeout at the request's own deadline is retried. A shell
    /// reports one with `elapsed_ms` at or past `timeout_ms`; an idle timeout
    /// fires earlier (chapter 00 §0.6).
    pub retry_after_deadline: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: DEFAULT_MAX_RETRIES,
            base_delay_ms: DEFAULT_BASE_DELAY_MS,
            retry_on_429: true,
            retry_on_5xx: true,
            max_delay_ms: MAX_RETRY_DELAY_MS,
            retry_after_deadline: true,
        }
    }
}

impl RetryPolicy {
    /// Chapter 07 §7.10 and chapter 03 §3.9: `retryOn429: false`, because for a
    /// polled call the poll cadence is itself the retry.
    pub fn polled() -> Self {
        Self {
            retry_on_429: false,
            ..Self::default()
        }
    }

    /// A pack GET (chapter 00 §0.6): polled, and a deadline that already ran
    /// for minutes is not spent again from byte 0. An idle timeout still is.
    pub fn pack() -> Self {
        Self {
            retry_after_deadline: false,
            ..Self::polled()
        }
    }

    /// Chapter 05 §5.6: `retryOn5xx: false` on `/sync/push`. An oversized push
    /// is terminated at the edge with an empty 503 before any handler runs, so
    /// an identical resend fails identically; the caller halves the batch
    /// instead.
    pub fn push() -> Self {
        Self {
            retry_on_5xx: false,
            ..Self::default()
        }
    }

    /// One page of a bounded walk that answers nothing unless every page is
    /// read, the body manifest (chapter 08 §8.4.3). No poll comes back for
    /// the page, and a walk dropped on one `429` costs far more than its wait
    /// (#5349), so it honours `Retry-After` up to a whole window.
    pub fn walk() -> Self {
        Self {
            max_delay_ms: MAX_WALK_RETRY_DELAY_MS,
            ..Self::default()
        }
    }

    pub fn never() -> Self {
        Self {
            max_retries: 0,
            ..Self::default()
        }
    }

    pub(super) fn backoff_ms(&self, attempt: u32) -> u64 {
        self.base_delay_ms.saturating_mul(1u64 << attempt.min(16))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ladder_doubles_from_the_base_delay() {
        let policy = RetryPolicy::default();
        assert_eq!(policy.backoff_ms(0), 2_000);
        assert_eq!(policy.backoff_ms(1), 4_000);
        assert_eq!(policy.backoff_ms(2), 8_000);
    }
}
