//! Note events: changes, moves, links, portal usage, folder settings and the fold.

use memry_desktop::notes::index::LinkChanges;
use memry_desktop::notes::view::NoteListItemView;
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::broadcast;

/// A note's fold changed: a model wrote its chunks, its run failed, or the AI settings changed
/// (`note-fold:updated`). The renderer fetches the fold again.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct NoteFoldUpdatedEvent {
    pub note_id: String,
}

/// Who made a note change (`NoteEventSource`): the app, an edit outside it, or a change pulled
/// from another device, which an open editor does not remount for (Electron `source: 'sync'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum NoteEventSource {
    Internal,
    External,
    Sync,
}

/// A note was made, by the app or from a file that appeared (`notes:created`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct NoteCreatedEvent {
    pub note: NoteListItemView,
    pub source: NoteEventSource,
}

/// A note's file changed outside the app (`notes:updated`). `changes` holds the fields the
/// edit may have changed, as the note reads now (`NoteView::changes`); the body reaches the
/// open editor through its document.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpdatedEvent {
    pub id: String,
    pub changes: serde_json::Map<String, serde_json::Value>,
    pub source: NoteEventSource,
}

/// A note was deleted, in the app or by its file's removal (`notes:deleted`).
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeletedEvent {
    pub id: String,
    pub path: String,
    pub source: NoteEventSource,
}

/// A note's file moved or the app renamed the note (`notes:renamed`), by the app or by a move
/// outside it. A rename to a title the file name already says names one path. `newTitle` is the
/// title the note has now; `oldTitle` is the old file's name without `.md`, as Electron's
/// watcher sends it (no renderer reads it).
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteRenamedEvent {
    pub id: String,
    pub old_path: String,
    pub new_path: String,
    pub old_title: String,
    pub new_title: String,
}

/// The app moved a note to another folder (`notes:moved`, Electron's `moveNote`). The title
/// stays; the renderer refetches what it shows of the note.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteMovedEvent {
    pub id: String,
    pub old_path: String,
    pub new_path: String,
}

/// An outside edit of the note's file met typing the file did not have yet, and the typing won
/// (`notes:outside-edit-kept`, #4030): the outside text is kept as a version, and the write-back
/// writes the typing over it. No Electron channel: Electron's editor held the outside edit
/// itself.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub struct NoteOutsideEditKeptEvent {
    pub id: String,
}

/// Note events were dropped because their forwarder fell behind (no Electron channel: Electron
/// sends every event). No payload; the renderer refetches its note lists, its tags and every
/// note it shows.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct NoteEventsDroppedEvent;

/// The note index committed links that changed (`notes:links-changed`): the notes whose links
/// changed, and every note that gained or lost a link to it. Sent after the rows are written,
/// so a links panel refetching on it reads them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct NoteLinksChangedEvent {
    pub source_ids: Vec<String>,
    pub target_ids: Vec<String>,
}

impl From<LinkChanges> for NoteLinksChangedEvent {
    fn from(changes: LinkChanges) -> Self {
        Self {
            source_ids: changes.sources.into_iter().collect(),
            target_ids: changes.targets.into_iter().collect(),
        }
    }
}

/// The notes whose portal usage changed (`portals:usage-changed`): a host gained or lost a
/// portal or a block link to them. Sent with the link rows written, so a usage chip refetching
/// on it reads them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct PortalsUsageChangedEvent {
    pub note_ids: Vec<String>,
}

/// Sends what one committed reindex changed in links: `portals:usage-changed` for the notes whose
/// portal readers moved, and `notes:links-changed` only when a note's links did, as Electron's
/// projectors send each on its own change.
pub fn announce_links<R: Runtime>(app: &AppHandle<R>, links: LinkChanges) {
    if !links.usage.is_empty() {
        let note_ids = links.usage.iter().cloned().collect();
        broadcast(app, PortalsUsageChangedEvent { note_ids });
    }
    if !links.sources.is_empty() || !links.targets.is_empty() {
        broadcast(app, NoteLinksChangedEvent::from(links));
    }
}

/// A folder's settings or its record changed, or the folder left the vault, by sync
/// (`notes:folder-config-updated`): the folder `path` names, vault-relative.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct FolderConfigUpdatedEvent {
    pub path: String,
}
