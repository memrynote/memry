//! Shell services over Tauri that no single domain owns: native dialogs, the clipboard, and the
//! boot and recovery glue of the vault session.

pub mod clipboard;
pub mod dialogs;
pub mod drop_stage;
pub mod external;
pub mod loopback;
pub mod navigation_guard;
pub mod permissions;
pub mod services;
pub mod vault_boot;
