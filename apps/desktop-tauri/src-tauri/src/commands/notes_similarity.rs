//! Similar notes, tag suggestions and note groups from the stored vectors (Step 23, #3540):
//! Electron's `notes:get-similar`, `notes:get-tag-suggestions` and `notes:cluster`
//! (`ipc/notes-handlers.ts:512-530`), each one call of `memry_desktop::notes::similarity`.

use memry_desktop::notes::similarity::{
    self, ClusterError, Invalid, NoteClustersResponse, NoteTagSuggestionsResponse,
    SimilarNotesResponse,
};
use memry_desktop::session::Session;
use memry_desktop::settings::SettingsService;
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::{CommandError, ErrorKind};

fn invalid(error: Invalid) -> CommandError {
    CommandError::new(ErrorKind::Invalid, "invalid", error.to_string())
}

/// `notes:get-similar`: the nearest notes not linked with `note_id`, `limit` of them (5 when
/// absent, 1 to 20).
#[tauri::command]
#[specta::specta]
pub async fn notes_get_similar<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
    limit: Option<u32>,
) -> Result<SimilarNotesResponse, CommandError> {
    blocking("notes_get_similar", move || {
        let vault = app.state::<Session>().current();
        let settings = app.state::<SettingsService>();
        similarity::similar(vault.as_ref(), &settings, &note_id, limit).map_err(invalid)
    })
    .await
}

/// `notes:get-tag-suggestions`: tags the nearest notes share and `note_id` lacks.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_tag_suggestions<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
) -> Result<NoteTagSuggestionsResponse, CommandError> {
    blocking("notes_get_tag_suggestions", move || {
        let vault = app.state::<Session>().current();
        let settings = app.state::<SettingsService>();
        Ok(similarity::tag_suggestions(
            vault.as_ref(),
            &settings,
            &note_id,
        ))
    })
    .await
}

/// `notes:cluster`: proposed groups for at most 300 notes.
#[tauri::command]
#[specta::specta]
pub async fn notes_cluster<R: Runtime>(
    app: AppHandle<R>,
    note_ids: Vec<String>,
) -> Result<NoteClustersResponse, CommandError> {
    blocking("notes_cluster", move || {
        let vault = app.state::<Session>().current();
        let settings = app.state::<SettingsService>();
        similarity::cluster(vault.as_ref(), &settings, &note_ids).map_err(|error| match error {
            ClusterError::Invalid(error) => invalid(error),
            ClusterError::Storage(error) => CommandError::from_core(&error),
        })
    })
    .await
}
