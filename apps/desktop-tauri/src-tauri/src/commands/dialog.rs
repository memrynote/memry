//! Stubbed in Task 11; populated in Task 12.

use crate::error::AppResult;

#[tauri::command]
#[specta::specta]
pub async fn dialog_choose_folder(_title: Option<String>) -> AppResult<Option<String>> {
    Ok(None)
}

#[tauri::command]
#[specta::specta]
pub async fn dialog_choose_files(
    _title: Option<String>,
    _filters: Option<Vec<String>>,
) -> AppResult<Vec<String>> {
    Ok(Vec::new())
}
