//! Canvas and canvas folder events, with Electron's payloads (`CanvasChannels.events`,
//! `CanvasFolderChannels.events`).

use memry_desktop::canvas::folders::CanvasFolderView;
use memry_desktop::canvas::service::CanvasSummaryView;
use serde::Serialize;

/// A canvas was created, duplicated or kept as a conflict copy (`canvas:created`).
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
pub struct CanvasCreatedEvent {
    pub canvas: CanvasSummaryView,
}

/// A canvas was saved, renamed or moved (`canvas:updated`).
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
pub struct CanvasUpdatedEvent {
    pub canvas: CanvasSummaryView,
}

/// A canvas was deleted, alone or with its folder (`canvas:deleted`).
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
pub struct CanvasDeletedEvent {
    pub id: String,
}

/// A canvas was saved here and held back from sync: its scene is over the cap
/// (`canvas:too-large`).
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
pub struct CanvasTooLargeEvent {
    pub id: String,
}

/// `canvasFolder:created`.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
pub struct CanvasFolderCreatedEvent {
    pub folder: CanvasFolderView,
}

/// `canvasFolder:updated`: `previousPath` on a rename or move, so a listener re-keys state filed
/// under the old path.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFolderUpdatedEvent {
    pub folder: CanvasFolderView,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub previous_path: Option<String>,
}

/// `canvasFolder:deleted`.
#[derive(Debug, Clone, Serialize, specta::Type, tauri_specta::Event)]
pub struct CanvasFolderDeletedEvent {
    pub path: String,
}
