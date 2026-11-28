//! The project commands and events.

macro_rules! projects {
    (commands $($chain:tt)*) => {
        chain!(commands [
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
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::ProjectCreatedEvent,
            crate::events::ProjectDeletedEvent,
            crate::events::ProjectUpdatedEvent,
        ] $($chain)*)
    };
}
