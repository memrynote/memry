//! The tag list and a tag's notes (`tags:get-all-with-counts` and `tags:get-notes-by-tag` of
//! `ipc/tags-handlers.ts`), each one call of `memry_desktop::tags`. Both are reads: unlike
//! Electron's, they mint no tag definition, so neither sends an event.

use std::sync::Arc;

use memry_desktop::i18n::{self, Args};
use memry_desktop::locale::LocaleService;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::tags;
use memry_desktop::tags::view::{NotesByTagInput, NotesByTagView, TagWithCountView};
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};

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

#[tauri::command]
#[specta::specta]
pub async fn tags_get_all_with_counts(
    app: AppHandle<Wry>,
) -> Result<Vec<TagWithCountView>, CommandError> {
    blocking("tags_get_all_with_counts", move || {
        tags::all_with_counts(&open_vault(&app)?).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tags_get_notes_by_tag(
    app: AppHandle<Wry>,
    input: NotesByTagInput,
) -> Result<NotesByTagView, CommandError> {
    blocking("tags_get_notes_by_tag", move || {
        tags::notes_by_tag(&open_vault(&app)?, &input)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}
