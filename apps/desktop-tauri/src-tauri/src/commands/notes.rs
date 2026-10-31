//! The notes commands of Step 13f (`notes:*` of `ipc/notes-handlers.ts`), each one call of
//! `memry_desktop::notes`. The note events are not sent here: `shell::note_events` sends them
//! from the vault tier's row facts.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::read;
use memry_desktop::notes::service::NotesService;
use memry_desktop::notes::view::{
    FileView, NoteCreateInput, NoteListOptions, NoteListPageView, NoteView,
};
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::telemetry::Service;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::shell::{external, services};

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

/// The notes service `vault_boot` manages with the vault tier.
fn service<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<NotesService>, CommandError> {
    let service = app.try_state::<Arc<NotesService>>();
    service
        .map(|service| service.inner().clone())
        .ok_or_else(|| failed(&NotesError::Closed))
}

/// `note_created` / `note_deleted`, as the Electron handlers count them.
fn track(app: &AppHandle<Wry>, name: &str, action: &str) {
    if let Some(telemetry) = services::telemetry(app) {
        let mut event = Service::event(name, "notes", action);
        event.object_type = Some("note".to_owned());
        event.result = Some("success".to_owned());
        telemetry.track_main_event(event);
    }
}

/// `notes:create`. A template id (Step 13l) and `plainChecklists` (Step 32) are not read: the
/// renderer's service refuses them until their steps.
#[tauri::command]
#[specta::specta]
pub async fn notes_create(
    app: AppHandle<Wry>,
    input: NoteCreateInput,
) -> Result<NoteView, CommandError> {
    blocking("notes_create", move || {
        let open = open_vault(&app)?;
        let note = NewNoteFile {
            title: input.title,
            content: input.content.unwrap_or_default(),
            folder: input.folder,
            tags: input.tags.unwrap_or_default(),
            properties: input.properties.unwrap_or_default(),
            emoji: input.emoji,
        };
        let created = service(&app)?
            .create(&open, note)
            .map_err(|error| failed(&error))?;
        track(&app, "note_created", "created");
        Ok(created)
    })
    .await
}

/// `notes:delete`: for good, not to the OS trash.
#[tauri::command]
#[specta::specta]
pub async fn notes_delete(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    blocking("notes_delete", move || {
        let open = open_vault(&app)?;
        service(&app)?
            .delete(&open, &id)
            .map_err(|error| failed(&error))?;
        track(&app, "note_deleted", "deleted");
        Ok(())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn notes_get(app: AppHandle<Wry>, id: String) -> Result<Option<NoteView>, CommandError> {
    blocking("notes_get", move || {
        let telemetry = services::telemetry(&app);
        let note = read::get(&open_vault(&app)?, &id, telemetry.as_deref())
            .map_err(|error| failed(&error))?;
        if note.is_some() {
            track(&app, "note_opened", "opened");
        }
        Ok(note)
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
        let telemetry = services::telemetry(&app);
        read::get_by_path(&open_vault(&app)?, &path, telemetry.as_deref())
            .map_err(|error| failed(&error))
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
