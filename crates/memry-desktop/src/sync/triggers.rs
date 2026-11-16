//! When the supervisor runs a pass: the timings Electron's runtime uses (`engine.ts`,
//! `runtime.ts`, `network.ts`) and the rules over them, kept free of I/O so they test on their
//! own.

use std::time::Duration;

use memry_core::sync::state::PassTrigger;

/// The periodic tick (`engine.ts:92`).
pub const TICK: Duration = Duration::from_secs(60);
/// A tick pulls when the socket dropped since the last tick, or the last pull is this old.
pub const QUIET_PULL: Duration = Duration::from_secs(5 * 60);
/// Push passes start at least this far apart; a push after a quiet window goes out at once
/// (`push-coordinator.ts:585-609`).
pub const PUSH_DEBOUNCE: Duration = Duration::from_millis(300);
/// How often the loop asks whether a snapshot came due: `SNAPSHOT_BATCH_WINDOW_MS`
/// (`crdt-snapshot-scheduler.ts:30`), so the documents due together go in one batch.
pub const SNAPSHOT_TICK: Duration = Duration::from_secs(2);
/// At most one status event per this interval; the latest status wins.
pub const STATUS_THROTTLE: Duration = Duration::from_millis(100);
/// Past this much clock skew against the server, sync pauses (`push-coordinator.ts:525`).
pub const MAX_CLOCK_SKEW_MS: i64 = 300_000;
/// The retries after the keychain could not be read (`keychain-retry.ts:23`); the last repeats.
pub const KEYCHAIN_RETRY: [Duration; 5] = [
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
];
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
    /// A requested push's 300 ms window ended.
    Push,
    /// A socket hint (chapter 09): the engine's wake, which drops a hint at or below the applied
    /// cursor. `None` pulls whatever the feed holds.
    Hint {
        cursor: Option<i64>,
    },
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
            Self::Hint { .. } => PassTrigger::SocketHint,
        }
    }

    /// The one of two queued triggers that does more: a policy refresh beats a plain pass, which
    /// beats a timer pass, which beats a hint.
    pub fn stronger(self, other: Self) -> Self {
        // Two hints are one wake past both cursors; a hint without one pulls whatever is there.
        if let (Self::Hint { cursor: a }, Self::Hint { cursor: b }) = (self, other) {
            return Self::Hint {
                cursor: a.zip(b).map(|(a, b)| a.max(b)),
            };
        }
        let rank = |trigger: Self| match trigger.pass_trigger() {
            PassTrigger::Foreground => 3,
            PassTrigger::Explicit => 2,
            PassTrigger::Timer => 1,
            // A plain pass pulls everything a hint would; a hint may be dropped by its cursor.
            PassTrigger::SocketHint => 0,
        };
        if rank(other) > rank(self) {
            other
        } else {
            self
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

/// The wait before keychain retry `attempt` (from 0).
pub fn keychain_retry(attempt: u32) -> Duration {
    KEYCHAIN_RETRY[(attempt as usize).min(KEYCHAIN_RETRY.len() - 1)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_hints_merge_into_one_wake_and_a_plain_pass_beats_them() {
        let hint = |cursor| Trigger::Hint { cursor };
        assert_eq!(hint(Some(3)).stronger(hint(Some(9))), hint(Some(9)));
        assert_eq!(hint(Some(3)).stronger(hint(None)), hint(None));
        assert_eq!(hint(Some(3)).stronger(Trigger::Push), Trigger::Push);
        assert_eq!(Trigger::Explicit.stronger(hint(None)), Trigger::Explicit);
        assert_eq!(hint(None).stronger(Trigger::Tick), Trigger::Tick);
    }

    #[test]
    fn the_keychain_ladder_is_15_30_60_120_then_300_seconds() {
        let secs: Vec<u64> = (0..7).map(|n| keychain_retry(n).as_secs()).collect();
        assert_eq!(secs, [15, 30, 60, 120, 300, 300, 300]);
    }

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
