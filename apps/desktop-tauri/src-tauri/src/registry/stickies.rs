//! The sticky note and edge tab commands and events.

macro_rules! stickies {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::stickies::sticky_delete_draft,
            crate::commands::stickies::sticky_get_session,
            crate::commands::stickies::sticky_list_drafts,
            crate::commands::stickies::sticky_peek,
            crate::commands::stickies::sticky_resize,
            crate::commands::stickies::sticky_save_draft,
            crate::commands::stickies::sticky_tuck,
            crate::commands::stickies::sticky_unfold,
            crate::commands::sticky_send::sticky_open_target,
            crate::commands::sticky_send::sticky_send,
            crate::commands::sticky_send::sticky_undo_send,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::StickyDraftsChangedEvent,
            crate::events::StickyOpenTargetRequestedEvent,
        ] $($chain)*)
    };
}
