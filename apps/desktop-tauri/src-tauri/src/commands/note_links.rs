//! A note's links and the note a wiki link names (`notes:get-links`, `notes:resolve-by-title`,
//! `notes:resolve-titles`, `notes:resolve-wiki-target` of `ipc/notes-handlers.ts`), through
//! `memry_desktop::notes::links`.

use std::collections::BTreeMap;

use memry_desktop::notes::links::{
    LinkResolutionView, LinkTargetView, NoteLinks, NoteLinksView, TitleMatchView,
};
use tauri::{AppHandle, Runtime, Wry};

use super::blocking;
use super::error::CommandError;
use super::notes::open_vault;

/// The links of the open vault, or the localized "no vault is open".
fn links<R: Runtime>(app: &AppHandle<R>) -> Result<NoteLinks, CommandError> {
    open_vault(app).map(|open| NoteLinks::new(&open))
}

/// The links the note makes and the notes linking to it, with the text around each link.
#[tauri::command]
#[specta::specta]
pub async fn notes_get_links(
    app: AppHandle<Wry>,
    id: String,
) -> Result<NoteLinksView, CommandError> {
    blocking("notes_get_links", move || {
        links(&app)?
            .get(&id)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// The note `title` names as a whole (no heading split), or `null`.
#[tauri::command]
#[specta::specta]
pub async fn notes_resolve_by_title(
    app: AppHandle<Wry>,
    title: String,
) -> Result<Option<LinkResolutionView>, CommandError> {
    blocking("notes_resolve_by_title", move || {
        links(&app)?
            .resolve_by_title(&title)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// Each title mapped to the note it names, or `null`: one call per editor mount.
#[tauri::command]
#[specta::specta]
pub async fn notes_resolve_titles(
    app: AppHandle<Wry>,
    titles: Vec<String>,
) -> Result<BTreeMap<String, Option<TitleMatchView>>, CommandError> {
    blocking("notes_resolve_titles", move || {
        links(&app)?
            .resolve_titles(titles)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// The note a wiki-link target names, heading half and all (`Note#Heading`), or `null`.
#[tauri::command]
#[specta::specta]
pub async fn notes_resolve_wiki_target(
    app: AppHandle<Wry>,
    target: String,
) -> Result<Option<LinkTargetView>, CommandError> {
    blocking("notes_resolve_wiki_target", move || {
        links(&app)?
            .resolve_wiki_target(&target)
            .map_err(|error| CommandError::from_core(&error))
    })
    .await
}
