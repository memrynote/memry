//! The calendar commands and event. `calendar_sources` (EventKit, feeds and providers) sits
//! apart from `calendar` in the chain because its commands reach the bindings earlier.

macro_rules! calendar_sources {
    (commands $($chain:tt)*) => {
        chain!(commands [
            // calendar macOS (EventKit)
            crate::commands::calendar_eventkit::calendar_eventkit_request_access,
            // calendar feeds
            crate::commands::calendar_ics::calendar_refresh_ics,
            crate::commands::calendar_ics::calendar_subscribe_ics,
            crate::commands::calendar_ics::calendar_unsubscribe_ics,
            // calendar providers
            crate::commands::calendar_providers::calendar_check_provider_writer_compat,
            crate::commands::calendar_providers::calendar_connect_provider,
            crate::commands::calendar_providers::calendar_disconnect_provider,
            crate::commands::calendar_providers::calendar_discover_provider_calendars,
            crate::commands::calendar_providers::calendar_refresh_provider,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [] $($chain)*)
    };
}

macro_rules! calendar {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::calendar::calendar_create_event::<Wry>,
            crate::commands::calendar::calendar_delete_event::<Wry>,
            crate::commands::calendar::calendar_get_event::<Wry>,
            crate::commands::calendar::calendar_get_external_event::<Wry>,
            crate::commands::calendar::calendar_get_range::<Wry>,
            crate::commands::calendar::calendar_list_linked_notes::<Wry>,
            crate::commands::calendar::calendar_list_sources::<Wry>,
            crate::commands::calendar::calendar_promote_external_event::<Wry>,
            crate::commands::calendar::calendar_search_events::<Wry>,
            crate::commands::calendar::calendar_update_event::<Wry>,
            crate::commands::calendar::calendar_update_source_selection::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::CalendarChangedEvent,
        ] $($chain)*)
    };
}
