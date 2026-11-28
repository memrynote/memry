//! The device linking commands and events.

macro_rules! linking {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::linking::sync_approve_linking,
            crate::commands::linking::sync_complete_linking_qr,
            crate::commands::linking::sync_finalize_vault_choice,
            crate::commands::linking::sync_generate_linking_qr,
            crate::commands::linking::sync_get_linking_sas,
            crate::commands::linking::sync_link_via_qr,
            crate::commands::linking::sync_pick_vault_folder,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::SyncLinkingApprovedEvent,
            crate::events::SyncLinkingFinalizedEvent,
            crate::events::SyncLinkingRequestedEvent,
        ] $($chain)*)
    };
}
