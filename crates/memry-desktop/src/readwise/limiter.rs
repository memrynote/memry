//! The Reader request budget (`RequestLimiter`, `apps/desktop/src/main/readwise/reader.ts:63`):
//! at most `limit` requests in any window. The v3 list allows 20 a minute per token; the v2
//! export allows 240 and has no limiter.

use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::client::{ReadwiseError, cancellable};

/// `READER_REQUESTS_PER_MINUTE`.
pub const READER_REQUESTS_PER_MINUTE: usize = 20;
const READER_WINDOW: Duration = Duration::from_secs(60);

/// A sliding-window budget. Waiters take their turn in the order they asked: the lock is fair
/// and held across the wait, as the TypeScript chains each turn onto the last.
pub struct RequestLimiter {
    limit: usize,
    window: Duration,
    stamps: Mutex<VecDeque<Instant>>,
}

impl RequestLimiter {
    pub fn new(limit: usize, window: Duration) -> Self {
        Self {
            limit,
            window,
            stamps: Mutex::new(VecDeque::with_capacity(limit)),
        }
    }

    /// The Reader budget of this process: a vault holds one token, and the budget belongs to
    /// the token (`sharedLimiter`).
    pub fn reader() -> Arc<Self> {
        static READER: OnceLock<Arc<RequestLimiter>> = OnceLock::new();
        Arc::clone(
            READER.get_or_init(|| Arc::new(Self::new(READER_REQUESTS_PER_MINUTE, READER_WINDOW))),
        )
    }

    /// Returns when a request may go out. A cancelled waiter gives up its turn and takes no
    /// slot.
    pub async fn acquire(&self, cancel: &CancellationToken) -> Result<(), ReadwiseError> {
        let mut stamps = cancellable(cancel, self.stamps.lock()).await?;
        loop {
            let now = Instant::now();
            while stamps
                .front()
                .is_some_and(|stamp| now.duration_since(*stamp) >= self.window)
            {
                stamps.pop_front();
            }
            let Some(&oldest) = stamps.front().filter(|_| stamps.len() >= self.limit) else {
                stamps.push_back(now);
                return Ok(());
            };
            cancellable(cancel, tokio::time::sleep_until(oldest + self.window)).await?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);

    #[tokio::test(start_paused = true)]
    async fn the_budget_is_spent_at_once_and_the_next_request_waits_for_the_oldest_to_age_out() {
        let limiter = RequestLimiter::new(20, MINUTE);
        let cancel = CancellationToken::new();
        let start = Instant::now();
        for _ in 0..20 {
            limiter.acquire(&cancel).await.unwrap();
        }
        assert_eq!(Instant::now(), start);
        limiter.acquire(&cancel).await.unwrap();
        assert_eq!(Instant::now().duration_since(start), MINUTE);
    }

    #[tokio::test(start_paused = true)]
    async fn the_window_slides_from_each_request_not_from_the_first() {
        let limiter = RequestLimiter::new(2, MINUTE);
        let cancel = CancellationToken::new();
        let start = Instant::now();
        limiter.acquire(&cancel).await.unwrap();
        tokio::time::advance(Duration::from_secs(30)).await;
        limiter.acquire(&cancel).await.unwrap();
        // Full: the first stamp ages out at 60 s, the second at 90 s.
        limiter.acquire(&cancel).await.unwrap();
        assert_eq!(Instant::now().duration_since(start), MINUTE);
        limiter.acquire(&cancel).await.unwrap();
        assert_eq!(
            Instant::now().duration_since(start),
            Duration::from_secs(90)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_cancelled_waiter_takes_no_slot_and_the_next_one_still_gets_through() {
        let limiter = Arc::new(RequestLimiter::new(1, MINUTE));
        let start = Instant::now();
        limiter.acquire(&CancellationToken::new()).await.unwrap();

        let cancel = CancellationToken::new();
        let waiting = {
            let limiter = Arc::clone(&limiter);
            let cancel = cancel.clone();
            tokio::spawn(async move { limiter.acquire(&cancel).await })
        };
        tokio::task::yield_now().await;
        cancel.cancel();
        assert!(matches!(
            waiting.await.unwrap(),
            Err(ReadwiseError::Cancelled)
        ));

        limiter.acquire(&CancellationToken::new()).await.unwrap();
        assert_eq!(Instant::now().duration_since(start), MINUTE);
    }
}
