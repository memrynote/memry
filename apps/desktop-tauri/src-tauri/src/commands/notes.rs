//! The notes commands of Step 13f (`notes:*` of `ipc/notes-handlers.ts`), each one call of
//! `memry_desktop::notes`. This part reads; the create, the delete and their events follow.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::read;
use memry_desktop::notes::view::{FileView, NoteListOptions, NoteListPageView, NoteView};
use memry_desktop::session::{OpenVault, Session};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::shell::external;

/// The open vault, or the localized "no vault is open".
fn open_vault<R: Runtime>(app: &AppHandle<R>) -> Result<OpenVault, CommandError> {
    app.state::<Session>().current().ok_or_else(|| {
        let locale = app.state::<Arc<LocaleService>>().get();
        CommandError::new(
            ErrorKind::Invalid,
            "no_vault_open",
            i18n::t(locale, "errors:ipc.noVaultOpen", &Args::new()),
        )
    })
}

fn failed(error: &NotesError) -> CommandError {
    CommandError::from_core(error)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get(app: AppHandle<Wry>, id: String) -> Result<Option<NoteView>, CommandError> {
    blocking("notes_get", move || {
        read::get(&open_vault(&app)?, &id).map_err(|error| failed(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_by_path(
    app: AppHandle<Wry>,
    path: String,
) -> Result<Option<NoteView>, CommandError> {
    blocking("notes_get_by_path", move || {
        read::get_by_path(&open_vault(&app)?, &path).map_err(|error| failed(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get_file(
    app: AppHandle<Wry>,
    id: String,
) -> Result<Option<FileView>, CommandError> {
    blocking("notes_get_file", move || {
        read::get_file(&open_vault(&app)?, &id).map_err(|error| failed(&error))
    })
    .await
}

/// `notes:exists`: a `.md` path, or a title a link would resolve.
#[tauri::command]
#[specta::specta]
pub async fn notes_exists(
    app: AppHandle<Wry>,
    title_or_path: String,
) -> Result<bool, CommandError> {
    blocking("notes_exists", move || {
        read::exists(&open_vault(&app)?, &title_or_path).map_err(|error| failed(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_list(
    app: AppHandle<Wry>,
    options: NoteListOptions,
) -> Result<NoteListPageView, CommandError> {
    blocking("notes_list", move || {
        read::list(&open_vault(&app)?, &options).map_err(|error| failed(&error))
    })
    .await
}

/// `notes:open-external`: the note's file in the OS's default app.
#[tauri::command]
#[specta::specta]
pub async fn notes_open_external(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    blocking("notes_open_external", move || {
        let path = read::file_path(&open_vault(&app)?, &id).map_err(|error| failed(&error))?;
        external::open_path(&app, &path.to_string_lossy())
    })
    .await
}

/// `notes:reveal-in-finder`: the note's file in the OS file manager.
#[tauri::command]
#[specta::specta]
pub async fn notes_reveal_in_finder(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    blocking("notes_reveal_in_finder", move || {
        let path = read::file_path(&open_vault(&app)?, &id).map_err(|error| failed(&error))?;
        external::reveal_path(&app, &path.to_string_lossy())
    })
    .await
}
