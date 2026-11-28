//! Sticky note events.

use serde::Serialize;

/// A sticky draft was written or deleted (`sticky:drafts-changed`), sent to every window; the
/// edge tab and the sticky read the list again.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct StickyDraftsChangedEvent;

/// The sticky asks the main window to open what a send made (`sticky:open-target-requested`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct StickyOpenTargetRequestedEvent {
    /// `note`, `task` or `journal`.
    pub kind: String,
    /// A note id, a task id, or the journal day (`YYYY-MM-DD`).
    pub target_id: String,
}
