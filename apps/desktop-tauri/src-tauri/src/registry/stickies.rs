//! The sticky note and edge tab commands and events, appended to the task domain's lists by
//! `registry/reminders.rs`: `with_sticky_commands!(collect_commands![...])` hands
//! `collect_commands!` the list with these appended, and `with_sticky_events!` does the same
//! for `collect_events!`. The command list goes on to `registry/graph.rs`, which appends the
//! graph ones.

macro_rules! with_sticky_commands {
    ($collect:ident![$($commands:tt)*]) => {
        graph::with_graph_commands!($collect![
            $($commands)*
            crate::commands::stickies::sticky_delete_draft,
            crate::commands::stickies::sticky_get_session,
            crate::commands::stickies::sticky_list_drafts,
            crate::commands::stickies::sticky_peek,
            crate::commands::stickies::sticky_resize,
            crate::commands::stickies::sticky_save_draft,
            crate::commands::stickies::sticky_tuck,
            crate::commands::stickies::sticky_unfold,
        ])
    };
}

macro_rules! with_sticky_events {
    ($collect:ident![$($events:tt)*]) => {
        $collect![
            $($events)*
            crate::events::StickyDraftsChangedEvent,
        ]
    };
}
