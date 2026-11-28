//! The CRDT editor commands and events.

macro_rules! editor {
    (commands $($chain:tt)*) => {
        chain!(commands [
            // crdt (`crdt_open_doc`, `crdt_apply_update` and the sync steps are binary commands)
            crate::commands::editor::crdt_close_doc::<Wry>,
            crate::commands::editor::crdt_get_health::<Wry>,
            crate::commands::editor::crdt_typing_sent::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::CrdtProviderReadyEvent,
            crate::events::CrdtProviderResetEvent,
            crate::events::CrdtWriteBackFailedEvent,
        ] $($chain)*)
    };
}
