//! `clipboard_write_image`: an image the page encoded, onto the OS clipboard. The mind map's
//! Copy as image writes its PNG through the webview's async clipboard first and comes here when the
//! webview refuses (`mind-map-export.ts`). The raw body is the PNG and nothing else: no path, no
//! URL, so the command reads no file. `memry_desktop::shell::clipboard_image` checks the header
//! before anything is decoded.

use memry_desktop::shell::clipboard_image::{self, ImageRefusal};
use tauri::ipc::Request;
use tauri::{AppHandle, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind, log_failure};
use crate::binary;

fn refused(refusal: ImageRefusal) -> CommandError {
    let message = match refusal {
        ImageRefusal::NotPng => "The copied image is not a PNG.",
        ImageRefusal::TooLarge => "The image is too large to copy.",
    };
    CommandError::new(ErrorKind::Invalid, refusal.code(), message)
}

/// Puts the PNG in the raw request body (`invokeBinary`, meta `{}`) on the clipboard as an image.
/// Listed in `binary::COMMANDS`; not a specta command.
#[tauri::command]
pub async fn clipboard_write_image<R: Runtime>(
    app: AppHandle<R>,
    request: Request<'_>,
) -> Result<(), CommandError> {
    let body = binary::raw_body(&request)?;
    // Refused before the body is copied or decoded.
    if let Err(refusal) = clipboard_image::png_size(body) {
        let error = refused(refusal);
        log_failure("clipboard_write_image", &error);
        return Err(error);
    }
    let body = body.to_vec();
    blocking("clipboard_write_image", move || {
        crate::shell::clipboard::write_png(&app, &body)
    })
    .await
}
