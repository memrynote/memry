//! The project commands and events, appended to the task domain's lists by `registry/tasks.rs`:
//! `with_project_commands!(collect_commands![...])` hands `collect_commands!` the list with
//! these appended, and `with_project_events!` does the same for `collect_events!`. Each hands
//! its list on to `registry/bookmarks.rs`, which appends the bookmark and recents ones.

macro_rules! with_project_commands {
    ($collect:ident![$($commands:tt)*]) => {
        with_bookmark_commands!($collect![
            $($commands)*
            crate::commands::task_projects::tasks_project_archive::<Wry>,
            crate::commands::task_projects::tasks_project_create::<Wry>,
            crate::commands::task_projects::tasks_project_delete::<Wry>,
            crate::commands::task_projects::tasks_project_get::<Wry>,
            crate::commands::task_projects::tasks_project_link_item::<Wry>,
            crate::commands::task_projects::tasks_project_list::<Wry>,
            crate::commands::task_projects::tasks_project_list_contents::<Wry>,
            crate::commands::task_projects::tasks_project_list_for_item::<Wry>,
            crate::commands::task_projects::tasks_project_list_links::<Wry>,
            crate::commands::task_projects::tasks_project_reorder::<Wry>,
            crate::commands::task_projects::tasks_project_set_home_note::<Wry>,
            crate::commands::task_projects::tasks_project_set_link_pinned::<Wry>,
            crate::commands::task_projects::tasks_project_unlink_item::<Wry>,
            crate::commands::task_projects::tasks_project_update::<Wry>,
        ])
    };
}

macro_rules! with_project_events {
    ($collect:ident![$($events:tt)*]) => {
        with_bookmark_events!($collect![
            $($events)*
            crate::events::ProjectCreatedEvent,
            crate::events::ProjectDeletedEvent,
            crate::events::ProjectUpdatedEvent,
        ])
    };
}
