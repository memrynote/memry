//! What the machine tells the app about sleep and the end of the session
//! (`powerMonitor` in `main-thread-stall.ts`, `inbox/review-scheduler.ts`, `updater.ts`).

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

/// `org.freedesktop.login1.Manager.PrepareForSleep(start)`: true before sleep, false after.
pub fn from_prepare_for_sleep(start: bool) -> PowerEvent {
    if start {
        PowerEvent::Suspend
    } else {
        PowerEvent::Resume
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn prepare_for_sleep_true_is_suspend_and_false_is_resume() {
        assert_eq!(from_prepare_for_sleep(true), PowerEvent::Suspend);
        assert_eq!(from_prepare_for_sleep(false), PowerEvent::Resume);
    }
}
