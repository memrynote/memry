//! The calendar domain's commands, kept out of `registry.rs` to stay under the line ceiling.

/// `with_task_commands!(collect_commands![...])` over `before`, the calendar commands, then
/// `after`; the task macro (`registry/tasks.rs`) appends its commands. `Builder::commands` takes
/// one `Commands`, so the registry cannot assemble the list from several calls; this splices the
/// calendar paths into the middle of the single call to keep the list in domain order.
macro_rules! collect_commands_with_calendar {
    ([$($before:tt)*] [$($after:tt)*]) => {
        with_task_commands!(collect_commands![
            $($before)*
            // calendar
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
            $($after)*
        ])
    };
}

pub(super) use collect_commands_with_calendar;
