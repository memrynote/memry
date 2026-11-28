//! The settings commands and events.

macro_rules! settings {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::settings::app_set_zoom_factor,
            crate::commands::settings::settings_get_ai,
            crate::commands::settings::settings_get_calendar_provider,
            crate::commands::settings::settings_get_group,
            crate::commands::settings::settings_get_local,
            crate::commands::settings::settings_get_path,
            crate::commands::settings::settings_reset_keyboard,
            crate::commands::settings::settings_set_ai::<Wry>,
            crate::commands::settings::settings_set_calendar_provider,
            crate::commands::settings::settings_set_group,
            crate::commands::settings::settings_set_local,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::SettingsChangedEvent,
            crate::events::SettingsOpenSectionEvent,
        ] $($chain)*)
    };
}
