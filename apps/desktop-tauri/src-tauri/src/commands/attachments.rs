//! A note's attachments (`notes:upload-attachment` of `ipc/notes-handlers.ts`, #3531 14f),
//! through `memry_desktop::attachments`. `notes_upload_attachment` takes the file's bytes as the
//! raw request body with `{ noteId, fileName, size }` in the metadata header, so it is a binary
//! command (`binary.rs`). A file over `MAX_UPLOAD_BODY` (16 MiB) goes in parts instead:
//! `notes_upload_attachment_begin`, then `notes_upload_attachment_chunk` (binary, meta
//! `{ id, offset }`) until the last part answers the saved file, or
//! `notes_upload_attachment_abort`. A page that reloads or closes ends its uploads
//! ([`release_page`]). A refused or failed upload rejects with the localized
//! `errors:attachment.*` message; the renderer's service answers it as Electron's
//! `{ success: false, error }`. `notes_attachment_rename` renames a block's file
//! (`notes:attachment-rename`) and rejects as Electron's handler does. `notes_delete_attachment`
//! moves a file to the OS trash unless another note names it (`notes:delete-attachment`). A
//! locked note refuses each of them with `note_locked`. `notes_list_attachments`,
//! `notes_attachment_resolve`, `notes_attachment_reveal_in_finder` and
//! `notes_attachment_open_external` only read, so a lock does not refuse them.

use std::sync::Arc;

use memry_desktop::attachments::{
    self, AttachmentError, AttachmentInfo, AttachmentLocation, DeletedAttachment,
    RenamedAttachment, SavedAttachment, Uploads,
};
use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::vault::consumer::VaultTier;
use memry_desktop::vault::trash::move_to_trash;
use serde::Deserialize;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Runtime, Webview, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::notes::open_vault;
use crate::binary;
use crate::shell::external;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadMeta {
    note_id: String,
    file_name: String,
    size: usize,
}

/// The command's answer to `error`; `command` names it in the log of a disk failure.
pub fn attachment_error<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    error: &AttachmentError,
) -> CommandError {
    let locale = app.state::<Arc<LocaleService>>().get();
    let t = |key: &str, args: &Args| i18n::t(locale, key, args);
    match error {
        AttachmentError::TooLarge { size, limit } => {
            let args = Args::from([
                ("size".to_owned(), Arg::Str(attachments::format_size(*size))),
                (
                    "limit".to_owned(),
                    Arg::Str(attachments::format_size(*limit)),
                ),
            ]);
            let message = t("errors:attachment.exceedsMaxSize", &args);
            CommandError::new(ErrorKind::Invalid, "attachment_too_large", message)
        }
        AttachmentError::UnsupportedType(_) => {
            let message = t("errors:attachment.unsupportedType", &Args::new());
            CommandError::new(ErrorKind::Invalid, "attachment_invalid_type", message)
        }
        AttachmentError::InvalidNote => {
            let message = t("errors:attachment.writeFailed", &Args::new());
            CommandError::new(ErrorKind::Invalid, "attachment_invalid_note", message)
        }
        AttachmentError::Storage(storage) => CommandError::from_core(storage),
        // Electron's English texts, which `ipc-error.ts` and the rename dialog show as they are.
        AttachmentError::Locked => {
            CommandError::new(ErrorKind::Locked, "note_locked", error.to_string())
        }
        AttachmentError::Excluded => {
            CommandError::new(ErrorKind::Locked, "note_excluded", error.to_string())
        }
        AttachmentError::NoteNotFound(_) | AttachmentError::FileNotFound => CommandError::new(
            ErrorKind::NotFound,
            "attachment_not_found",
            error.to_string(),
        ),
        AttachmentError::NotVaultRelative
        | AttachmentError::OutsideVault
        | AttachmentError::NotOwned
        | AttachmentError::BadName
        | AttachmentError::NoFreeName
        | AttachmentError::BadReference => CommandError::new(
            ErrorKind::Invalid,
            "attachment_invalid_path",
            error.to_string(),
        ),
        AttachmentError::UploadGone
        | AttachmentError::BadChunk
        | AttachmentError::TooManyUploads => {
            let message = t("errors:attachment.writeFailed", &Args::new());
            CommandError::new(ErrorKind::Invalid, "attachment_upload_refused", message)
        }
        AttachmentError::NotAFolder | AttachmentError::Io(_) | AttachmentError::Write(_) => {
            tracing::warn!(scope = "attachments", "{command} failed on disk: {error}");
            let message = t("errors:attachment.writeFailed", &Args::new());
            CommandError::new(ErrorKind::Storage, "attachment_write_failed", message)
        }
    }
}

/// Saves the file in the raw request body (`invokeBinary`, meta `{ noteId, fileName, size }`) to
/// the note's attachments folder. Listed in `binary::COMMANDS`; not a specta command.
#[tauri::command]
pub async fn notes_upload_attachment<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<SavedAttachment, CommandError> {
    let meta: UploadMeta = binary::meta(&request)?;
    let body = binary::raw_body(&request)?;
    // On the declared size, so a file over the limit never crosses IPC.
    if let Err(error) = attachments::check_upload_size(meta.size, body.len()) {
        let error = attachment_error(&app, "notes_upload_attachment", &error);
        log_failure("notes_upload_attachment", &error);
        return Err(error);
    }
    let body = body.to_vec();
    blocking("notes_upload_attachment", move || {
        attachments::upload(&open_vault(&app)?, &meta.note_id, &meta.file_name, &body)
            .map_err(|error| attachment_error(&app, "notes_upload_attachment", &error))
    })
    .await
}

/// The uploads `vault_boot` manages with the session.
fn uploads<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<Uploads>, CommandError> {
    app.try_state::<Arc<Uploads>>()
        .map(|uploads| uploads.inner().clone())
        .ok_or_else(|| CommandError::new(ErrorKind::Internal, "uploads_missing", "no uploads"))
}

/// Starts a chunked upload of a file of `size` bytes to the note, for the calling page. Refused
/// on the size, the type or the note id before any byte is sent. Returns the upload's id.
#[tauri::command]
#[specta::specta]
pub async fn notes_upload_attachment_begin<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    note_id: String,
    file_name: String,
    size: u64,
) -> Result<String, CommandError> {
    let owner = webview.label().to_owned();
    blocking("notes_upload_attachment_begin", move || {
        uploads(&app)?
            .begin(&open_vault(&app)?, &owner, &note_id, &file_name, size)
            .map_err(|error| attachment_error(&app, "notes_upload_attachment_begin", &error))
    })
    .await
}

#[derive(Deserialize)]
struct ChunkMeta {
    id: String,
    offset: u64,
}

/// One part of a chunked upload: the raw request body, with `{ id, offset }` in the metadata
/// header. The last part answers the saved file, the others `null`. Listed in
/// `binary::COMMANDS`; not a specta command.
#[tauri::command]
pub async fn notes_upload_attachment_chunk<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<Option<SavedAttachment>, CommandError> {
    let meta: ChunkMeta = binary::meta(&request)?;
    let body = binary::raw_body(&request)?.to_vec();
    blocking("notes_upload_attachment_chunk", move || {
        uploads(&app)?
            .write_chunk(&open_vault(&app)?, &meta.id, meta.offset, &body)
            .map_err(|error| attachment_error(&app, "notes_upload_attachment_chunk", &error))
    })
    .await
}

/// Cancels a chunked upload; its part file is deleted.
#[tauri::command]
#[specta::specta]
pub async fn notes_upload_attachment_abort<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<(), CommandError> {
    blocking("notes_upload_attachment_abort", move || {
        uploads(&app)?.abort(&id);
        Ok(())
    })
    .await
}

/// Renames the file a block's `url` names in the note's attachments folder to `new_name`, keeping
/// its prefix and extension, and answers the block's new `url` and `name`.
#[tauri::command]
#[specta::specta]
pub async fn notes_attachment_rename<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    url: String,
    new_name: String,
) -> Result<RenamedAttachment, CommandError> {
    blocking("notes_attachment_rename", move || {
        attachments::rename(&open_vault(&app)?, &note_id, &url, &new_name)
            .map_err(|error| attachment_error(&app, "notes_attachment_rename", &error))
    })
    .await
}

/// Deletes a file of the note's attachments folder, unless another note names it or the scan
/// could not read every note (the open walk not yet ended complete among them): then the file stays and the answer names the notes.
#[tauri::command]
#[specta::specta]
pub async fn notes_delete_attachment<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    filename: String,
) -> Result<DeletedAttachment, CommandError> {
    blocking("notes_delete_attachment", move || {
        let rows = app.state::<Arc<VaultTier>>().rows();
        attachments::delete(
            &open_vault(&app)?,
            &rows,
            &note_id,
            &filename,
            &move_to_trash,
        )
        .map_err(|error| delete_error(&app, &error))
    })
    .await
}

/// `notes_delete_attachment`'s answer to `error`: a disk failure says the delete failed
/// (`errors:attachment.deleteFailed`, Electron's fallback), the rest as [`attachment_error`].
pub fn delete_error<R: Runtime>(app: &AppHandle<R>, error: &AttachmentError) -> CommandError {
    match error {
        AttachmentError::Io(_) | AttachmentError::NotAFolder => {
            tracing::warn!(
                scope = "attachments",
                "notes_delete_attachment failed on disk: {error}"
            );
            let locale = app.state::<Arc<LocaleService>>().get();
            let message = i18n::t(locale, "errors:attachment.deleteFailed", &Args::new());
            CommandError::new(ErrorKind::Storage, "attachment_delete_failed", message)
        }
        other => attachment_error(app, "notes_delete_attachment", other),
    }
}

/// The answer of a command that only reads (`notes_list_attachments`, `notes_attachment_resolve`,
/// `notes_attachment_reveal_in_finder`, `notes_attachment_open_external`) to `error`: a disk
/// failure says the read failed, with the text its caller shows for one (the attachments
/// dialog's `loadFailed`, the block menu's `revealFailed` and `openFailed`; the resolve's callers
/// show none), not that a write failed. The rest as [`attachment_error`].
pub fn read_error<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    error: &AttachmentError,
) -> CommandError {
    match error {
        AttachmentError::Io(_) | AttachmentError::NotAFolder => {
            tracing::warn!(scope = "attachments", "{command} failed on disk: {error}");
            let key = match command {
                "notes_attachment_reveal_in_finder" => "notes:editor.attachmentMenu.revealFailed",
                "notes_attachment_open_external" => "notes:editor.attachmentMenu.openFailed",
                _ => "notes:editor.attachmentsDialog.loadFailed",
            };
            let locale = app.state::<Arc<LocaleService>>().get();
            let message = i18n::t(locale, key, &Args::new());
            CommandError::new(ErrorKind::Storage, "attachment_read_failed", message)
        }
        other => attachment_error(app, command, other),
    }
}

/// `notes:list-attachments`: the files of the note's attachments folder.
#[tauri::command]
#[specta::specta]
pub async fn notes_list_attachments<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
) -> Result<Vec<AttachmentInfo>, CommandError> {
    blocking("notes_list_attachments", move || {
        attachments::list(&open_vault(&app)?, &note_id)
            .map_err(|error| read_error(&app, "notes_list_attachments", &error))
    })
    .await
}

/// `notes:attachment-resolve`: where a block's `url` points on this device, self-heal included.
#[tauri::command]
#[specta::specta]
pub async fn notes_attachment_resolve<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    url: String,
) -> Result<AttachmentLocation, CommandError> {
    blocking("notes_attachment_resolve", move || {
        attachments::locate(&open_vault(&app)?, &note_id, &url)
            .map_err(|error| read_error(&app, "notes_attachment_resolve", &error))
    })
    .await
}

/// `notes:attachment-reveal-in-finder`: the file a block's `url` names, in the OS file manager.
#[tauri::command]
#[specta::specta]
pub async fn notes_attachment_reveal_in_finder(
    app: AppHandle<Wry>,
    note_id: String,
    url: String,
) -> Result<(), CommandError> {
    blocking("notes_attachment_reveal_in_finder", move || {
        let path = attachments::existing(&open_vault(&app)?, &note_id, &url)
            .map_err(|error| read_error(&app, "notes_attachment_reveal_in_finder", &error))?;
        external::reveal_path(&app, &path.to_string_lossy())
    })
    .await
}

/// `notes:attachment-open-external`: the file a block's `url` names, in the OS's default app.
#[tauri::command]
#[specta::specta]
pub async fn notes_attachment_open_external(
    app: AppHandle<Wry>,
    note_id: String,
    url: String,
) -> Result<(), CommandError> {
    blocking("notes_attachment_open_external", move || {
        let path = attachments::existing(&open_vault(&app)?, &note_id, &url)
            .map_err(|error| read_error(&app, "notes_attachment_open_external", &error))?;
        external::open_path(&app, &path.to_string_lossy())
    })
    .await
}

/// The page of window `label` reloaded or closed: its uploads end with nothing. Called on the main
/// thread, so the part files, which wait for a part being written, go on a blocking thread.
pub fn release_page<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(uploads) = app.try_state::<Arc<Uploads>>() {
        let ended = uploads.release_owner(label);
        tauri::async_runtime::spawn_blocking(move || ended.finish());
    }
}
