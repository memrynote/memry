//! The project commands (`tasks:project-*` of `ipc/tasks-handlers.ts`, other than `capture-url`
//! and `import-files`), each one call of `memry_desktop::tasks::service::TasksService`. A refusal
//! stays Electron's envelope; a broken `tasks-api.ts` bound and a storage failure reject with the
//! `CommandError`. Each landed write sends the events the service lists
//! ([`super::tasks::announce`]).

use memry_desktop::tasks::project_contract::{
    ProjectContentsView, ProjectCreateInput, ProjectLinkItemInput, ProjectLinkView,
    ProjectListForItemInput, ProjectListView, ProjectMutation, ProjectRefView, ProjectReorderInput,
    ProjectSetHomeNoteInput, ProjectSetLinkPinnedInput, ProjectUpdateInput,
    ProjectWithStatusesView,
};
use tauri::{AppHandle, Runtime};

use super::error::CommandError;
use super::notes::open_vault;
use super::tasks::{run, write};

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_create<R: Runtime>(
    app: AppHandle<R>,
    input: ProjectCreateInput,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_create", move |tasks| {
        tasks.create_project(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_get<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<ProjectWithStatusesView>, CommandError> {
    run(app, "tasks_project_get", move |tasks, _| tasks.project(&id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_update<R: Runtime>(
    app: AppHandle<R>,
    input: ProjectUpdateInput,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_update", move |tasks| {
        tasks.update_project(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_delete", move |tasks| {
        tasks.delete_project(&id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<ProjectListView, CommandError> {
    run(app, "tasks_project_list", |tasks, _| tasks.projects()).await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_archive<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_archive", move |tasks| {
        tasks.archive_project(&id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_reorder<R: Runtime>(
    app: AppHandle<R>,
    input: ProjectReorderInput,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_reorder", move |tasks| {
        tasks.reorder_projects(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_link_item<R: Runtime>(
    app: AppHandle<R>,
    input: ProjectLinkItemInput,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_link_item", move |tasks| {
        tasks.link_project_item(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_unlink_item<R: Runtime>(
    app: AppHandle<R>,
    input: ProjectLinkItemInput,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_unlink_item", move |tasks| {
        tasks.unlink_project_item(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_list_links<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Vec<ProjectLinkView>, CommandError> {
    run(app, "tasks_project_list_links", move |tasks, _| {
        tasks.project_links(&id)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_list_contents<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<ProjectContentsView, CommandError> {
    let open = open_vault(&app)?;
    run(app, "tasks_project_list_contents", move |tasks, _| {
        tasks.project_contents(&id, &open.vault, &open.path)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_set_link_pinned<R: Runtime>(
    app: AppHandle<R>,
    input: ProjectSetLinkPinnedInput,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_set_link_pinned", move |tasks| {
        tasks.set_project_link_pinned(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_set_home_note<R: Runtime>(
    app: AppHandle<R>,
    input: ProjectSetHomeNoteInput,
) -> Result<ProjectMutation, CommandError> {
    write(app, "tasks_project_set_home_note", move |tasks| {
        tasks.set_project_home_note(input)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn tasks_project_list_for_item<R: Runtime>(
    app: AppHandle<R>,
    input: ProjectListForItemInput,
) -> Result<Vec<ProjectRefView>, CommandError> {
    run(app, "tasks_project_list_for_item", move |tasks, _| {
        tasks.projects_for_item(input)
    })
    .await
}
