//! Inbox events: open an item, the review nudge and returned snoozes.

use memry_desktop::shell::inbox_review::SnoozeDueItem;
use serde::Serialize;

/// Open an inbox item (`inbox-open-item-event`): `memry://open?item=<id>` and, with Step 27
/// (#3544), a clicked inbox notification.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct InboxOpenItemEvent {
    pub item_id: String,
}

/// The daily inbox review nudge fired (`inbox:review-due`): the renderer shows its toast.
/// `count` is the number of captures to review.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct InboxReviewDueEvent {
    pub count: i64,
}

/// The inbox review notification was clicked (`inbox:review-open`): the renderer opens the inbox.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct InboxReviewOpenEvent {}

/// Snoozed captures came back (`inbox:snooze-due`): the renderer refreshes the inbox list and
/// shows its banner and toast. `count` is the number of `items`, as Electron sends it.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct InboxSnoozeDueEvent {
    pub count: i64,
    pub items: Vec<SnoozeDueItem>,
}
