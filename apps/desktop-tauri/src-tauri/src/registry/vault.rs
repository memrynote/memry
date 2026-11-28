//! The vault, vault activity, index, file, lock and notice commands and events.

macro_rules! vault {
    (commands $($chain:tt)*) => {
        chain!(commands [
            crate::commands::vault::vault_close,
            crate::commands::vault::vault_create,
            crate::commands::vault::vault_get_config::<Wry>,
            crate::commands::vault::vault_get_default_parent,
            crate::commands::vault::vault_get_status,
            crate::commands::vault::vault_list,
            crate::commands::vault::vault_remove,
            crate::commands::vault::vault_reveal,
            crate::commands::vault::vault_select,
            crate::commands::vault::vault_set_default,
            crate::commands::vault::vault_set_icon,
            crate::commands::vault::vault_switch,
            crate::commands::vault::vault_update_config::<Wry>,
            crate::commands::vault_account::vault_delete_from_account,
            crate::commands::vault_account::vault_download_remote,
            crate::commands::vault_account::vault_list_account,
            // vault activity
            crate::commands::vault_activity::vault_activity_clear,
            crate::commands::vault_activity::vault_activity_list,
            crate::commands::vault_activity::vault_activity_reveal,
            crate::commands::vault_activity::vault_activity_set_retention,
            // vault index
            crate::commands::vault_index::vault_reindex::<Wry>,
            // vault files
            crate::commands::vault_files::vault_resolve_embeds,
            // vault locks
            crate::commands::vault_locks::vault_locks_list::<Wry>,
            crate::commands::vault_locks::vault_locks_set::<Wry>,
            // vault notices
            crate::commands::vault_notices::vault_notices_delete_kept,
            crate::commands::vault_notices::vault_notices_list,
            crate::commands::vault_notices::vault_notices_restore_kept,
        ] $($chain)*)
    };
    (events $($chain:tt)*) => {
        chain!(events [
            crate::events::VaultActivityChangedEvent,
            crate::events::VaultConfigChangedEvent,
            crate::events::VaultErrorEvent,
            crate::events::VaultIndexProgressEvent,
            crate::events::VaultIndexRecoveredEvent,
            crate::events::VaultListChangedEvent,
            crate::events::VaultNoticesChangedEvent,
            crate::events::VaultStatusChangedEvent,
            // vault locks
            crate::events::VaultLocksChangedEvent,
            crate::events::VaultLocksExternalEditRestoredEvent,
        ] $($chain)*)
    };
}
