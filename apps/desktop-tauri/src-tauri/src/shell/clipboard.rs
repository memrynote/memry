//! The app's own clipboard access: the text read of quick capture's prefill and Edit > Paste and
//! Match Style, and the image write of `clipboard_write_image`.

use tauri::image::Image;
use tauri::{AppHandle, Runtime, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::commands::error::{CommandError, ErrorKind};

/// The clipboard text, or `""` when it holds none, as Electron's `clipboard.readText()` answered.
/// Never on the main thread: on Linux that thread answers the app's own selection requests, so a
/// read there of text the page copied waits on itself (the plugin's `read_text` warns of it).
pub async fn read_text(app: &AppHandle<Wry>) -> String {
    let app = app.clone();
    match tauri::async_runtime::spawn_blocking(move || app.clipboard().read_text()).await {
        Ok(Ok(text)) => text,
        // arboard reports an empty or a non-text clipboard as an error, and the plugin keeps only
        // its message; Electron answered "" for those as for every other failure.
        Ok(Err(error)) => {
            tracing::debug!(scope = "Clipboard", "no text was read: {error}");
            String::new()
        }
        Err(error) => {
            tracing::warn!(
                scope = "Clipboard",
                "the clipboard read did not run: {error}"
            );
            String::new()
        }
    }
}

/// Decodes `png` and puts it on the clipboard as an image. The caller has checked the header
/// (`memry_desktop::shell::clipboard_image`). Blocking work, never on the main thread (above).
pub fn write_png<R: Runtime>(app: &AppHandle<R>, png: &[u8]) -> Result<(), CommandError> {
    let image = Image::from_bytes(png).map_err(|error| {
        CommandError::new(
            ErrorKind::Invalid,
            "clipboard_image_decode",
            error.to_string(),
        )
    })?;
    app.clipboard().write_image(&image).map_err(|error| {
        CommandError::new(ErrorKind::Internal, "clipboard_write", error.to_string())
    })
}
