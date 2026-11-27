//! The inbox commands and events, kept out of `registry.rs`'s single list by a callback:
//! `with_inbox_commands!(collect_commands![...])` hands its list, with these appended, on to
//! `registry/tasks.rs`, and `with_inbox_events!` does the same for the events.

macro_rules! with_inbox_commands {
    ($collect:ident![$($commands:tt)*]) => {
        with_task_commands!($collect![
            $($commands)*
            crate::commands::settings::settings_send_test_inbox_review_notification,
        ])
    };
}

macro_rules! with_inbox_events {
    ($collect:ident![$($events:tt)*]) => {
        with_task_events!($collect![
            $($events)*
            crate::events::InboxMetadataCompleteEvent,
            crate::events::InboxOpenItemEvent,
            crate::events::InboxProcessingErrorEvent,
            crate::events::InboxReviewDueEvent,
            crate::events::InboxReviewOpenEvent,
            crate::events::InboxUpdatedEvent,
        ])
    };
}
