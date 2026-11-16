//! The shared admission of CRDT pushes: note-text updates and snapshots
//! (`apps/desktop/src/main/sync/crdt-push-admission.ts`, main `78d912e379`).
//!
//! The server allows 300 CRDT push requests a minute per device, shared by
//! `/sync/crdt/updates` and the snapshot routes. One owner per driver paces
//! every one of them: a start at most every [`START_INTERVAL`], at most
//! [`MAX_ACTIVE`] in flight, and after a `429` no start at all until its
//! `Retry-After` has passed. That cooldown holds every queued document, not
//! only the one that drew it.
//!
//! Time is tokio's, so tests run it on a paused clock.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::time::Instant;

use crate::api::errors::ApiError;

/// `START_INTERVAL_MS`: headroom under the shared 300 requests a minute.
pub const START_INTERVAL: Duration = Duration::from_millis(250);
/// `MAX_ACTIVE`.
pub const MAX_ACTIVE: usize = 2;
/// The cooldown of a `429` that named no `Retry-After`.
pub const DEFAULT_COOLDOWN: Duration = Duration::from_secs(5);

#[derive(Default)]
struct State {
    active: usize,
    next_start: Option<Instant>,
    cooldown_until: Option<Instant>,
}

/// One driver's admission. Cheap to share behind an `Arc`.
#[derive(Default)]
pub struct CrdtAdmission {
    state: Mutex<State>,
}

/// One admitted request; dropping it frees its slot.
pub struct Permit(Arc<CrdtAdmission>);

impl Drop for Permit {
    fn drop(&mut self) {
        let mut state = self.0.lock();
        state.active = state.active.saturating_sub(1);
    }
}

impl CrdtAdmission {
    /// Waits out the spacing and a full house, then admits. A `429` cooldown
    /// is not waited out: it answers how long is left, and the caller keeps
    /// its rows queued (`admitCrdtPush` fails fast the same way).
    pub async fn admit(self: &Arc<Self>) -> Result<Permit, Duration> {
        loop {
            let now = Instant::now();
            let wait = {
                let mut state = self.lock();
                if let Some(left) = state.cooldown_until.map(|until| until - now)
                    && !left.is_zero()
                {
                    return Err(left);
                }
                let spacing = state.next_start.map_or(Duration::ZERO, |at| at - now);
                if spacing.is_zero() && state.active < MAX_ACTIVE {
                    state.active += 1;
                    state.next_start = Some(now + START_INTERVAL);
                    return Ok(Permit(Arc::clone(self)));
                }
                // A full house polls a slot every interval, as `crdtPushDelayMs` does.
                if spacing.is_zero() {
                    START_INTERVAL
                } else {
                    spacing
                }
            };
            tokio::time::sleep(wait).await;
        }
    }

    /// The time left in a `429` cooldown, zero when there is none.
    pub fn cooldown(&self) -> Duration {
        let now = Instant::now();
        self.lock()
            .cooldown_until
            .map_or(Duration::ZERO, |until| until - now)
    }

    /// Holds every CRDT push when `error` is a `429` (`holdCrdtPushes`).
    pub fn note(&self, error: &ApiError) {
        if let ApiError::RateLimited { retry_after_s, .. } = error {
            let wait = retry_after_s.map_or(DEFAULT_COOLDOWN, Duration::from_secs);
            let until = Instant::now() + wait;
            let mut state = self.lock();
            state.cooldown_until = Some(state.cooldown_until.map_or(until, |at| at.max(until)));
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rate_limited(seconds: u64) -> ApiError {
        ApiError::RateLimited {
            retry_after_s: Some(seconds),
            message: "slow down".to_owned(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn starts_are_spaced_by_the_interval() {
        let admission = Arc::new(CrdtAdmission::default());
        let start = Instant::now();
        let first = admission.admit().await.unwrap();
        drop(first);
        let _second = admission.admit().await.unwrap();
        assert_eq!(Instant::now() - start, START_INTERVAL);
    }

    #[tokio::test(start_paused = true)]
    async fn a_third_push_waits_for_a_slot() {
        let admission = Arc::new(CrdtAdmission::default());
        let start = Instant::now();
        let first = admission.admit().await.unwrap();
        let _second = admission.admit().await.unwrap();
        let third = {
            let admission = Arc::clone(&admission);
            tokio::spawn(async move { admission.admit().await.map(|_| Instant::now()) })
        };
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!third.is_finished(), "two are active: the third must wait");
        drop(first);
        let admitted = third.await.unwrap().unwrap();
        assert!(admitted - start >= Duration::from_secs(3));
    }

    #[tokio::test(start_paused = true)]
    async fn a_429_holds_every_push_until_its_retry_after() {
        let admission = Arc::new(CrdtAdmission::default());
        admission.note(&rate_limited(7));
        assert_eq!(admission.admit().await.err(), Some(Duration::from_secs(7)));
        tokio::time::sleep(Duration::from_secs(6)).await;
        assert_eq!(admission.admit().await.err(), Some(Duration::from_secs(1)));
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(admission.admit().await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_shorter_429_never_shortens_the_cooldown() {
        let admission = CrdtAdmission::default();
        admission.note(&rate_limited(30));
        admission.note(&rate_limited(2));
        assert_eq!(admission.cooldown(), Duration::from_secs(30));
        admission.note(&ApiError::WritesDisabled {
            message: "off".to_owned(),
        });
        assert_eq!(admission.cooldown(), Duration::from_secs(30));
    }
}
