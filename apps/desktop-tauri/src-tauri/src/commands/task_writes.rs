//! The task writes other than `tasks:update` (`tasks:create` through `tasks:bulk-archive` of
//! `ipc/tasks-handlers.ts`) and `tasks:get-activity`, each one call of
//! `memry_desktop::tasks::service::TasksService`. A refusal stays Electron's envelope; a broken
//! `tasks-api.ts` bound and a storage failure reject with the `CommandError`. Each landed write
//! sends the events the service lists ([`super::tasks::announce`]).

use memry_desktop::tasks::contract::TaskMutation;
use memry_desktop::tasks::write_contract::{
    BulkIdsInput, BulkMoveInput, BulkMutation, ConvertToSubtaskInput, TaskAck,
    TaskActivityListInput, TaskActivityPageView, TaskCompleteInput, TaskCompletion,
    TaskCreateInput, TaskMoveInput, TaskReorderInput,
};
use tauri::{AppHandle, Runtime};

use super::error::CommandError;
use super::tasks::{run, write};

#[tauri::command]
#[specta::specta]
pub async fn tasks_create<R: Runtime>(
    app: AppHandle<R>,
    input: TaskCreateInput,
) -> Result<TaskMutation, CommandError> {
    write(app, "tasks_create", move |tasks| tasks.create(input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<TaskAck, CommandError> {
    write(app, "tasks_delete", move |tasks| tasks.delete(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_complete<R: Runtime>(
    app: AppHandle<R>,
    input: TaskCompleteInput,
) -> Result<TaskCompletion, CommandError> {
    write(app, "tasks_complete", move |tasks| tasks.complete(input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_uncomplete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<TaskMutation, CommandError> {
    write(app, "tasks_uncomplete", move |tasks| tasks.uncomplete(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_archive<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<TaskAck, CommandError> {
    write(app, "tasks_archive", move |tasks| {
        tasks.set_archived(&id, true)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_unarchive<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<TaskAck, CommandError> {
    write(app, "tasks_unarchive", move |tasks| {
        tasks.set_archived(&id, false)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_move<R: Runtime>(
    app: AppHandle<R>,
    input: TaskMoveInput,
) -> Result<TaskMutation, CommandError> {
    write(app, "tasks_move", move |tasks| tasks.move_task(input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_reorder<R: Runtime>(
    app: AppHandle<R>,
    input: TaskReorderInput,
) -> Result<TaskAck, CommandError> {
    write(app, "tasks_reorder", move |tasks| tasks.reorder(input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_duplicate<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<TaskMutation, CommandError> {
    write(app, "tasks_duplicate", move |tasks| tasks.duplicate(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_convert_to_subtask<R: Runtime>(
    app: AppHandle<R>,
    input: ConvertToSubtaskInput,
) -> Result<TaskMutation, CommandError> {
    write(app, "tasks_convert_to_subtask", move |tasks| {
        tasks.convert_to_subtask(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_convert_to_task<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<TaskMutation, CommandError> {
    write(app, "tasks_convert_to_task", move |tasks| {
        tasks.convert_to_task(&id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_bulk_complete<R: Runtime>(
    app: AppHandle<R>,
    input: BulkIdsInput,
) -> Result<BulkMutation, CommandError> {
    write(app, "tasks_bulk_complete", move |tasks| {
        tasks.bulk_complete(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_bulk_delete<R: Runtime>(
    app: AppHandle<R>,
    input: BulkIdsInput,
) -> Result<BulkMutation, CommandError> {
    write(app, "tasks_bulk_delete", move |tasks| {
        tasks.bulk_delete(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_bulk_move<R: Runtime>(
    app: AppHandle<R>,
    input: BulkMoveInput,
) -> Result<BulkMutation, CommandError> {
    write(app, "tasks_bulk_move", move |tasks| tasks.bulk_move(input)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_bulk_archive<R: Runtime>(
    app: AppHandle<R>,
    input: BulkIdsInput,
) -> Result<BulkMutation, CommandError> {
    write(app, "tasks_bulk_archive", move |tasks| {
        tasks.bulk_archive(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_get_activity<R: Runtime>(
    app: AppHandle<R>,
    input: TaskActivityListInput,
) -> Result<TaskActivityPageView, CommandError> {
    run(app, "tasks_get_activity", move |tasks, _| {
        tasks.activity(input)
    })
    .await
}
