//! Stubbed in Task 11; populated in Task 12.

use crate::error::AppResult;

#[tauri::command]
#[specta::specta]
pub async fn shell_open_url(_url: String) -> AppResult<()> {
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn shell_open_path(_path: String) -> AppResult<()> {
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn shell_reveal_in_finder(_path: String) -> AppResult<()> {
    Ok(())
}

pub(crate) fn reveal_in_finder_inner(_path: &std::path::Path) -> AppResult<()> {
    Ok(())
}
