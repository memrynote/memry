//! Shell services over Tauri that no single domain owns: native dialogs, the clipboard, and the
//! boot and recovery glue of the vault session.

pub mod account_sync;
pub mod billing;
pub mod capture;
pub mod clipboard;
pub mod dialogs;
pub mod drop_stage;
pub mod external;
pub mod folder_sync;
pub mod journal_events;
pub mod lock_events;
pub mod loopback;
pub mod navigation_guard;
pub mod note_events;
pub mod permissions;
pub mod readwise;
pub mod services;
pub mod vault_boot;
