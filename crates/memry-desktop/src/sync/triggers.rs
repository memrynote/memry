//! When the supervisor runs a pass: the timings Electron's runtime uses (`engine.ts`,
//! `runtime.ts`, `network.ts`) and the rules over them, kept free of I/O so they test on their
//! own.

use std::time::Duration;

use memry_core::sync::state::PassTrigger;

/// The periodic tick (`engine.ts:92`).
pub const TICK: Duration = Duration::from_secs(60);
/// A tick pulls when the socket dropped since the last tick, or the last pull is this old.
pub const QUIET_PULL: Duration = Duration::from_secs(5 * 60);
/// Local writes coalesce for this long before a push pass (`sync-context.ts:290`).
pub const PUSH_DEBOUNCE: Duration = Duration::from_millis(300);
/// At most one status event per this interval; the latest status wins.
pub const STATUS_THROTTLE: Duration = Duration::from_millis(100);
/// Past this much clock skew against the server, sync pauses (`push-coordinator.ts:525`).
pub const MAX_CLOCK_SKEW_MS: i64 = 300_000;
const RATE_LIMIT_BASE: Duration = Duration::from_secs(5);
const RATE_LIMIT_MAX: Duration = Duration::from_secs(5 * 60);

/// What woke the supervisor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Start,
    /// Reachability came back (already debounced 2 s by `DesktopReachability`).
    Online,
    PowerResume,
    Foreground,
    /// Sync Now.
    Explicit,
    Tick,
    /// The push debounce ran out.
    Push,
}

impl Trigger {
    /// The engine's trigger: a foreground pass refreshes the client policy first (§11.8.1).
    pub fn pass_trigger(self) -> PassTrigger {
        match self {
            Self::Foreground | Self::Start | Self::PowerResume | Self::Online => {
                PassTrigger::Foreground
            }
            Self::Explicit | Self::Push => PassTrigger::Explicit,
            Self::Tick => PassTrigger::Timer,
        }
    }
}

/// The wait after the `n`th consecutive `429` (`n` from 1): the server's `Retry-After` when it is
/// longer, else 5 s doubling, never past 5 min (`error-recovery-handler.ts:143-146`).
pub fn rate_limit_backoff(retry_after: Option<Duration>, n: u32) -> Duration {
    let doubling = RATE_LIMIT_BASE.saturating_mul(1u32 << n.saturating_sub(1).min(16));
    retry_after
        .unwrap_or_default()
        .max(doubling)
        .min(RATE_LIMIT_MAX)
}

/// Whether a tick pulls: the socket would have hinted every change while it stayed connected,
/// so a quiet tick only pulls when it did not, or as a 5-minute safety net.
pub fn tick_pulls(socket_held_since_last_tick: bool, since_last_pull: Option<Duration>) -> bool {
    !socket_held_since_last_tick || since_last_pull.is_none_or(|since| since >= QUIET_PULL)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_backoff_doubles_from_five_seconds_and_caps_at_five_minutes() {
        let secs = |n| rate_limit_backoff(None, n).as_secs();
        assert_eq!([secs(1), secs(2), secs(3), secs(4)], [5, 10, 20, 40]);
        assert_eq!(secs(7), 300, "320 s capped");
        assert_eq!(secs(40), 300);
        assert_eq!(secs(0), 5, "a first failure counted from zero still waits");
    }

    #[test]
    fn a_longer_retry_after_wins_and_is_capped_too() {
        let after = |s| Some(Duration::from_secs(s));
        assert_eq!(rate_limit_backoff(after(30), 1), Duration::from_secs(30));
        assert_eq!(rate_limit_backoff(after(2), 2), Duration::from_secs(10));
        assert_eq!(rate_limit_backoff(after(3600), 1), Duration::from_secs(300));
    }

    #[test]
    fn a_tick_pulls_only_when_the_socket_was_not_held_or_the_pull_is_stale() {
        let ago = |s| Some(Duration::from_secs(s));
        assert!(!tick_pulls(true, ago(60)));
        assert!(!tick_pulls(true, ago(299)));
        assert!(tick_pulls(true, ago(300)));
        assert!(tick_pulls(true, None), "never pulled");
        assert!(tick_pulls(false, ago(1)));
    }
}
