use crate::commands::error::{CommandError, ErrorKind};

fn failure(error: arboard::Error) -> CommandError {
    CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string())
}

/// `None` when the clipboard holds no text.
#[tauri::command]
pub async fn e2e_clipboard_read() -> Result<Option<String>, CommandError> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new().map_err(failure)?;
        match clipboard.get_text() {
            Ok(text) => Ok(Some(text)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(error) => Err(failure(error)),
        }
    })
    .await
    .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string()))?
}

#[tauri::command]
pub async fn e2e_clipboard_write(text: String) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(text))
            .map_err(failure)
    })
    .await
    .map_err(|error| CommandError::new(ErrorKind::Internal, "e2e_clipboard", error.to_string()))?
}
