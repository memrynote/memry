//! The custom icon library event.

use serde::Serialize;

/// A custom icon was added, renamed or deleted (`custom-icons:updated`). The renderer refetches
/// the library.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct CustomIconsUpdatedEvent {
    pub id: String,
}
