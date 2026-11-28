//! The window commands and events.

macro_rules! window {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::shell::window_close,
            crate::commands::shell::window_minimize,
            crate::commands::shell::window_set_caption_rects,
            crate::commands::shell::window_toggle_maximize,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::WindowCaptionHoverChangedEvent,
            crate::events::WindowCaptionPressedChangedEvent,
            crate::events::WindowChromeStateChangedEvent,
        ] $($chain)*)
    };
}
