//! The reminder commands and events, appended to the task domain's lists by
//! `registry/bookmarks.rs`: `with_reminder_commands!(collect_commands![...])` hands
//! `collect_commands!` the list with these appended, and `with_reminder_events!` does the same
//! for `collect_events!`.

macro_rules! with_reminder_commands {
    ($collect:ident![$($commands:tt)*]) => {
        $collect![
            $($commands)*
            crate::commands::reminders::reminder_bulk_dismiss,
            crate::commands::reminders::reminder_count_pending,
            crate::commands::reminders::reminder_create,
            crate::commands::reminders::reminder_delete,
            crate::commands::reminders::reminder_dismiss,
            crate::commands::reminders::reminder_get,
            crate::commands::reminders::reminder_get_due,
            crate::commands::reminders::reminder_get_for_target,
            crate::commands::reminders::reminder_get_upcoming,
            crate::commands::reminders::reminder_list,
            crate::commands::reminders::reminder_snooze,
            crate::commands::reminders::reminder_update,
        ]
    };
}

macro_rules! with_reminder_events {
    ($collect:ident![$($events:tt)*]) => {
        $collect![
            $($events)*
            crate::events::ReminderClickedEvent,
            crate::events::ReminderCreatedEvent,
            crate::events::ReminderDeletedEvent,
            crate::events::ReminderDismissedEvent,
            crate::events::ReminderDueEvent,
            crate::events::ReminderSnoozedEvent,
            crate::events::ReminderUpdatedEvent,
        ]
    };
}
