//! The cover and attachment pickers' sources besides an upload (#3531 14f-2b), through
//! `memry_desktop::attachments`: `notes:list-vault-attachments`, `notes:insert-existing-attachment`
//! and `notes:download-attachment-from-url` of `ipc/notes-handlers.ts`. The first two reject as
//! Electron's handlers do; a URL download answers why it saved nothing, as Electron's does.

use std::sync::Arc;

use memry_desktop::attachments::{
    self, InsertedAttachment, RemoteFailure, RemoteImages, VaultAttachmentEntry,
};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::attachments::attachment_error;
use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::open_vault;
use crate::startup::{self, Stage};

pub fn register_stages() {
    startup::register(Stage::Handlers, "manage remote images", manage);
}

fn manage(app: &AppHandle<Wry>) -> Result<(), CommandError> {
    let remote = RemoteImages::new(memry_desktop::http::builder()).map_err(|error| {
        CommandError::new(
            ErrorKind::Internal,
            "remote_images_client",
            format!("the linked-image HTTP client could not be built: {error}"),
        )
    })?;
    app.manage(Arc::new(remote));
    Ok(())
}

/// Every attachment the vault stores, newest first, for the pickers.
#[tauri::command]
#[specta::specta]
pub async fn notes_list_vault_attachments<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<VaultAttachmentEntry>, CommandError> {
    blocking("notes_list_vault_attachments", move || {
        attachments::list_vault(&open_vault(&app)?)
            .map_err(|error| attachment_error(&app, "notes_list_vault_attachments", &error))
    })
    .await
}

/// The block props for `note_id` to embed `filename` of `owner_note_id`'s attachments folder.
/// Nothing is copied.
#[tauri::command]
#[specta::specta]
pub async fn notes_insert_existing_attachment<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    owner_note_id: String,
    filename: String,
) -> Result<InsertedAttachment, CommandError> {
    blocking("notes_insert_existing_attachment", move || {
        attachments::insert_existing(&open_vault(&app)?, &note_id, &owner_note_id, &filename)
            .map_err(|error| attachment_error(&app, "notes_insert_existing_attachment", &error))
    })
    .await
}

/// What a URL download came to: `DownloadAttachmentFromUrlResult` without its `ok` flag.
#[derive(Debug, Serialize, specta::Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UrlDownload {
    Saved {
        // The note-relative ref, as an upload answers it.
        #[serde(rename = "ref")]
        reference: String,
    },
    Failed {
        reason: RemoteFailure,
    },
}

/// Copies the image at `url` into the note's attachments folder.
#[tauri::command]
#[specta::specta]
pub async fn notes_download_attachment_from_url<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    url: String,
) -> Result<UrlDownload, CommandError> {
    let remote = app
        .try_state::<Arc<RemoteImages>>()
        .map(|remote| Arc::clone(&remote))
        .ok_or_else(|| CommandError::new(ErrorKind::Internal, "remote_missing", "no client"))?;
    let fetched = match remote.fetch(&url).await {
        Ok(fetched) => fetched,
        Err(reason) => return Ok(UrlDownload::Failed { reason }),
    };
    blocking("notes_download_attachment_from_url", move || {
        let open = open_vault(&app)?;
        Ok(
            match attachments::save_fetched(&open, &note_id, &fetched.filename, &fetched.bytes) {
                Ok(saved) => UrlDownload::Saved {
                    reference: saved.path,
                },
                Err(error) => {
                    tracing::error!(
                        scope = "RemoteAttachment",
                        "a linked image could not be written to the vault: {error}"
                    );
                    UrlDownload::Failed {
                        reason: RemoteFailure::WriteFailed,
                    }
                }
            },
        )
    })
    .await
}
