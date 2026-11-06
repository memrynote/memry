//! The folder commands of Step 13h (`notes:*folder*` of `ipc/notes-handlers.ts`), each one
//! call of `memry_desktop::notes::folders`. Generic over the runtime so a mock app drives them
//! (`tests/folders.rs`); the reveal goes through the shell, which runs on `Wry` only.

use std::cell::Cell;
use std::path::Path;
use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::folders::{self, FolderConfigInput, FolderView};
use memry_desktop::vault::config::VaultConfig;
use memry_desktop::vault::config::settings::vault_settings;
use memry_desktop::vault::folder_file::FolderConfigView;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::{failed, open_vault, service};
use super::vault::{CHANGE_WAITS_KEY, FOLDER_HELD_KEY};
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
/// `followJournalFolder` broadcasts it, and so is one that followed a journal folder moved
/// outside the app first ([`announce_followed`]).
#[tauri::command]
#[specta::specta]
pub async fn notes_rename_folder<R: Runtime>(
    app: AppHandle<R>,
    old_path: String,
    new_path: String,
) -> Result<(), CommandError> {
    blocking("notes_rename_folder", move || {
        let open = open_vault(&app)?;
        let before = vault_settings(Some(&open.path));
        let announced = Cell::new(false);
        let announce = |settings: &VaultConfig| {
            announced.set(true);
            broadcast(&app, VaultConfigChangedEvent(settings.clone()));
        };
        let moved = service(&app)?
            .rename_folder(&open, &old_path, &new_path, announce)
            .map_err(|error| settings_or_failed(&app, &error, Refused::FolderMove));
        if !announced.get() {
            announce_followed(&app, &open.path, &before);
        }
        moved
    })
    .await
}

/// Every window hears the settings when the journal folder changed from `before`: a day create,
/// a folder move and a folder delete first have the setting follow a journal folder moved
/// outside the app (`journal::folder_follow`), whether or not they then go through.
pub(crate) fn announce_followed<R: Runtime>(app: &AppHandle<R>, root: &Path, before: &VaultConfig) {
    let after = vault_settings(Some(root));
    if after.journal_folder != before.journal_folder {
        broadcast(app, VaultConfigChangedEvent(after));
    }
}

/// What settings that cannot be read refused, for the words that say so.
#[derive(Clone, Copy)]
pub(crate) enum Refused {
    FolderMove,
    FolderDelete,
    JournalDay,
}

/// A folder move, folder delete or day create refused for settings that cannot be read says so
/// in words naming what was refused, as Settings says its refusals: the raw message names no
/// file to fix. A folder move refused while a journal setting change waits says what to do.
pub(crate) fn settings_or_failed<R: Runtime>(
    app: &AppHandle<R>,
    error: &NotesError,
    refused: Refused,
) -> CommandError {
    match error {
        NotesError::SettingsUnreadable(why) => {
            tracing::warn!(
                scope = "folders",
                "a folder change or day create waits for the settings: {why}"
            );
            let key = match refused {
                Refused::FolderMove => "errors:vault.settingsUnreadable",
                Refused::FolderDelete => "errors:vault.settingsUnreadableDelete",
                Refused::JournalDay => "errors:vault.settingsUnreadableJournalDay",
            };
            let locale = app.state::<Arc<LocaleService>>().get();
            CommandError::new(
                ErrorKind::Invalid,
                "vault_settings_unreadable",
                i18n::t(locale, key, &Args::new()),
            )
        }
        NotesError::JournalChangeWaits => {
            let locale = app.state::<Arc<LocaleService>>().get();
            CommandError::new(
                ErrorKind::Invalid,
                "journal_change_waits",
                i18n::t(locale, CHANGE_WAITS_KEY, &Args::new()),
            )
        }
        NotesError::JournalFolderHeld => {
            let locale = app.state::<Arc<LocaleService>>().get();
            CommandError::new(
                ErrorKind::Invalid,
                "journal_folder_held",
                i18n::t(locale, FOLDER_HELD_KEY, &Args::new()),
            )
        }
        _ => failed(error),
    }
}

/// `notes:delete-folder`: the folder to the OS trash with everything in it, and its notes and
/// records deleted (`notes::folder_delete`). A journal setting that followed a journal folder
/// moved outside the app first is heard by every window ([`announce_followed`]).
#[tauri::command]
#[specta::specta]
pub async fn notes_delete_folder<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), CommandError> {
    blocking("notes_delete_folder", move || {
        let open = open_vault(&app)?;
        let before = vault_settings(Some(&open.path));
        let deleted = service(&app)?
            .delete_folder(&open, &path)
            .map_err(|error| settings_or_failed(&app, &error, Refused::FolderDelete));
        announce_followed(&app, &open.path, &before);
        deleted
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
