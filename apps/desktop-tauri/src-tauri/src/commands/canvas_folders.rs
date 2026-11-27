//! The canvas folder commands (`canvasFolder:*` of `ipc/canvas-folder-handlers.ts`), each one
//! call of `memry_desktop::canvas::folders`. A refusal the user can act on fails with its
//! `CANVAS_FOLDER_*` code and the `errors:canvasFolder.*` key as its message, which the
//! renderer's `extractErrorMessage` translates. A mutation that finds no live folder announces
//! nothing.

use memry_desktop::canvas::folders::{CanvasFolderView, FolderError};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::blocking;
use super::canvas::{canvases, now_ms};
use super::error::{CommandError, ErrorKind};
use crate::events::{
    CanvasDeletedEvent, CanvasFolderCreatedEvent, CanvasFolderDeletedEvent,
    CanvasFolderUpdatedEvent, broadcast,
};

fn failed(error: FolderError) -> CommandError {
    match (&error, error.refusal()) {
        (_, Some((code, key))) => CommandError::new(ErrorKind::Invalid, code, key),
        (FolderError::Storage(storage), None) => CommandError::from_core(storage),
        (_, None) => CommandError::new(
            ErrorKind::Internal,
            "canvas_folder_failed",
            error.to_string(),
        ),
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CanvasFolderListResponse {
    pub folders: Vec<CanvasFolderView>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CanvasFolderMutationResponse {
    pub folder: Option<CanvasFolderView>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFolderDeleteResponse {
    pub success: bool,
    pub deleted_canvas_ids: Vec<String>,
}

/// Announces a renamed, moved or re-iconed folder.
fn announce_updated<R: Runtime>(
    app: &AppHandle<R>,
    folder: Option<CanvasFolderView>,
    previous_path: Option<String>,
) -> CanvasFolderMutationResponse {
    if let Some(folder) = &folder {
        broadcast(
            app,
            CanvasFolderUpdatedEvent {
                folder: folder.clone(),
                previous_path,
            },
        );
    }
    CanvasFolderMutationResponse { folder }
}

/// `canvasFolder:list`.
#[tauri::command]
#[specta::specta]
pub async fn canvas_folder_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<CanvasFolderListResponse, CommandError> {
    blocking("canvas_folder_list", move || {
        let folders = canvases(&app)?.list_folders().map_err(failed)?;
        Ok(CanvasFolderListResponse { folders })
    })
    .await
}

/// `canvasFolder:create`: a directory and its record under `parent` (`null` the root).
#[tauri::command]
#[specta::specta]
pub async fn canvas_folder_create<R: Runtime>(
    app: AppHandle<R>,
    parent: Option<String>,
    name: String,
) -> Result<CanvasFolderMutationResponse, CommandError> {
    blocking("canvas_folder_create", move || {
        let folder = canvases(&app)?
            .create_folder(parent.as_deref(), &name, now_ms())
            .map_err(failed)?;
        broadcast(
            &app,
            CanvasFolderCreatedEvent {
                folder: folder.clone(),
            },
        );
        Ok(CanvasFolderMutationResponse {
            folder: Some(folder),
        })
    })
    .await
}

/// `canvasFolder:rename`: a new name under the same parent.
#[tauri::command]
#[specta::specta]
pub async fn canvas_folder_rename<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    name: String,
) -> Result<CanvasFolderMutationResponse, CommandError> {
    blocking("canvas_folder_rename", move || {
        let folder = canvases(&app)?
            .rename_folder(&path, &name, now_ms())
            .map_err(failed)?;
        Ok(announce_updated(&app, folder, Some(path)))
    })
    .await
}

/// `canvasFolder:move`: the same name under `parent` (`null` the root).
#[tauri::command]
#[specta::specta]
pub async fn canvas_folder_move<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    parent: Option<String>,
) -> Result<CanvasFolderMutationResponse, CommandError> {
    blocking("canvas_folder_move", move || {
        let folder = canvases(&app)?
            .move_folder(&path, parent.as_deref(), now_ms())
            .map_err(failed)?;
        Ok(announce_updated(&app, folder, Some(path)))
    })
    .await
}

/// `canvasFolder:set-icon`: `null` clears it.
#[tauri::command]
#[specta::specta]
pub async fn canvas_folder_set_icon<R: Runtime>(
    app: AppHandle<R>,
    path: String,
    icon: Option<String>,
) -> Result<CanvasFolderMutationResponse, CommandError> {
    blocking("canvas_folder_set_icon", move || {
        let folder = canvases(&app)?
            .set_folder_icon(&path, icon.as_deref(), now_ms())
            .map_err(failed)?;
        Ok(announce_updated(&app, folder, None))
    })
    .await
}

/// `canvasFolder:delete`: one [`CanvasDeletedEvent`] per canvas it took, then the folder's.
#[tauri::command]
#[specta::specta]
pub async fn canvas_folder_delete<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<CanvasFolderDeleteResponse, CommandError> {
    blocking("canvas_folder_delete", move || {
        let deleted_canvas_ids = canvases(&app)?
            .delete_folder(&path, now_ms())
            .map_err(failed)?;
        for id in &deleted_canvas_ids {
            broadcast(&app, CanvasDeletedEvent { id: id.clone() });
        }
        broadcast(&app, CanvasFolderDeletedEvent { path });
        Ok(CanvasFolderDeleteResponse {
            success: true,
            deleted_canvas_ids,
        })
    })
    .await
}
