//! The folder commands of Step 13h (`notes:*folder*` of `ipc/notes-handlers.ts`), each one
//! call of `memry_desktop::notes::folders`. Generic over the runtime so a mock app drives them
//! (`tests/folders.rs`); the reveal goes through the shell, which runs on `Wry` only.

use memry_desktop::notes::folders::{self, FolderConfigInput, FolderView};
use memry_desktop::vault::folder_file::FolderConfigView;
use tauri::{AppHandle, Runtime, Wry};

use super::blocking;
use super::error::CommandError;
use super::notes::{failed, open_vault, service};
use crate::shell::external;

/// `notes:get-folders`: every folder the notes tree lists, with its icon.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_folders<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<FolderView>, CommandError> {
    blocking("notes_get_folders", move || {
        folders::list(&open_vault(&app)?).map_err(|error| failed(&error))
    })
    .await
}

/// `notes:create-folder`: the folder (vault-relative, `/`-separated) and the parents it needs.
#[tauri::command]
#[specta::specta]
pub async fn notes_create_folder<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), CommandError> {
    blocking("notes_create_folder", move || {
        service(&app)?
            .create_folder(&open_vault(&app)?, &path)
            .map_err(|error| failed(&error))
    })
    .await
}

/// `notes:rename-folder`: the folder at `old_path` to `new_path`, a rename in place or a drag
/// to another parent, its notes with it (`notes::folder_move`).
#[tauri::command]
#[specta::specta]
pub async fn notes_rename_folder<R: Runtime>(
    app: AppHandle<R>,
    old_path: String,
    new_path: String,
) -> Result<(), CommandError> {
    blocking("notes_rename_folder", move || {
        service(&app)?
            .rename_folder(&open_vault(&app)?, &old_path, &new_path)
            .map_err(|error| failed(&error))
    })
    .await
}

/// `notes:reveal-folder-in-finder`: the folder itself, selected in its parent.
#[tauri::command]
#[specta::specta]
pub async fn notes_reveal_folder_in_finder(
    app: AppHandle<Wry>,
    folder_path: String,
) -> Result<(), CommandError> {
    blocking("notes_reveal_folder_in_finder", move || {
        let path =
            folders::on_disk(&open_vault(&app)?, &folder_path).map_err(|error| failed(&error))?;
        external::reveal_path(&app, &path.to_string_lossy())
    })
    .await
}

/// `notes:get-folder-config`: the folder's `.folder.md`, `null` when it has none or it cannot
/// be read.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_folder_config<R: Runtime>(
    app: AppHandle<R>,
    folder_path: String,
) -> Result<Option<FolderConfigView>, CommandError> {
    blocking("notes_get_folder_config", move || {
        folders::config(&open_vault(&app)?, &folder_path).map_err(|error| failed(&error))
    })
    .await
}

/// `notes:set-folder-config`: the icon, template and `inherit`; the folder's views stay.
#[tauri::command]
#[specta::specta]
pub async fn notes_set_folder_config<R: Runtime>(
    app: AppHandle<R>,
    folder_path: String,
    config: FolderConfigInput,
) -> Result<(), CommandError> {
    blocking("notes_set_folder_config", move || {
        service(&app)?
            .set_folder_config(&open_vault(&app)?, &folder_path, &config)
            .map_err(|error| failed(&error))
    })
    .await
}

/// `notes:get-folder-template`: the template a new note in the folder takes, inherited.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_folder_template<R: Runtime>(
    app: AppHandle<R>,
    folder_path: String,
) -> Result<Option<String>, CommandError> {
    blocking("notes_get_folder_template", move || {
        folders::template(&open_vault(&app)?, &folder_path).map_err(|error| failed(&error))
    })
    .await
}
