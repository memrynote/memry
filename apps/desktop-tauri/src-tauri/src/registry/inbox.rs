//! The inbox commands and events.

macro_rules! inbox {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::settings::settings_send_test_inbox_review_notification,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::InboxMetadataCompleteEvent,
            crate::events::InboxOpenItemEvent,
            crate::events::InboxProcessingErrorEvent,
            crate::events::InboxReviewDueEvent,
            crate::events::InboxReviewOpenEvent,
            crate::events::InboxSnoozeDueEvent,
            crate::events::InboxUpdatedEvent,
        ] $($chain)*)
    };
}
