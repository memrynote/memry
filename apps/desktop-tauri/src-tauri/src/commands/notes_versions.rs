//! A note's or a journal day's version history (`notes:get-versions`, `notes:get-version`,
//! `notes:restore-version`, `notes:delete-version` of `ipc/notes-handlers.ts`; #3531 14d), each
//! one call of `memry_desktop::editor::versions`. The note event of a restore comes from its row
//! fact, as every note event does (`shell::note_events`).

use memry_desktop::editor::versions::{self, VersionDetailView, VersionView};
use memry_desktop::notes::view::NoteView;
use tauri::{AppHandle, Wry};

use super::blocking;
use super::error::CommandError;
use super::notes::{failed, open_vault, service, track};
use crate::events::{NoteTagsChangedEvent, broadcast};

/// `notes:get-versions`: newest first, at most 50.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_versions(
    app: AppHandle<Wry>,
    note_id: String,
) -> Result<Vec<VersionView>, CommandError> {
    blocking("notes_get_versions", move || {
        versions::list(&open_vault(&app)?, &note_id).map_err(|error| failed(&error))
    })
    .await
}

/// `notes:get-version`: the version and the file it restores to; `null` for none.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_version(
    app: AppHandle<Wry>,
    snapshot_id: String,
) -> Result<Option<VersionDetailView>, CommandError> {
    blocking("notes_get_version", move || {
        versions::get(&open_vault(&app)?, &snapshot_id).map_err(|error| failed(&error))
    })
    .await
}

/// `notes:restore-version`: the note's body becomes the version's, the text it replaced kept as
/// the newest version. Answers the note as it reads now; `null` for a journal day.
#[tauri::command]
#[specta::specta]
pub async fn notes_restore_version(
    app: AppHandle<Wry>,
    snapshot_id: String,
) -> Result<Option<NoteView>, CommandError> {
    blocking("notes_restore_version", move || {
        let open = open_vault(&app)?;
        let restored = versions::restore(&*service(&app)?, &open, &snapshot_id)
            .map_err(|error| failed(&error))?;
        track(&app, "note_updated", "version_restored");
        if restored.tags_changed {
            broadcast(&app, NoteTagsChangedEvent);
        }
        Ok(restored.note)
    })
    .await
}

/// `notes:delete-version`: a version that is not there is no failure, as in Electron.
#[tauri::command]
#[specta::specta]
pub async fn notes_delete_version(
    app: AppHandle<Wry>,
    snapshot_id: String,
) -> Result<(), CommandError> {
    blocking("notes_delete_version", move || {
        versions::delete(&open_vault(&app)?, &snapshot_id)
            .map(drop)
            .map_err(|error| failed(&error))
    })
    .await
}
