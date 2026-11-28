//! Journal events: a day's entry created, updated or deleted, and its counts changed.

use memry_desktop::journal::JournalEntryView;
use serde::Serialize;

use super::NoteEventSource;

/// A day's entry was made on its first write, or its file appeared outside the app
/// (`journal:entryCreated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryCreatedEvent {
    pub date: String,
    pub entry: JournalEntryView,
    /// `external` for a file found outside the app; left out for the app's own write.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = NoteEventSource)]
    pub source: Option<NoteEventSource>,
}

/// A day's entry was edited in the app or outside it (`journal:entryUpdated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryUpdatedEvent {
    pub date: String,
    pub entry: JournalEntryView,
    /// `external` for an edit outside the app, on which an open editor takes the file's text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = NoteEventSource)]
    pub source: Option<NoteEventSource>,
}

/// A day's entry was deleted, in the app or by its file's removal (`journal:entryDeleted`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntryDeletedEvent {
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional, type = NoteEventSource)]
    pub source: Option<NoteEventSource>,
}

/// A day's counts landed after the event of its save or edit went out (`journal:externalChange`,
/// which Electron defines and never sends): the renderer refetches the day's reads.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct JournalExternalChangeEvent {
    pub date: String,
    #[serde(rename = "type")]
    pub kind: JournalExternalChange,
}

/// `JournalExternalChangeEvent.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum JournalExternalChange {
    Modified,
}

/// Journal events were dropped because their forwarder fell behind (no Electron channel:
/// Electron sends every event). No payload; the renderer refetches its journal reads and, unless
/// the open day holds unsaved text, that day.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct JournalEventsDroppedEvent;
