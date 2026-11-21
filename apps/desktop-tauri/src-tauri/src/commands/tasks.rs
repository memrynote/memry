//! The task reads, the task update and the status commands (`tasks:*` of
//! `ipc/tasks-handlers.ts`), each one call of `memry_desktop::tasks::service::TasksService`.
//! A refusal Electron answers with `{ success: false, error }` stays that envelope; a broken
//! `tasks-api.ts` bound and a storage failure reject with the `CommandError`.
//!
//! After a landed write [`announce`] sends the events the service lists, in `publisher.ts`'s
//! order. The status commands send nothing, as Electron's publisher sends nothing for them. The
//! other task writes live in `task_writes`.

use std::sync::Arc;

use memry_desktop::error::CoreError;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::tasks::contract::{
    StatusCreateInput, StatusMutation, StatusReorderInput, StatusUpdateInput, StatusView,
    TaskListInput, TaskListItemView, TaskMutation, TaskPageView, TaskStatsView, TaskTagCount,
    TaskUpdateInput, TaskView,
};
use memry_desktop::tasks::service::{TaskEvent, TaskWritten, TasksService};
use tauri::{AppHandle, Manager, Runtime};

use super::blocking;
use super::error::CommandError;
use super::notes::open_vault;
use crate::events::{
    NoteTagsChangedEvent, TaskCompletedEvent, TaskCreatedEvent, TaskDeletedEvent, TaskMovedEvent,
    TaskUpdatedEvent, broadcast,
};

fn service<R: Runtime>(app: &AppHandle<R>) -> Result<TasksService, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    TasksService::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

/// Runs `work` on the open vault's service off the async runtime.
pub(super) async fn run<R, T, E, F>(
    app: AppHandle<R>,
    command: &'static str,
    work: F,
) -> Result<T, CommandError>
where
    R: Runtime,
    T: Send + 'static,
    E: CoreError,
    F: FnOnce(&TasksService, &AppHandle<R>) -> Result<T, E> + Send + 'static,
{
    blocking(command, move || {
        let tasks = service(&app)?;
        work(&tasks, &app).map_err(|error| CommandError::from_core(&error))
    })
    .await
}

/// The events of one task write, after it committed, in the order the service lists them.
pub fn announce<R: Runtime, M>(app: &AppHandle<R>, written: &TaskWritten<M>) {
    for event in &written.events {
        match event {
            TaskEvent::Created(id) => broadcast(app, TaskCreatedEvent { id: id.clone() }),
            TaskEvent::Updated(id) => broadcast(app, TaskUpdatedEvent { id: id.clone() }),
            TaskEvent::Deleted(id) => broadcast(app, TaskDeletedEvent { id: id.clone() }),
            TaskEvent::Completed(id) => broadcast(app, TaskCompletedEvent { id: id.clone() }),
            TaskEvent::Moved(id) => broadcast(app, TaskMovedEvent { id: id.clone() }),
            TaskEvent::TagsChanged => broadcast(app, NoteTagsChangedEvent),
        }
    }
}

/// Runs one task write and, once it committed, sends its events; answers its envelope.
pub(super) async fn write<R, M, E, F>(
    app: AppHandle<R>,
    command: &'static str,
    work: F,
) -> Result<M, CommandError>
where
    R: Runtime,
    M: Send + 'static,
    E: CoreError,
    F: FnOnce(&TasksService) -> Result<TaskWritten<M>, E> + Send + 'static,
{
    run(app, command, move |tasks, app| {
        let written = work(tasks)?;
        announce(app, &written);
        Ok::<_, E>(written.mutation)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<TaskListItemView>, CommandError> {
    run(app, "tasks_get", move |tasks, _| tasks.get(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_list<R: Runtime>(
    app: AppHandle<R>,
    input: TaskListInput,
) -> Result<TaskPageView, CommandError> {
    run(app, "tasks_list", move |tasks, _| tasks.list(input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_update<R: Runtime>(
    app: AppHandle<R>,
    input: TaskUpdateInput,
) -> Result<TaskMutation, CommandError> {
    write(app, "tasks_update", move |tasks| tasks.update(input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get_subtasks<R: Runtime>(
    app: AppHandle<R>,
    parent_id: String,
) -> Result<Vec<TaskListItemView>, CommandError> {
    run(app, "tasks_get_subtasks", move |tasks, _| {
        tasks.subtasks(&parent_id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get_tags<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<TaskTagCount>, CommandError> {
    run(app, "tasks_get_tags", |tasks, _| tasks.tags()).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get_stats<R: Runtime>(app: AppHandle<R>) -> Result<TaskStatsView, CommandError> {
    run(app, "tasks_get_stats", |tasks, _| tasks.stats()).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get_today<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<TaskListItemView>, CommandError> {
    run(app, "tasks_get_today", |tasks, _| tasks.today()).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get_upcoming<R: Runtime>(
    app: AppHandle<R>,
    days: Option<i64>,
) -> Result<Vec<TaskListItemView>, CommandError> {
    run(app, "tasks_get_upcoming", move |tasks, _| {
        tasks.upcoming(days)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get_overdue<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<TaskListItemView>, CommandError> {
    run(app, "tasks_get_overdue", |tasks, _| tasks.overdue()).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get_linked_tasks<R: Runtime>(
    app: AppHandle<R>,
    note_id: String,
) -> Result<Vec<TaskView>, CommandError> {
    run(app, "tasks_get_linked_tasks", move |tasks, _| {
        tasks.linked_tasks(&note_id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_status_list<R: Runtime>(
    app: AppHandle<R>,
    project_id: String,
) -> Result<Vec<StatusView>, CommandError> {
    run(app, "tasks_status_list", move |tasks, _| {
        tasks.statuses(&project_id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_status_create<R: Runtime>(
    app: AppHandle<R>,
    input: StatusCreateInput,
) -> Result<StatusMutation, CommandError> {
    run(app, "tasks_status_create", move |tasks, _| {
        tasks.create_status(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_status_update<R: Runtime>(
    app: AppHandle<R>,
    input: StatusUpdateInput,
) -> Result<StatusMutation, CommandError> {
    run(app, "tasks_status_update", move |tasks, _| {
        tasks.update_status(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_status_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<StatusMutation, CommandError> {
    run(app, "tasks_status_delete", move |tasks, _| {
        tasks.delete_status(&id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_status_reorder<R: Runtime>(
    app: AppHandle<R>,
    input: StatusReorderInput,
) -> Result<StatusMutation, CommandError> {
    run(app, "tasks_status_reorder", move |tasks, _| {
        tasks.reorder_statuses(input)
    })
    .await
}
