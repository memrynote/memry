//! The task events (`tasks:created`, `tasks:updated`, `tasks:deleted`, `tasks:completed`,
//! `tasks:moved`), sent after the write committed. They carry
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

/// A task was deleted (`tasks:deleted`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct TaskDeletedEvent {
    pub id: String,
}

/// A task was completed (`tasks:completed`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct TaskCompletedEvent {
    pub id: String,
}

/// A task changed project, status, parent or position through a move (`tasks:moved`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct TaskMovedEvent {
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

/// A project was made (`tasks:project-created`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ProjectCreatedEvent {
    pub id: String,
}

/// A project's metadata, statuses, links, home note, archive or position changed
/// (`tasks:project-updated`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ProjectUpdatedEvent {
    pub id: String,
}

/// A project was deleted with its tasks (`tasks:project-deleted`).
#[derive(Debug, Clone, Serialize, serde::Deserialize, specta::Type, tauri_specta::Event)]
pub struct ProjectDeletedEvent {
    pub id: String,
}
