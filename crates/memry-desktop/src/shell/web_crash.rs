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
}

#[derive(Debug, Default)]
pub struct ReloadBudget {
    reloads_ms: VecDeque<u64>,
}

impl ReloadBudget {
    pub const fn new() -> Self {
        Self {
            reloads_ms: VecDeque::new(),
        }
    }

    /// The process died at `now_ms`: reload while fewer than [`MAX_RELOADS`] happened in the
    /// last [`WINDOW_MS`], else give up. Giving up spends nothing, so a page that stays healthy
    /// for a minute afterwards earns its reloads back.
    pub fn on_crash(&mut self, now_ms: u64) -> CrashAction {
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
            .map(|at| budget.on_crash(at))
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
            budget.on_crash(at);
        }
        assert_eq!(budget.on_crash(59_999), CrashAction::GiveUp);
        assert_eq!(budget.on_crash(60_000), CrashAction::Reload);
    }
}
