//! The one reader of the clipboard: quick capture's prefill and Edit > Paste and Match Style.

use tauri::{AppHandle, Wry};
use tauri_plugin_clipboard_manager::ClipboardExt;

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
