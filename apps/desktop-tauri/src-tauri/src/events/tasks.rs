//! The task events (`tasks:created`, `tasks:updated`), sent after the write committed. They carry
//! the task id only; the renderer refetches.

use serde::Serialize;

/// A task was made, by a create or as the next occurrence of a completed repeating task
/// (`tasks:created`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct TaskCreatedEvent {
    pub id: String,
}

/// A task's fields changed (`tasks:updated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct TaskUpdatedEvent {
    pub id: String,
}

/// A task's activity log grew (`task-activity:created`): a pulled peer row or a `superseded` row
/// this device wrote, sent once its row committed (`SyncEvent::TaskActivityCreated`), so the
/// open activity list refetches.
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct TaskActivityCreatedEvent {
    pub task_id: String,
}
