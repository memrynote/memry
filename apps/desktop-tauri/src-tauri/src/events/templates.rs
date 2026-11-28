//! Template events, after the write committed. The renderer refetches the list on each.

use serde::Serialize;

/// A template was created or duplicated (`templates:created`). The renderer refetches the list.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCreatedEvent {
    pub id: String,
}

/// A template was saved (`templates:updated`). The renderer refetches the list.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TemplateUpdatedEvent {
    pub id: String,
}

/// A template was deleted (`templates:deleted`). The renderer refetches the list.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TemplateDeletedEvent {
    pub id: String,
}
