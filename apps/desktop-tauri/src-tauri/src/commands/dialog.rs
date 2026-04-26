//! Native folder + file picker commands using
//! `tauri-plugin-dialog`. Returns POSIX path strings (forward slashes
//! on macOS).

use crate::error::{AppError, AppResult};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
#[specta::specta]
pub async fn dialog_choose_folder(
    app: AppHandle,
    title: Option<String>,
) -> AppResult<Option<String>> {
    let mut builder = app.dialog().file();
    if let Some(t) = &title {
        builder = builder.set_title(t);
    }
    let (tx, rx) = std::sync::mpsc::channel();
    builder.pick_folder(move |result| {
        let _ = tx.send(result);
    });
    let result = rx.recv().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn dialog_choose_files(
    app: AppHandle,
    title: Option<String>,
    filters: Option<Vec<String>>,
) -> AppResult<Vec<String>> {
    let mut builder = app.dialog().file();
    if let Some(t) = &title {
        builder = builder.set_title(t);
    }
    if let Some(exts) = filters.as_ref() {
        if !exts.is_empty() {
            let mut owned: Vec<&str> = exts.iter().map(String::as_str).collect();
            // Tauri's filter API expects (name, &[ext]).
            builder = builder.add_filter("Allowed", &owned);
            owned.clear();
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    builder.pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let result = rx.recv().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(result
        .map(|paths| paths.into_iter().map(|p| p.to_string()).collect())
        .unwrap_or_default())
}
