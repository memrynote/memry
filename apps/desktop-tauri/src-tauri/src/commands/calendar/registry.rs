//! The calendar domain's commands and event for `registry.rs`, kept out of it (and its module
//! list) to stay under the line ceiling. `collect_commands_with_calendar!([...])` is
//! `with_inbox_commands!(collect_commands![...])` with the calendar commands appended, and
//! `collect_events_with_calendar!` does the same for `with_inbox_events!(collect_events![...])`;
//! the inbox macro (`registry/inbox.rs`) hands the list on down the domain chain.

macro_rules! collect_commands_with_calendar {
    ([$($commands:tt)*]) => {
        with_inbox_commands!(collect_commands![
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
        with_inbox_events!(collect_events![
            $($events)*
            crate::events::CalendarChangedEvent,
        ])
    };
}

pub(crate) use {collect_commands_with_calendar, collect_events_with_calendar};
