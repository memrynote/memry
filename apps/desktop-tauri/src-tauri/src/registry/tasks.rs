//! The task domain's commands and events, kept out of `registry.rs`'s single list by a
//! callback: `with_task_commands!(collect_commands![...])` hands `collect_commands!` the list
//! with these appended, and `with_task_events!` does the same for `collect_events!`. Each hands
//! its list on to `registry/projects.rs`, which appends the project ones.

macro_rules! with_task_commands {
    ($collect:ident![$($commands:tt)*]) => {
        with_project_commands!($collect![
            $($commands)*
            crate::commands::task_writes::tasks_archive::<Wry>,
            crate::commands::task_writes::tasks_bulk_archive::<Wry>,
            crate::commands::task_writes::tasks_bulk_complete::<Wry>,
            crate::commands::task_writes::tasks_bulk_delete::<Wry>,
            crate::commands::task_writes::tasks_bulk_move::<Wry>,
            crate::commands::task_writes::tasks_complete::<Wry>,
            crate::commands::task_writes::tasks_convert_to_subtask::<Wry>,
            crate::commands::task_writes::tasks_convert_to_task::<Wry>,
            crate::commands::task_writes::tasks_create::<Wry>,
            crate::commands::task_writes::tasks_delete::<Wry>,
            crate::commands::task_writes::tasks_duplicate::<Wry>,
            crate::commands::tasks::tasks_get::<Wry>,
            crate::commands::task_writes::tasks_get_activity::<Wry>,
            crate::commands::tasks::tasks_get_linked_tasks::<Wry>,
            crate::commands::tasks::tasks_get_overdue::<Wry>,
            crate::commands::tasks::tasks_get_stats::<Wry>,
            crate::commands::tasks::tasks_get_subtasks::<Wry>,
            crate::commands::tasks::tasks_get_tags::<Wry>,
            crate::commands::tasks::tasks_get_today::<Wry>,
            crate::commands::tasks::tasks_get_upcoming::<Wry>,
            crate::commands::tasks::tasks_list::<Wry>,
            crate::commands::task_writes::tasks_move::<Wry>,
            crate::commands::task_writes::tasks_reorder::<Wry>,
            crate::commands::tasks::tasks_status_create::<Wry>,
            crate::commands::tasks::tasks_status_delete::<Wry>,
            crate::commands::tasks::tasks_status_list::<Wry>,
            crate::commands::tasks::tasks_status_reorder::<Wry>,
            crate::commands::tasks::tasks_status_update::<Wry>,
            crate::commands::task_writes::tasks_unarchive::<Wry>,
            crate::commands::task_writes::tasks_uncomplete::<Wry>,
            crate::commands::tasks::tasks_update::<Wry>,
        ])
    };
}

macro_rules! with_task_events {
    ($collect:ident![$($events:tt)*]) => {
        with_project_events!($collect![
            $($events)*
            crate::events::TaskActivityCreatedEvent,
            crate::events::TaskCompletedEvent,
            crate::events::TaskCreatedEvent,
            crate::events::TaskDeletedEvent,
            crate::events::TaskMovedEvent,
            crate::events::TaskUpdatedEvent,
        ])
    };
}
