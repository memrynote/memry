//! Files dropped from the OS arrive as DOM `File` objects with no path. The renderer streams
//! each one here in chunks, imports the staged path, and releases it (`shell/drop_stage.rs`).
//! WebKitGTK hands the page no file at all; `drop_os_drag_uris` names the files of the OS drag and
//! `drop_stage_os_files` stages them.

use std::sync::Arc;
use std::time::Instant;

use memry_desktop::shell::drop_stage::DropStaging;
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Request;

use super::blocking;
use super::error::{CommandError, ErrorKind};
use crate::binary;
use crate::shell::drop_stage::stage_error;

type Staging<'a> = State<'a, Arc<DropStaging>>;

/// Starts a staged copy of a dropped file. Returns the id the other calls take.
#[tauri::command]
#[specta::specta]
pub async fn drop_stage_begin(
    staging: Staging<'_>,
    name: String,
    size: u64,
) -> Result<String, CommandError> {
    let staging = Arc::clone(&staging);
    blocking("drop_stage_begin", move || {
        staging.begin(&name, size).map_err(stage_error)
    })
    .await
}

/// Closes a staged copy once every byte arrived and returns its absolute path.
#[tauri::command]
#[specta::specta]
pub async fn drop_stage_finish(staging: Staging<'_>, id: String) -> Result<String, CommandError> {
    let staging = Arc::clone(&staging);
    blocking("drop_stage_finish", move || {
        staging
            .finish(&id)
            .map(|path| path.to_string_lossy().into_owned())
            .map_err(stage_error)
    })
    .await
}

/// Deletes staged copies after their import settled.
#[tauri::command]
#[specta::specta]
pub async fn drop_stage_release(
    staging: Staging<'_>,
    ids: Vec<String>,
) -> Result<(), CommandError> {
    let staging = Arc::clone(&staging);
    blocking("drop_stage_release", move || {
        staging.release(&ids).map_err(|error| {
            CommandError::new(ErrorKind::Storage, "drop_release", error.to_string())
        })
    })
    .await
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StagedDrop {
    pub id: String,
    pub path: String,
}

/// The `file://` URIs of the files just dropped on the window from the OS, which WebKitGTK hides
/// from the page. `drop_not_dropped` unless a drop happened within the last few seconds.
#[tauri::command]
#[specta::specta]
pub fn drop_os_drag_uris(staging: Staging<'_>) -> Result<Vec<String>, CommandError> {
    staging.os_drop_uris(Instant::now()).map_err(stage_error)
}

/// Stages copies of files just dropped from the OS, named by the URIs `drop_os_drag_uris` gave.
/// Only files of that drop are staged (`os_drag.rs` in memry-desktop); all or nothing.
#[tauri::command]
#[specta::specta]
pub async fn drop_stage_os_files(
    staging: Staging<'_>,
    uris: Vec<String>,
) -> Result<Vec<StagedDrop>, CommandError> {
    let staging = Arc::clone(&staging);
    blocking("drop_stage_os_files", move || {
        let staged = staging
            .stage_os_drop(&uris, Instant::now())
            .map_err(stage_error)?;
        Ok(staged
            .into_iter()
            .map(|(id, path)| StagedDrop {
                id,
                path: path.to_string_lossy().into_owned(),
            })
            .collect())
    })
    .await
}

#[derive(Deserialize)]
struct ChunkMeta {
    id: String,
    offset: u64,
}

/// One chunk of a staged copy: the raw request body, with `{ id, offset }` in the metadata
/// header (`invokeBinary`). Listed in `binary::COMMANDS`; not a specta command.
#[tauri::command]
pub async fn drop_stage_chunk(
    staging: Staging<'_>,
    request: Request<'_>,
) -> Result<(), CommandError> {
    let meta: ChunkMeta = binary::meta(&request)?;
    let body = binary::raw_body(&request)?.to_vec();
    let staging = Arc::clone(&staging);
    blocking("drop_stage_chunk", move || {
        staging
            .write_chunk(&meta.id, meta.offset, &body)
            .map_err(stage_error)
    })
    .await
}
