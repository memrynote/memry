//! A note's attachments (`notes:upload-attachment` of `ipc/notes-handlers.ts`, #3531 14f-1),
//! through `memry_desktop::attachments`. `notes_upload_attachment` takes the file's bytes as the
//! raw request body with `{ noteId, fileName }` in the metadata header, so it is a binary command
//! (`binary.rs`), and `size`, the file's size: a file over `MAX_UPLOAD_BODY` (16 MiB until the
//! chunked upload of 14f-2) comes with an empty body and is refused on that size. A refused or
//! failed upload rejects with the localized `errors:attachment.*`
//! message; the renderer's service answers it as Electron's `{ success: false, error }`.

use std::sync::Arc;

use memry_desktop::attachments::{self, AttachmentError, SavedAttachment};
use memry_desktop::i18n::{self, Arg, Args};
use memry_desktop::locale::LocaleService;
use serde::Deserialize;
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use super::notes::open_vault;
use crate::binary;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadMeta {
    note_id: String,
    file_name: String,
    size: usize,
}

fn upload_error<R: Runtime>(app: &AppHandle<R>, error: &AttachmentError) -> CommandError {
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
        AttachmentError::NotAFolder | AttachmentError::Io(_) | AttachmentError::Write(_) => {
            tracing::warn!(
                scope = "attachments",
                "an attachment was not saved: {error}"
            );
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
        let error = upload_error(&app, &error);
        log_failure("notes_upload_attachment", &error);
        return Err(error);
    }
    let body = body.to_vec();
    blocking("notes_upload_attachment", move || {
        attachments::upload(&open_vault(&app)?, &meta.note_id, &meta.file_name, &body)
            .map_err(|error| upload_error(&app, &error))
    })
    .await
}
