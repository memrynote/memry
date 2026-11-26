//! The Home board events (`home-pages:created`, `updated`, `deleted`), sent after the write
//! committed. The renderer refetches the boards on each.

use serde::Serialize;

/// A board was made (`home-pages:created`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct HomePageCreatedEvent {
    pub id: String,
}

/// A board's name, widgets, position or cover changed (`home-pages:updated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct HomePageUpdatedEvent {
    pub id: String,
}

/// A board was deleted (`home-pages:deleted`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct HomePageDeletedEvent {
    pub id: String,
}
