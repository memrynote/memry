//! The Inbox events, appended to the reminder events by `registry/reminders.rs`:
//! `with_inbox_events!(collect_events![...])` hands `collect_events!` the list with these
//! appended.

macro_rules! with_inbox_events {
    ($collect:ident![$($events:tt)*]) => {
        $collect![
            $($events)*
            crate::events::InboxMetadataCompleteEvent,
            crate::events::InboxOpenItemEvent,
            crate::events::InboxProcessingErrorEvent,
            crate::events::InboxUpdatedEvent,
        ]
    };
}
