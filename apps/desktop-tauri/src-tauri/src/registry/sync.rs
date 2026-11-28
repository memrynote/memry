//! The sync commands and events.

macro_rules! sync {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::sync::sync_get_history::<Wry>,
            crate::commands::sync::sync_get_large_notes::<Wry>,
            crate::commands::sync::sync_get_note_sync_state::<Wry>,
            crate::commands::sync::sync_get_quarantined_items::<Wry>,
            crate::commands::sync::sync_get_queue_size::<Wry>,
            crate::commands::sync::sync_get_status::<Wry>,
            crate::commands::sync::sync_get_synced_settings::<Wry>,
            crate::commands::sync::sync_get_unsent_notes::<Wry>,
            crate::commands::sync::sync_pause::<Wry>,
            crate::commands::sync::sync_resume::<Wry>,
            crate::commands::sync::sync_trigger::<Wry>,
            crate::commands::sync::sync_update_synced_setting::<Wry>,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::SyncCertificatePinFailedEvent,
            crate::events::SyncClockSkewWarningEvent,
            crate::events::SyncInitialSyncProgressEvent,
            crate::events::SyncItemCorruptEvent,
            crate::events::SyncItemRecoveredEvent,
            crate::events::SyncItemSyncedEvent,
            crate::events::SyncQueueClearedEvent,
            crate::events::SyncSecurityWarningEvent,
            crate::events::SyncStatusChangedEvent,
        ] $($chain)*)
    };
}
