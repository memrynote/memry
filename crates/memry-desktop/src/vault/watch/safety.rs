//! The rescans that stand in for events the OS watcher may have lost without saying so.
//!
//! A full rescan is the one repair for lost events (`rescan`). Some losses announce themselves
//! (the inotify and FSEvents overflow flags, a full channel, a debounce overflow) and the
//! runtime rescans on the spot. Others do not:
//!
//! - `notify` 8.2.1 on Windows reads changes into a 16 KiB buffer, ignores the byte count a
//!   read returns (an overflow returns zero) and never raises its rescan flag; on any other
//!   error code it stops watching the folder with a log line and sends the handler nothing. A
//!   large checkout or copy can therefore drop events, and a dead watch looks like a quiet
//!   vault.
//! - A backend error (the Linux inotify limit on a new folder) leaves part of the vault
//!   unwatched.
//!
//! So a [`SafetyNet`] asks for a rescan when: a burst of events could have overflowed a buffer
//! (Windows; the rescan waits until the burst has been quiet for [`SETTLE`]), every
//! [`WINDOWS_INTERVAL`] (Windows), a little after any backend error, and, once a backend error
//! was seen, every [`DEGRADED_INTERVAL`] for the rest of the session.
//!
//! Only Windows also re-arms the OS watcher ([`Tuning::rearm`]): there a watch the OS dropped
//! silently is the failure. On Linux a re-arm would add the whole tree to inotify a second
//! time, which is what runs out when a backend error is the limit.
//!
//! A rescan is routine here, so what it finds goes through the same rename window and disk
//! re-check as any live delete (`reconcile`): a rescan that runs mid-checkout reports nothing
//! the checkout undoes.

use std::time::{Duration, Instant};

pub const WINDOWS_INTERVAL: Duration = Duration::from_secs(10 * 60);
pub const DEGRADED_INTERVAL: Duration = Duration::from_secs(60);
/// Path notifications taken in one worker tick that may have filled a 16 KiB buffer.
pub const BURST_PATHS: usize = 100;
/// How long a burst or an error waits before the rescan, so one rescan covers all of it.
pub const SETTLE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tuning {
    /// A rescan this often, from the start; `None` until an error is seen.
    pub periodic: Option<Duration>,
    /// A burst of this many path notifications in one tick owes a rescan.
    pub burst: Option<usize>,
    /// Re-arm the OS watcher with each safety rescan.
    pub rearm: bool,
}

impl Tuning {
    /// Windows needs the net from the start; the other platforms signal their overflows.
    pub fn platform() -> Self {
        if cfg!(windows) {
            Self::windows()
        } else {
            Self::none()
        }
    }

    pub fn windows() -> Self {
        Self {
            periodic: Some(WINDOWS_INTERVAL),
            burst: Some(BURST_PATHS),
            rearm: true,
        }
    }

    pub fn none() -> Self {
        Self {
            periodic: None,
            burst: None,
            rearm: false,
        }
    }
}

pub struct SafetyNet {
    rearm: bool,
    burst: Option<usize>,
    periodic: Option<Duration>,
    next_periodic: Option<Instant>,
    owed_at: Option<Instant>,
}

impl SafetyNet {
    pub fn new(tuning: Tuning, now: Instant) -> Self {
        Self {
            rearm: tuning.rearm,
            burst: tuning.burst,
            periodic: tuning.periodic,
            next_periodic: tuning.periodic.map(|every| now + every),
            owed_at: None,
        }
    }

    /// The OS watcher reported an error: events may be lost, and it may be blind to part of the
    /// vault from now on.
    pub fn lost_events(&mut self, now: Instant) {
        self.owed_at.get_or_insert(now + SETTLE);
        if self.periodic.is_none_or(|every| every > DEGRADED_INTERVAL) {
            self.periodic = Some(DEGRADED_INTERVAL);
            self.next_periodic = Some(now + DEGRADED_INTERVAL);
        }
    }

    /// `paths` notifications arrived in one tick. A burst owes a rescan once it has been quiet
    /// for [`SETTLE`]: every busy tick pushes the rescan back, so one runs after a flood and
    /// not in the middle of it.
    pub fn traffic(&mut self, paths: usize, now: Instant) {
        if self.burst.is_some_and(|limit| paths >= limit) {
            self.owed_at = Some(now + SETTLE);
        }
    }

    /// Whether the rescan that is due re-arms the OS watcher.
    pub fn rearms(&self) -> bool {
        self.rearm
    }

    /// True once when a rescan, with the watcher re-armed, is owed.
    pub fn rescan_due(&mut self, now: Instant) -> bool {
        let owed = self.owed_at.is_some_and(|at| at <= now);
        let periodic = self.next_periodic.is_some_and(|at| at <= now);
        if !owed && !periodic {
            return false;
        }
        self.owed_at = None;
        self.next_periodic = self.periodic.map(|every| now + every);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn a_platform_that_signals_its_overflows_rescans_on_nothing_until_an_error() {
        let t0 = Instant::now();
        let mut net = SafetyNet::new(Tuning::none(), t0);
        net.traffic(1_000_000, t0);
        assert!(!net.rescan_due(t0 + secs(100_000)));
        net.lost_events(t0);
        assert!(!net.rescan_due(t0 + SETTLE - Duration::from_millis(1)));
        assert!(net.rescan_due(t0 + SETTLE), "soon after the error");
        assert!(!net.rescan_due(t0 + SETTLE + secs(1)), "once");
        assert!(
            net.rescan_due(t0 + SETTLE + DEGRADED_INTERVAL),
            "and then for the rest of the session"
        );
    }

    #[test]
    fn a_burst_that_may_have_filled_the_windows_buffer_owes_one_rescan() {
        let t0 = Instant::now();
        let mut net = SafetyNet::new(Tuning::windows(), t0);
        net.traffic(BURST_PATHS - 1, t0);
        assert!(!net.rescan_due(t0 + secs(5)));
        net.traffic(BURST_PATHS, t0);
        net.traffic(BURST_PATHS, t0 + Duration::from_millis(1500));
        assert!(
            !net.rescan_due(t0 + SETTLE),
            "the flood is still going: the rescan waits for it to end"
        );
        let quiet = t0 + Duration::from_millis(1500) + SETTLE;
        assert!(net.rescan_due(quiet));
        assert!(!net.rescan_due(quiet + Duration::from_millis(1)));
    }

    #[test]
    fn only_windows_re_arms_the_watcher() {
        let t0 = Instant::now();
        assert!(SafetyNet::new(Tuning::windows(), t0).rearms());
        let mut net = SafetyNet::new(Tuning::none(), t0);
        net.lost_events(t0);
        assert!(!net.rearms(), "a backend error rescans; it never re-arms");
    }

    #[test]
    fn windows_rescans_on_a_timer_even_when_nothing_was_reported() {
        let t0 = Instant::now();
        let mut net = SafetyNet::new(Tuning::windows(), t0);
        assert!(!net.rescan_due(t0 + WINDOWS_INTERVAL - Duration::from_millis(1)));
        assert!(net.rescan_due(t0 + WINDOWS_INTERVAL));
        assert!(!net.rescan_due(t0 + WINDOWS_INTERVAL + secs(1)));
        assert!(net.rescan_due(t0 + 2 * WINDOWS_INTERVAL));
    }
}
