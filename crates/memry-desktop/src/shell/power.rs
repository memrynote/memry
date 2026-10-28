//! What the machine tells the app about sleep and the end of the session
//! (`powerMonitor` in `main-thread-stall.ts`, `inbox/review-scheduler.ts`, `updater.ts`).

use std::time::{Duration, Instant};

/// One thing the operating system said, the same on every platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerEvent {
    /// The machine is about to sleep.
    Suspend,
    /// The machine woke.
    Resume,
    /// The user session or the machine is shutting down.
    SessionEnding,
}

/// Windows reports a wake twice (`PBT_APMRESUMEAUTOMATIC` and `PBT_APMRESUMESUSPEND`) and may
/// repeat a suspend. Subscribers see one `Suspend`, then one `Resume`.
#[derive(Debug, Default)]
pub struct SleepEdges {
    asleep: bool,
}

impl SleepEdges {
    /// `Some(Suspend)` for the first suspend since the last wake.
    pub fn suspend(&mut self) -> Option<PowerEvent> {
        if self.asleep {
            return None;
        }
        self.asleep = true;
        Some(PowerEvent::Suspend)
    }

    /// `Some(Resume)` for the first wake after a suspend; a wake with no suspend before it is
    /// not one the app slept through.
    pub fn resume(&mut self) -> Option<PowerEvent> {
        if !self.asleep {
            return None;
        }
        self.asleep = false;
        Some(PowerEvent::Resume)
    }
}

/// The longest one wait of [`wait_for`] sleeps between looks at the work and the message queue.
pub const PUMP_SLICE: Duration = Duration::from_millis(50);

/// Holds the caller until `done` is true or `limit` is spent, calling `pump` with the time it may
/// wait (never more than [`PUMP_SLICE`] or what is left). Windows ends the process shortly after
/// `WM_ENDSESSION` returns, so the handler waits for the quit sequence here, and the
/// `WM_QUERYENDSESSION` handler waits for the windows' flush; `pump` dispatches the thread's
/// messages meanwhile because the webview and the steps need the main thread. True when `done`.
pub fn wait_for(limit: Duration, done: impl Fn() -> bool, mut pump: impl FnMut(Duration)) -> bool {
    let started = Instant::now();
    while !done() {
        let left = limit.saturating_sub(started.elapsed());
        if left.is_zero() {
            return false;
        }
        pump(left.min(PUMP_SLICE));
    }
    true
}

/// `org.freedesktop.login1.Manager.PrepareForSleep(start)`: true before sleep, false after.
pub fn from_prepare_for_sleep(start: bool) -> PowerEvent {
    if start {
        PowerEvent::Suspend
    } else {
        PowerEvent::Resume
    }
}

/// `org.freedesktop.login1.Manager.PrepareForShutdown(start)`: true as the machine goes down.
pub fn from_prepare_for_shutdown(start: bool) -> Option<PowerEvent> {
    start.then_some(PowerEvent::SessionEnding)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_wake_reported_twice_is_one_resume() {
        let mut edges = SleepEdges::default();
        assert_eq!(edges.suspend(), Some(PowerEvent::Suspend));
        // PBT_APMRESUMEAUTOMATIC, then PBT_APMRESUMESUSPEND.
        assert_eq!(edges.resume(), Some(PowerEvent::Resume));
        assert_eq!(edges.resume(), None);
    }

    #[test]
    fn a_repeated_suspend_is_one_suspend() {
        let mut edges = SleepEdges::default();
        assert_eq!(edges.suspend(), Some(PowerEvent::Suspend));
        assert_eq!(edges.suspend(), None);
        assert_eq!(edges.resume(), Some(PowerEvent::Resume));
        assert_eq!(edges.suspend(), Some(PowerEvent::Suspend));
    }

    #[test]
    fn a_wake_with_no_sleep_before_it_is_ignored() {
        let mut edges = SleepEdges::default();
        assert_eq!(edges.resume(), None);
    }

    #[test]
    fn only_prepare_for_shutdown_true_is_the_session_ending() {
        assert_eq!(
            from_prepare_for_shutdown(true),
            Some(PowerEvent::SessionEnding)
        );
        // logind also says `false` when a shutdown it announced is called off.
        assert_eq!(from_prepare_for_shutdown(false), None);
    }

    #[test]
    fn prepare_for_sleep_true_is_suspend_and_false_is_resume() {
        assert_eq!(from_prepare_for_sleep(true), PowerEvent::Suspend);
        assert_eq!(from_prepare_for_sleep(false), PowerEvent::Resume);
    }
    #[test]
    fn a_session_end_wait_that_is_already_done_pumps_nothing() {
        let mut pumps = 0;
        assert!(wait_for(Duration::from_secs(1), || true, |_| pumps += 1));
        assert_eq!(pumps, 0);
    }

    #[test]
    fn a_session_end_wait_pumps_until_the_work_is_done() {
        let pumps = std::cell::Cell::new(0);
        let done = || pumps.get() >= 3;
        assert!(wait_for(Duration::from_secs(5), done, |_| pumps.set(pumps.get() + 1)));
        assert_eq!(pumps.get(), 3);
    }

    #[test]
    fn a_session_end_wait_gives_up_at_the_limit_and_never_pumps_longer_than_what_is_left() {
        let longest = std::cell::Cell::new(Duration::ZERO);
        let limit = Duration::from_millis(30);
        let started = std::time::Instant::now();
        let waited = wait_for(
            limit,
            || false,
            |slice| {
                longest.set(longest.get().max(slice));
                std::thread::sleep(slice);
            },
        );
        assert!(!waited);
        assert!(longest.get() <= PUMP_SLICE);
        assert!(started.elapsed() >= limit);
    }
}
