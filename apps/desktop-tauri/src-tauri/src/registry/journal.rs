//! The journal commands and events.

macro_rules! journal {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::journal::journal_create_entry::<Wry>,
            crate::commands::journal::journal_cross_into_notes::<Wry>,
            crate::commands::journal::journal_delete_entry::<Wry>,
            crate::commands::journal::journal_get_day_context::<Wry>,
            crate::commands::journal::journal_get_entry::<Wry>,
            crate::commands::journal::journal_get_heatmap::<Wry>,
            crate::commands::journal::journal_get_month_entries::<Wry>,
            crate::commands::journal::journal_get_property_rows::<Wry>,
            crate::commands::journal::journal_get_same_day_entries::<Wry>,
            crate::commands::journal::journal_get_streak::<Wry>,
            crate::commands::journal::journal_get_year_stats::<Wry>,
            crate::commands::journal::journal_update_entry::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::JournalEntryCreatedEvent,
            crate::events::JournalEntryDeletedEvent,
            crate::events::JournalEntryUpdatedEvent,
            crate::events::JournalEventsDroppedEvent,
            crate::events::JournalExternalChangeEvent,
        ] $($chain)*)
    };
}
