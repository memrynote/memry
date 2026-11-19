//! The canvas commands (`canvas:*` of `ipc/canvas-handlers.ts` but the asset and live-canvas
//! ones), each one call of `memry_desktop::canvas::service`. Every write announces itself with
//! Electron's payloads: [`CanvasCreatedEvent`], [`CanvasUpdatedEvent`], [`CanvasDeletedEvent`],
//! and [`CanvasTooLargeEvent`] for a canvas saved here and held back from sync.

use std::sync::Arc;

use memry_desktop::canvas::library::{read_canvas_library, write_canvas_library};
use memry_desktop::canvas::service::{
    CanvasCreateInput, CanvasError, CanvasService, CanvasSummaryView, CanvasUpdateInput,
    CanvasView, Update, Written,
};
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, Wry};

use super::blocking;
use super::error::{CommandError, ErrorKind};
use super::notes::open_vault;
use crate::events::{
    CanvasCreatedEvent, CanvasDeletedEvent, CanvasTooLargeEvent, CanvasUpdatedEvent, broadcast,
};
use crate::shell::external;

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// The open vault's canvases, written under this device's identity.
pub(crate) fn canvases<R: Runtime>(app: &AppHandle<R>) -> Result<CanvasService, CommandError> {
    let open = open_vault(app)?;
    let store = app.state::<Arc<DeviceIdentityStore>>().inner().clone();
    CanvasService::open(&open, store).map_err(|error| CommandError::from_core(&error))
}

fn failed(error: CanvasError) -> CommandError {
    match &error {
        CanvasError::Storage(storage) => CommandError::from_core(storage),
        _ => CommandError::new(
            ErrorKind::Invalid,
            "canvas_write_refused",
            error.to_string(),
        ),
    }
}

/// Announces a created canvas, and that it is held back from sync when it is.
fn announce_created<R: Runtime>(app: &AppHandle<R>, written: &Written) {
    broadcast(
        app,
        CanvasCreatedEvent {
            canvas: written.canvas.summary.clone(),
        },
    );
    if written.too_large {
        broadcast(
            app,
            CanvasTooLargeEvent {
                id: written.canvas.summary.id.clone(),
            },
        );
    }
}

/// `CanvasUpdateResponse`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasUpdateResponse {
    #[serde(flatten)]
    pub summary: CanvasSummaryView,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CanvasDeleteResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CanvasListResponse {
    pub canvases: Vec<CanvasSummaryView>,
}

/// `CanvasLibraryListResponse`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasLibraryListResponse {
    pub library_items: Vec<Value>,
}

/// `CanvasLibrarySaveSchema`: Excalidraw's full item list; absence is how a delete arrives.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasLibrarySaveInput {
    pub library_items: Vec<Value>,
}

/// `CanvasLibrarySaveResponse`: the item count when the file was written, else 0.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CanvasLibrarySaveResponse {
    pub changed: usize,
}

/// `canvas:create`.
#[tauri::command]
#[specta::specta]
pub async fn canvas_create<R: Runtime>(
    app: AppHandle<R>,
    input: CanvasCreateInput,
) -> Result<CanvasView, CommandError> {
    blocking("canvas_create", move || {
        let written = canvases(&app)?.create(&input, now_ms()).map_err(failed)?;
        announce_created(&app, &written);
        Ok(written.canvas)
    })
    .await
}

/// `canvas:get`: `null` for a deleted canvas.
#[tauri::command]
#[specta::specta]
pub async fn canvas_get<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<CanvasView>, CommandError> {
    blocking("canvas_get", move || {
        canvases(&app)?.get(&id, now_ms()).map_err(failed)
    })
    .await
}

/// `canvas:update`. A conflict or a missing canvas fails with Electron's message.
#[tauri::command]
#[specta::specta]
pub async fn canvas_update<R: Runtime>(
    app: AppHandle<R>,
    input: CanvasUpdateInput,
) -> Result<CanvasUpdateResponse, CommandError> {
    blocking("canvas_update", move || {
        let outcome = canvases(&app)?.update(&input, now_ms()).map_err(failed)?;
        let (summary, too_large, conflict_copy) = match outcome {
            Update::Saved {
                summary,
                too_large,
                conflict_copy,
            } => (summary, too_large, conflict_copy),
            Update::Conflict => {
                return Err(CommandError::new(
                    ErrorKind::Invalid,
                    "canvas_conflict",
                    "Canvas was modified by someone else since it was read",
                ));
            }
            Update::NotFound => {
                return Err(CommandError::new(
                    ErrorKind::NotFound,
                    "canvas_not_found",
                    "Canvas not found",
                ));
            }
        };
        if let Some(copy) = &conflict_copy {
            announce_created(&app, copy);
        }
        broadcast(
            &app,
            CanvasUpdatedEvent {
                canvas: summary.clone(),
            },
        );
        if too_large {
            broadcast(
                &app,
                CanvasTooLargeEvent {
                    id: summary.id.clone(),
                },
            );
        }
        Ok(CanvasUpdateResponse { summary, too_large })
    })
    .await
}

/// `canvas:delete`: the document goes to the OS trash.
#[tauri::command]
#[specta::specta]
pub async fn canvas_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<CanvasDeleteResponse, CommandError> {
    blocking("canvas_delete", move || {
        let success = canvases(&app)?.delete(&id, now_ms()).map_err(failed)?;
        if success {
            broadcast(&app, CanvasDeletedEvent { id });
        }
        Ok(CanvasDeleteResponse { success })
    })
    .await
}

/// `canvas:list`.
#[tauri::command]
#[specta::specta]
pub async fn canvas_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<CanvasListResponse, CommandError> {
    blocking("canvas_list", move || {
        let canvases = canvases(&app)?.list().map_err(failed)?;
        Ok(CanvasListResponse { canvases })
    })
    .await
}

/// `canvas:duplicate`: `null` when the original is gone or its document cannot be read.
#[tauri::command]
#[specta::specta]
pub async fn canvas_duplicate<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<Option<CanvasSummaryView>, CommandError> {
    blocking("canvas_duplicate", move || {
        let copy = canvases(&app)?.duplicate(&id, now_ms()).map_err(failed)?;
        Ok(copy.map(|copy| {
            announce_created(&app, &copy);
            copy.canvas.summary
        }))
    })
    .await
}

/// The document of a live canvas, `None` (logged) when it has none to point at.
fn document(app: &AppHandle<Wry>, id: &str) -> Result<Option<String>, CommandError> {
    let path = canvases(app)?.document_path(id).map_err(failed)?;
    if path.is_none() {
        tracing::warn!(scope = "CanvasIPC", %id, "no canvas document to show");
    }
    Ok(path.map(|path| path.to_string_lossy().into_owned()))
}

/// `canvas:reveal-in-finder`.
#[tauri::command]
#[specta::specta]
pub async fn canvas_reveal_in_finder(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    blocking("canvas_reveal_in_finder", move || {
        match document(&app, &id)? {
            Some(path) => external::reveal_path(&app, &path),
            None => Ok(()),
        }
    })
    .await
}

/// `canvas:open-external`: the document in the OS default app.
#[tauri::command]
#[specta::specta]
pub async fn canvas_open_external(app: AppHandle<Wry>, id: String) -> Result<(), CommandError> {
    blocking("canvas_open_external", move || match document(&app, &id)? {
        Some(path) => external::open_path(&app, &path),
        None => Ok(()),
    })
    .await
}

/// `canvas:library-list`.
#[tauri::command]
#[specta::specta]
pub async fn canvas_library_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<CanvasLibraryListResponse, CommandError> {
    blocking("canvas_library_list", move || {
        let vault = open_vault(&app)?.path;
        let library_items = read_canvas_library(&vault).map_err(|error| failed(error.into()))?;
        Ok(CanvasLibraryListResponse { library_items })
    })
    .await
}

/// `canvas:library-save`.
#[tauri::command]
#[specta::specta]
pub async fn canvas_library_save<R: Runtime>(
    app: AppHandle<R>,
    input: CanvasLibrarySaveInput,
) -> Result<CanvasLibrarySaveResponse, CommandError> {
    blocking("canvas_library_save", move || {
        // `CanvasLibraryItemSchema`: every item is an object with an id.
        let valid = input.library_items.iter().all(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty())
        });
        if !valid {
            return Err(CommandError::new(
                ErrorKind::Invalid,
                "invalid_input",
                "every canvas library item needs an id",
            ));
        }
        let vault = open_vault(&app)?.path;
        let written = write_canvas_library(&vault, &input.library_items)
            .map_err(|error| failed(error.into()))?;
        let changed = if written {
            input.library_items.len()
        } else {
            0
        };
        Ok(CanvasLibrarySaveResponse { changed })
    })
    .await
}
