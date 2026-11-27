//! The calendar domain's commands and event, kept out of `registry.rs` to stay under the line
//! ceiling. `collect_commands_with_calendar!([...])` is `with_task_commands!(collect_commands![...])`
//! with the calendar commands appended, and `collect_events_with_calendar!` does the same for
//! `with_task_events!(collect_events![...])`; the task macros (`registry/tasks.rs`) append theirs.

macro_rules! collect_commands_with_calendar {
    ([$($commands:tt)*]) => {
        with_task_commands!(collect_commands![
            $($commands)*
            crate::commands::calendar::calendar_create_event::<::tauri::Wry>,
            crate::commands::calendar::calendar_delete_event::<::tauri::Wry>,
            crate::commands::calendar::calendar_get_event::<::tauri::Wry>,
            crate::commands::calendar::calendar_get_external_event::<::tauri::Wry>,
            crate::commands::calendar::calendar_get_range::<::tauri::Wry>,
            crate::commands::calendar::calendar_list_linked_notes::<::tauri::Wry>,
            crate::commands::calendar::calendar_list_sources::<::tauri::Wry>,
            crate::commands::calendar::calendar_promote_external_event::<::tauri::Wry>,
            crate::commands::calendar::calendar_search_events::<::tauri::Wry>,
            crate::commands::calendar::calendar_update_event::<::tauri::Wry>,
            crate::commands::calendar::calendar_update_source_selection::<::tauri::Wry>,
        ])
    };
}

macro_rules! collect_events_with_calendar {
    ([$($events:tt)*]) => {
        with_task_events!(collect_events![
            $($events)*
            crate::events::CalendarChangedEvent,
        ])
    };
}

pub(super) use {collect_commands_with_calendar, collect_events_with_calendar};
