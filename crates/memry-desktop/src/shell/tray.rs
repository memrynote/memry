//! When closing the main window hides it to the tray (`shouldHideOnClose`,
//! `apps/desktop/src/main/tray.ts`).

/// Never intercept a close without a live tray: hiding a window that nothing can bring back
/// leaves a running app the user can neither see nor quit.
pub fn should_hide_on_close(enabled: bool, tray_active: bool, quitting: bool) -> bool {
    enabled && tray_active && !quitting
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_close_hides_only_with_the_setting_a_live_tray_and_no_quit_under_way() {
        assert!(should_hide_on_close(true, true, false));
        assert!(!should_hide_on_close(false, true, false));
        assert!(!should_hide_on_close(true, false, false));
        assert!(!should_hide_on_close(true, true, true));
    }
}
