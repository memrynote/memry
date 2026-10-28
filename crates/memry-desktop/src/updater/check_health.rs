//! The stuck-updater escalation (`recordUpdaterCheckFailure` in
//! `apps/desktop/src/main/updater-error-severity.ts`). A demoted check failure must not hide an
//! install that has not completed a single check in a day while awake and retrying: that
//! install can no longer receive a fix. Both conditions are required. Time alone fires for a
//! laptop that slept through the window; the count alone fires for an hour-long outage.

const STUCK_CHECK_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
const STUCK_CHECK_FAILURES: u32 = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdaterCheckHealth {
    /// Init time until the first successful check, so an install that never succeeds still ages.
    pub last_success_at: u64,
    pub consecutive_failures: u32,
    pub stuck_reported: bool,
}

impl UpdaterCheckHealth {
    pub fn new(now: u64) -> Self {
        Self {
            last_success_at: now,
            consecutive_failures: 0,
            stuck_reported: false,
        }
    }

    /// Starts the clock again (updater init).
    pub fn reset(&mut self, now: u64) {
        *self = Self::new(now);
    }

    /// A check that reached the feed, with or without an update, clears the streak.
    pub fn record_check_success(&mut self, now: u64) {
        *self = Self::new(now);
    }

    /// Counts a failed check. `stuck` is true once per streak, latched until the next success,
    /// so the escalation is one exception and not a second flood.
    pub fn record_check_failure(&mut self, now: u64) -> (u32, bool) {
        self.consecutive_failures += 1;
        let stuck = !self.stuck_reported
            && self.consecutive_failures >= STUCK_CHECK_FAILURES
            && now.saturating_sub(self.last_success_at) >= STUCK_CHECK_WINDOW_MS;
        if stuck {
            self.stuck_reported = true;
        }
        (self.consecutive_failures, stuck)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `Date.UTC(2026, 7, 19, 9, 0, 0)`.
    const START: u64 = 1_787_130_000_000;
    const HOUR: u64 = 60 * 60 * 1000;
    const DAY: u64 = 24 * HOUR;

    #[test]
    fn stays_quiet_for_one_laptop_that_is_offline_for_an_afternoon() {
        let mut health = UpdaterCheckHealth::new(START);
        for index in 1..=5 {
            assert!(!health.record_check_failure(START + index * HOUR).1);
        }
        assert_eq!(health.record_check_failure(START + 6 * HOUR), (6, false));
    }

    #[test]
    fn escalates_once_when_an_install_has_not_completed_a_check_in_a_day() {
        let mut health = UpdaterCheckHealth::new(START);
        for index in 1..=5 {
            assert!(!health.record_check_failure(START + DAY + index).1);
        }
        assert_eq!(health.record_check_failure(START + DAY + 6), (6, true));
        assert!(!health.record_check_failure(START + DAY + 7).1);
        assert!(!health.record_check_failure(START + 2 * DAY).1);
    }

    #[test]
    fn does_not_escalate_on_the_first_failed_check_after_a_long_sleep() {
        let mut health = UpdaterCheckHealth::new(START);
        assert_eq!(health.record_check_failure(START + 7 * DAY), (1, false));
    }

    #[test]
    fn a_successful_check_clears_the_streak_and_re_arms_the_escalation() {
        let mut health = UpdaterCheckHealth::new(START);
        for index in 1..=6 {
            health.record_check_failure(START + DAY + index);
        }
        health.record_check_success(START + DAY + 10);
        assert_eq!(health.record_check_failure(START + DAY + 11), (1, false));
        for index in 2..=5 {
            assert!(!health.record_check_failure(START + 2 * DAY + index).1);
        }
        assert!(health.record_check_failure(START + 2 * DAY + 20).1);
    }

    #[test]
    fn reset_starts_the_clock_again() {
        let mut health = UpdaterCheckHealth::new(START);
        for index in 1..=5 {
            health.record_check_failure(START + DAY + index);
        }
        health.reset(START + DAY + 6);
        assert_eq!(health.record_check_failure(START + DAY + 7), (1, false));
    }
}
