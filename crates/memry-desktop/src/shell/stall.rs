//! Main-thread stall detection (#2556). A blocked main thread never reaches the window reveal
//! that reports the launch timeline, so a launch that froze left nothing in the log. The shell
//! asks the main thread to acknowledge every second; a watchdog thread, which a blocked main
//! thread cannot stop, polls how old the last acknowledgement is
//! (`apps/desktop/src/main/main-thread-stall.ts`).

/// The main thread is asked to acknowledge this often.
pub const TICK_MS: u64 = 1000;
/// An acknowledgement this old means the main thread has been blocked about two seconds past its
/// tick.
pub const STALL_THRESHOLD_MS: u64 = 3000;
/// A loop that keeps stalling would write a line per tick for the whole run; the first reports
/// are the ones that explain it.
pub const MAX_REPORTS: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StallReport {
    pub duration_ms: u64,
    pub count: u32,
}

#[derive(Debug)]
pub struct StallDetector {
    last_ack_ms: u64,
    reports: u32,
    /// The stall in progress has been reported: one report per stall, not one per poll.
    reported: bool,
    suspended: bool,
}

impl StallDetector {
    pub fn new(now_ms: u64) -> Self {
        Self {
            last_ack_ms: now_ms,
            reports: 0,
            reported: false,
            suspended: false,
        }
    }

    /// The main thread answered.
    pub fn ack(&mut self, now_ms: u64) {
        self.last_ack_ms = now_ms;
        self.reported = false;
    }

    /// System sleep stops the main thread too: the first poll after wake would read as a stall as
    /// long as the sleep. Polls between suspend and resume never report.
    pub fn suspend(&mut self) {
        self.suspended = true;
    }

    /// Re-arms the clock: the wake tick can run before the resume event.
    pub fn resume(&mut self, now_ms: u64) {
        self.suspended = false;
        self.ack(now_ms);
    }

    /// Whether the main thread is blocked now. Returns a report once per stall.
    pub fn poll(&mut self, now_ms: u64) -> Option<StallReport> {
        let age = now_ms.saturating_sub(self.last_ack_ms);
        if self.suspended
            || self.reported
            || age < STALL_THRESHOLD_MS
            || self.reports >= MAX_REPORTS
        {
            return None;
        }
        self.reported = true;
        self.reports += 1;
        Some(StallReport {
            duration_ms: age,
            count: self.reports,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_main_thread_that_answers_is_never_reported() {
        let mut d = StallDetector::new(0);
        for t in (1000..=30_000).step_by(1000) {
            d.ack(t);
            assert_eq!(d.poll(t + 500), None);
        }
    }

    #[test]
    fn a_blocked_main_thread_is_reported_once_with_its_age() {
        let mut d = StallDetector::new(0);
        assert_eq!(d.poll(2999), None);
        assert_eq!(
            d.poll(3000),
            Some(StallReport {
                duration_ms: 3000,
                count: 1
            })
        );
        assert_eq!(d.poll(4000), None);
        assert_eq!(d.poll(60_000), None);
    }

    #[test]
    fn a_new_stall_after_recovery_is_reported_again() {
        let mut d = StallDetector::new(0);
        assert!(d.poll(3500).is_some());
        d.ack(4000);
        assert_eq!(d.poll(6000), None);
        assert_eq!(d.poll(7000).map(|r| r.count), Some(2));
    }

    #[test]
    fn at_most_twenty_reports_are_made() {
        let mut d = StallDetector::new(0);
        let mut made = 0;
        let mut now = 0;
        for _ in 0..50 {
            now += 5000;
            if d.poll(now).is_some() {
                made += 1;
            }
            d.ack(now);
        }
        assert_eq!(made, MAX_REPORTS);
    }

    #[test]
    fn sleep_does_not_read_as_a_stall() {
        let mut d = StallDetector::new(0);
        d.suspend();
        assert_eq!(d.poll(3_600_000), None);
        // The wake poll can run before the resume event.
        assert_eq!(d.poll(3_600_100), None);
        d.resume(3_600_200);
        assert_eq!(d.poll(3_601_000), None);
        assert!(d.poll(3_603_300).is_some());
    }
}
