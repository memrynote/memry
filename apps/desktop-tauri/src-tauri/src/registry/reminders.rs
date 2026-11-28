//! The reminder commands and events.

macro_rules! reminders {
    (commands $($chain:tt)*) => {
        chain!(commands [
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
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::ReminderClickedEvent,
            crate::events::ReminderCreatedEvent,
            crate::events::ReminderDeletedEvent,
            crate::events::ReminderDismissedEvent,
            crate::events::ReminderDueEvent,
            crate::events::ReminderSnoozedEvent,
            crate::events::ReminderUpdatedEvent,
        ] $($chain)*)
    };
}
