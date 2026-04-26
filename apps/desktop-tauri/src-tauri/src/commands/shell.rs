//! `shell.*` parity commands.
//!
//! - `shell_open_url(url)` opens an http(s) URL in the user's default
//!   browser via `tauri-plugin-shell`. Rejects non-http schemes.
//! - `shell_open_path(path)` opens a local file/folder with the OS
//!   default handler. The path must be absolute.
//! - `shell_reveal_in_finder(path)` selects the path in Finder
//!   (`open -R` on macOS).

use crate::error::{AppError, AppResult};
use std::path::Path;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
#[specta::specta]
pub async fn shell_open_url(app: AppHandle, url: String) -> AppResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::Validation(format!("non-http url: {url}")));
    }
    #[allow(deprecated)]
    let result = app.shell().open(url, None);
    result.map_err(|e| AppError::Vault(format!("shell open failed: {e}")))
}

#[tauri::command]
#[specta::specta]
pub async fn shell_open_path(app: AppHandle, path: String) -> AppResult<()> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(AppError::Validation(format!(
            "path must be absolute: {path}"
        )));
    }
    if !p.exists() {
        return Err(AppError::NotFound(path.clone()));
    }
    #[allow(deprecated)]
    let result = app.shell().open(path, None);
    result.map_err(|e| AppError::Vault(format!("shell open failed: {e}")))
}

#[tauri::command]
#[specta::specta]
pub async fn shell_reveal_in_finder(path: String) -> AppResult<()> {
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err(AppError::Validation(format!(
            "path must be absolute: {path}"
        )));
    }
    reveal_in_finder_inner(p)
}

pub(crate) fn reveal_in_finder_inner(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| AppError::Vault(format!("open -R failed: {e}")))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err(AppError::Validation(
            "reveal in finder is macOS-only in v1".into(),
        ))
    }
}
