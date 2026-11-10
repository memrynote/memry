//! The open vault's notices (Step 14l, #3531): `memry_desktop::vault::notices`, opened and
//! closed with the vault. [`crate::events::VaultNoticesChangedEvent`] tells the windows of each
//! change; a window reads the list here, so one that mounts after the open still shows it.
//! A note kept after its file was deleted outside the app (the `keptRemovals` notice, #4140) is
//! restored or deleted through `memry_desktop::notes::kept`.

use std::sync::Arc;

use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::kept;
use memry_desktop::vault::notices::{VaultNoticeList, VaultNotices};
use tauri::{AppHandle, Manager, Wry};

use super::blocking;
use super::error::CommandError;
use super::notes::{failed, open_vault, service, track};

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

/// Writes a kept note's file back from its document. Refused with a file at its path or a body
/// that is not here (the note stays kept).
#[tauri::command]
#[specta::specta]
pub async fn vault_notices_restore_kept(
    app: AppHandle<Wry>,
    note_id: String,
) -> Result<(), CommandError> {
    blocking("vault_notices_restore_kept", move || {
        let (open, notes, notices) = (open_vault(&app)?, service(&app)?, notices(&app)?);
        kept::restore(&notes, &notices, &open, &note_id).map_err(|error| failed(&error))
    })
    .await
}

/// Deletes a kept note, its text to the OS trash first. Where that copy cannot be made it fails
/// with `note_trash_unavailable`, and the renderer asks before it deletes with `permanent`
/// (#3813).
#[tauri::command]
#[specta::specta]
pub async fn vault_notices_delete_kept(
    app: AppHandle<Wry>,
    note_id: String,
    permanent: Option<bool>,
) -> Result<(), CommandError> {
    blocking("vault_notices_delete_kept", move || {
        let (open, notes, notices) = (open_vault(&app)?, service(&app)?, notices(&app)?);
        kept::delete(
            &notes,
            &notices,
            &open,
            &note_id,
            permanent.unwrap_or(false),
        )
        .map_err(|error| failed(&error))?;
        track(&app, "note_deleted", "deleted");
        Ok(())
    })
    .await
}

fn notices(app: &AppHandle<Wry>) -> Result<Arc<VaultNotices>, CommandError> {
    app.try_state::<Arc<VaultNotices>>()
        .map(|notices| notices.inner().clone())
        .ok_or_else(|| failed(&NotesError::Closed))
}
