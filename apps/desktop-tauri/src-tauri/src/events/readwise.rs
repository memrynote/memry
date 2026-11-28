//! The Readwise import event.

use serde::Serialize;

/// The Readwise run started, moved on, ended or failed (`import:readwise:status-changed`): the
/// page reads the status again.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ImportReadwiseStatusChangedEvent;
