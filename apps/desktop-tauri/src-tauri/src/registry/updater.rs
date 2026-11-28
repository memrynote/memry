//! The updater commands and event.

macro_rules! updater {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::updater::updater_check_for_updates,
            crate::commands::updater::updater_download_update,
            crate::commands::updater::updater_get_state,
            crate::commands::updater::updater_quit_and_install,
            crate::commands::updater::updater_set_auto_check,
            crate::commands::updater::updater_set_auto_download,
            crate::commands::updater::updater_skip_version,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::UpdaterStateChangedEvent,
        ] $($chain)*)
    };
}
