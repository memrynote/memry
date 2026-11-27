//! The bookmark events (`bookmarks:created`, `bookmarks:deleted`, `bookmarks:reordered`), sent
//! after the write committed.

use memry_desktop::bookmarks::BookmarkView;
use serde::Serialize;

/// A bookmark was made, by a create, a toggle or a bulk create (`bookmarks:created`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct BookmarkCreatedEvent {
    pub bookmark: BookmarkView,
}

/// A bookmark was removed (`bookmarks:deleted`). It names the item, so a star knows whether it
/// is its own.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkDeletedEvent {
    pub id: String,
    pub item_type: String,
    pub item_id: String,
}

/// The bookmarks were put in a new order (`bookmarks:reordered`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct BookmarksReorderedEvent {
    pub bookmark_ids: Vec<String>,
}
