//! What to do when the web content process of a window dies. WebKit leaves the window frozen and
//! WebView2 leaves it blank, so the shell reloads the page; a page that keeps killing its process
//! would reload forever, so after three reloads in one minute the shell gives up and shows the
//! startup-error window instead.

use std::collections::VecDeque;

/// Reloads allowed inside [`WINDOW_MS`].
pub const MAX_RELOADS: usize = 3;
/// The sliding window the reloads are counted in.
pub const WINDOW_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashAction {
    Reload,
    GiveUp,
    /// The app is quitting, or never finished starting: a reload would remount a page that writes
    /// while the quit sequence runs, and an error window would show during a sign-out.
    LeaveAlone,
}

#[derive(Debug, Default)]
pub struct ReloadBudget {
    reloads_ms: VecDeque<u64>,
}

impl ReloadBudget {
    /// The process died at `now_ms`. Left alone while `quitting`; otherwise reload while fewer
    /// than [`MAX_RELOADS`] happened in the last [`WINDOW_MS`], else give up. Giving up spends
    /// nothing, so a page that stays healthy for a minute afterwards earns its reloads back.
    pub fn on_crash(&mut self, now_ms: u64, quitting: bool) -> CrashAction {
        if quitting {
            return CrashAction::LeaveAlone;
        }
        while self
            .reloads_ms
            .front()
            .is_some_and(|at| now_ms.saturating_sub(*at) >= WINDOW_MS)
        {
            self.reloads_ms.pop_front();
        }
        if self.reloads_ms.len() >= MAX_RELOADS {
            return CrashAction::GiveUp;
        }
        self.reloads_ms.push_back(now_ms);
        CrashAction::Reload
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fourth_crash_inside_a_minute_gives_up() {
        let mut budget = ReloadBudget::default();
        let actions: Vec<_> = [0, 10_000, 20_000, 30_000]
            .map(|at| budget.on_crash(at, false))
            .into();
        assert_eq!(
            actions,
            [
                CrashAction::Reload,
                CrashAction::Reload,
                CrashAction::Reload,
                CrashAction::GiveUp
            ]
        );
    }

    #[test]
    fn a_reload_older_than_a_minute_no_longer_counts() {
        let mut budget = ReloadBudget::default();
        for at in [0, 10_000, 20_000] {
            budget.on_crash(at, false);
        }
        assert_eq!(budget.on_crash(59_999, false), CrashAction::GiveUp);
        assert_eq!(budget.on_crash(60_000, false), CrashAction::Reload);
    }

    #[test]
    fn a_crash_while_quitting_is_left_alone_and_spends_nothing() {
        let mut budget = ReloadBudget::default();
        for at in [0, 1_000, 2_000, 3_000] {
            assert_eq!(budget.on_crash(at, true), CrashAction::LeaveAlone);
        }
        assert_eq!(budget.on_crash(4_000, false), CrashAction::Reload);
    }
}
