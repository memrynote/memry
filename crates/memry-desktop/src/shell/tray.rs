//! When closing the main window hides it to the tray (`shouldHideOnClose`,
//! `apps/desktop/src/main/tray.ts`).

/// Never intercept a close without a live tray: hiding a window that nothing can bring back
/// leaves a running app the user can neither see nor quit. `host_registered` says whether
/// something is there to show the tray icon (on Linux a StatusNotifier host; see
/// `tray_host`). It is asked last, and only when everything else says to hide, because it can
/// cost a bus round trip.
pub fn should_hide_on_close(
    enabled: bool,
    tray_active: bool,
    quitting: bool,
    host_registered: impl FnOnce() -> bool,
) -> bool {
    enabled && tray_active && !quitting && host_registered()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_hides_only_with_the_setting_a_live_tray_and_no_quit_under_way() {
        assert!(should_hide_on_close(true, true, false, || true));
        assert!(!should_hide_on_close(false, true, false, || true));
        assert!(!should_hide_on_close(true, false, false, || true));
        assert!(!should_hide_on_close(true, true, true, || true));
    }

    #[test]
    fn a_tray_nothing_shows_never_hides_the_window() {
        // The icon was created but no host draws it: the window would have no way back.
        assert!(!should_hide_on_close(true, true, false, || false));
    }

    #[test]
    fn the_host_is_asked_only_when_everything_else_says_to_hide() {
        let asked = std::cell::Cell::new(0);
        let host = || {
            asked.set(asked.get() + 1);
            true
        };
        assert!(!should_hide_on_close(false, true, false, host));
        assert!(!should_hide_on_close(true, false, false, host));
        assert!(!should_hide_on_close(true, true, true, host));
        assert_eq!(asked.get(), 0);
        assert!(should_hide_on_close(true, true, false, host));
        assert_eq!(asked.get(), 1);
    }
}
