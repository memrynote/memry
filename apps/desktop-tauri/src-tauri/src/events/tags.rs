//! The tag events (`tags:*`, `properties:definition-changed`, `notes:tags-changed`).

use serde::Serialize;

/// A tag's colour changed (`tags:color-updated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct TagColorUpdatedEvent {
    pub tag: String,
    pub color: String,
}

/// The tag hub's categories, or which tags sit in them, changed (`tags:categories-changed`).
/// `categoryId` names the category when one did; a drag names none.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagCategoriesChangedEvent {
    pub category_id: Option<String>,
}

/// What happened to a note in a tag, for [`TagNotesChangedEvent`].
#[derive(Debug, Clone, Copy, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TagNoteAction {
    Pinned,
    Unpinned,
    Removed,
}

/// A note was pinned in a tag, unpinned from it, or the tag was taken off it
/// (`tags:notes-changed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagNotesChangedEvent {
    pub tag: String,
    pub note_id: String,
    pub action: TagNoteAction,
}

/// A tag went from the vault, deleted or merged into another (`tags:deleted`): `affectedNotes`
/// notes and days lost it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagDeletedEvent {
    pub tag: String,
    pub affected_notes: u32,
}

/// A tag was renamed across the vault (`tags:renamed`): `affectedNotes` notes and days took the
/// new name.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagRenamedEvent {
    pub old_name: String,
    pub new_name: String,
    pub affected_notes: u32,
}

/// How far a tag rename got (`tags:progress`): `done` of `total` notes, for the run the
/// renderer named.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TagsProgressEvent {
    pub run_id: String,
    pub done: u32,
    pub total: u32,
}

/// A property definition was created for a tag field (`properties:definition-changed`). The
/// renderer refetches the tag schemas.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDefinitionChangedEvent {
    pub name: String,
}

/// Something the tag list shows changed (`notes:tags-changed`). No payload; the renderer
/// refetches.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct NoteTagsChangedEvent;
