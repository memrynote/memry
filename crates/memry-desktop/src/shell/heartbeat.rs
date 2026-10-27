//! Renderer liveness. Tauri has no `unresponsive` event, so the page invokes a heartbeat every
//! 2 s and the shell counts misses (`apps/desktop/src/main/index.ts:886-896` logged the same
//! two transitions).

/// The renderer's beat interval.
pub const BEAT_INTERVAL_MS: u64 = 2000;
/// Missed beats before the renderer counts as unresponsive.
pub const MISSED_BEATS: u64 = 3;

#[derive(Debug, Default)]
pub struct HeartbeatMonitor {
    last_beat_ms: Option<u64>,
    unresponsive_since_ms: Option<u64>,
}

impl HeartbeatMonitor {
    /// A beat at `now_ms`. Returns how long the renderer was unresponsive when it recovers.
    pub fn beat(&mut self, now_ms: u64) -> Option<u64> {
        self.last_beat_ms = Some(now_ms);
        self.unresponsive_since_ms
            .take()
            .map(|since| now_ms.saturating_sub(since))
    }

    /// A check at `now_ms`. True once, when the renderer first counts as unresponsive. The
    /// monitor stays quiet until the first beat, because the page starts beating at first
    /// paint.
    pub fn poll(&mut self, now_ms: u64) -> bool {
        let Some(last) = self.last_beat_ms else {
            return false;
        };
        if self.unresponsive_since_ms.is_some()
            || now_ms.saturating_sub(last) < BEAT_INTERVAL_MS * MISSED_BEATS
        {
            return false;
        }
        self.unresponsive_since_ms = Some(last);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_before_the_first_beat() {
        let mut m = HeartbeatMonitor::default();
        assert!(!m.poll(60_000));
    }

    #[test]
    fn three_missed_beats_flag_once_and_recovery_reports_the_duration() {
        let mut m = HeartbeatMonitor::default();
        assert_eq!(m.beat(1_000), None);
        assert!(!m.poll(6_999));
        assert!(m.poll(7_000));
        assert!(!m.poll(9_000));
        assert_eq!(m.beat(12_000), Some(11_000));
        assert!(!m.poll(13_000));
        assert_eq!(m.beat(14_000), None);
    }
}
