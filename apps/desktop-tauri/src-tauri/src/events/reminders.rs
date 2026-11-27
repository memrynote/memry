//! Reminder events of the scheduler (Step 21f) and the reminder commands (Step 21f2, #3538).
//! They carry ids and small hints only: the
//! renderer's consumers read `targetType` and `targetId` (`use-triggered-date-pills.ts`,
//! `use-reminders.ts` `eventMatchesTarget`) and fetch the reminder by id when they need it.

use serde::Serialize;

/// The reminder an event is about.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderHint {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
}

impl ReminderHint {
    pub fn new(id: &str, target_type: &str, target_id: &str) -> Self {
        Self {
            id: id.to_owned(),
            target_type: target_type.to_owned(),
            target_id: target_id.to_owned(),
        }
    }
}

/// One scheduler tick fired these reminders; `count` is how many (Electron `ReminderDueEvent`),
/// also when some are gone by the time the renderer reads them back.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ReminderDueEvent {
    pub reminders: Vec<ReminderHint>,
    pub count: u32,
}

/// A reminder command created this reminder.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ReminderCreatedEvent {
    pub reminder: ReminderHint,
}

/// A reminder command changed this reminder's time, title or note.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ReminderUpdatedEvent {
    pub reminder: ReminderHint,
}

/// A reminder command deleted this reminder.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ReminderDeletedEvent {
    pub reminder: ReminderHint,
}

/// A reminder command dismissed this reminder.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ReminderDismissedEvent {
    pub reminder: ReminderHint,
}

/// A reminder command snoozed this reminder.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ReminderSnoozedEvent {
    pub reminder: ReminderHint,
}

/// The user clicked a reminder notification.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ReminderClickedEvent {
    pub reminder: ReminderHint,
}
