//! The sync account commands and events.

macro_rules! sync_account {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::sync_account::account_sign_out::<Wry>,
            crate::commands::sync_account::sync_get_vault_binding,
            crate::commands::sync_account::sync_logout::<Wry>,
            crate::commands::sync_account::sync_repair_device_keys,
            crate::commands::sync_account::sync_resolve_vault_binding,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::SyncDeviceRemovedEvent,
            crate::events::SyncVaultBindingChangedEvent,
        ] $($chain)*)
    };
}
