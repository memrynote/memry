//! The open vault's notices (Step 14l, #3531): `memry_desktop::vault::notices`, opened and
//! closed with the vault. [`crate::events::VaultNoticesChangedEvent`] tells the windows of each
//! change; a window reads the list here, so one that mounts after the open still shows it.

use std::sync::Arc;

use memry_desktop::vault::notices::{VaultNoticeList, VaultNotices};
use tauri::{AppHandle, Manager, Wry};

use super::error::CommandError;

/// The open vault's notices and the open they belong to; none while no vault is open or when
/// the launch started no vault tier.
#[tauri::command]
#[specta::specta]
pub fn vault_notices_list(app: AppHandle<Wry>) -> Result<VaultNoticeList, CommandError> {
    Ok(app
        .try_state::<Arc<VaultNotices>>()
        .map(|notices| notices.read())
        .unwrap_or_default())
}
