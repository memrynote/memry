//! The folder commands of Step 13h (`notes:*folder*` of `ipc/notes-handlers.ts`), each one
//! call of `memry_desktop::notes::folders`. Generic over the runtime so a mock app drives them
//! (`tests/folders.rs`); the reveal goes through the shell, which runs on `Wry` only.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::folders::{self, FolderConfigInput, FolderView};
use memry_desktop::vault::config::VaultConfig;
use memry_desktop::vault::folder_file::FolderConfigView;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::{failed, open_vault, service};
use crate::events::{VaultConfigChangedEvent, broadcast};
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
/// to another parent, its notes with it (`notes::folder_move`). A journal setting that follows
/// the folder is heard by every window as [`VaultConfigChangedEvent`], as Electron's
/// `followJournalFolder` broadcasts it.
#[tauri::command]
#[specta::specta]
pub async fn notes_rename_folder<R: Runtime>(
    app: AppHandle<R>,
    old_path: String,
    new_path: String,
) -> Result<(), CommandError> {
    blocking("notes_rename_folder", move || {
        let announce = |settings: &VaultConfig| {
            broadcast(&app, VaultConfigChangedEvent(settings.clone()));
        };
        service(&app)?
            .rename_folder(&open_vault(&app)?, &old_path, &new_path, announce)
            .map_err(|error| rename_failed(&app, &error))
    })
    .await
}

/// A move refused for settings that cannot be read says so in words, as Settings says its
/// refusals: the raw message names no file to fix.
fn rename_failed<R: Runtime>(app: &AppHandle<R>, error: &NotesError) -> CommandError {
    match error {
        NotesError::SettingsUnreadable(why) => {
            tracing::warn!(
                scope = "folders",
                "a folder move waits for the settings: {why}"
            );
            let locale = app.state::<Arc<LocaleService>>().get();
            CommandError::new(
                ErrorKind::Invalid,
                "vault_settings_unreadable",
                i18n::t(locale, "errors:vault.settingsUnreadable", &Args::new()),
            )
        }
        _ => failed(error),
    }
}

/// `notes:delete-folder`: the folder to the OS trash with everything in it, and its notes and
/// records deleted (`notes::folder_delete`).
#[tauri::command]
#[specta::specta]
pub async fn notes_delete_folder<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), CommandError> {
    blocking("notes_delete_folder", move || {
        service(&app)?
            .delete_folder(&open_vault(&app)?, &path)
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
