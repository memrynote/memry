//! Editor-adjacent commands that ship metadata-only in M5. Upload/download
//! blob storage lives in M6. Export/PDF/HTML/versions/import live in M8.
//! Open/reveal graduate now by delegating to the shell/path helpers.

use crate::app_state::AppState;
use crate::db::note_metadata::NoteMetadata;
use crate::error::{AppError, AppResult};
use crate::vault::{paths as vault_paths, VaultRuntime};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub id: String,
    pub path: String,
    pub absolute_path: String,
    pub title: String,
    pub file_type: String,
    pub mime_type: Option<String>,
    pub file_size: Option<i64>,
    pub created: String,
    pub modified: String,
}

#[tauri::command]
#[specta::specta]
pub fn notes_get_file(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<Option<FileMetadata>> {
    let id = single_string_arg(args, "notes_get_file")?;
    notes_get_file_inner(&state, &id)
}

pub fn notes_get_file_inner(state: &AppState, id: &str) -> AppResult<Option<FileMetadata>> {
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_active_by_id(&conn, id)?
    };
    let Some(row) = row else {
        return Ok(None);
    };
    file_metadata_from_row(&state.vault, row)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_open_external(
    state: State<'_, AppState>,
    app: AppHandle,
    args: Vec<String>,
) -> AppResult<()> {
    let id = single_string_arg(args, "notes_open_external")?;
    notes_open_external_inner(&state, &id, |path| {
        crate::commands::shell::open_path_inner(&app, path)
    })
}

pub fn notes_open_external_inner(
    state: &AppState,
    id: &str,
    opener: impl FnOnce(&Path) -> AppResult<()>,
) -> AppResult<()> {
    let abs = resolve_note_path(state, id)?;
    opener(&abs)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_reveal_in_finder(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<()> {
    let id = single_string_arg(args, "notes_reveal_in_finder")?;
    notes_reveal_in_finder_inner(&state, &id, crate::commands::shell::reveal_path_inner)
}

pub fn notes_reveal_in_finder_inner(
    state: &AppState,
    id: &str,
    revealer: impl FnOnce(&Path) -> AppResult<()>,
) -> AppResult<()> {
    let abs = resolve_note_path(state, id)?;
    revealer(&abs)
}

fn file_metadata_from_row(
    vault: &VaultRuntime,
    row: NoteMetadata,
) -> AppResult<Option<FileMetadata>> {
    if row.file_type == "markdown" {
        return Ok(None);
    }

    let abs = resolve_row_path(vault, &row)?;
    if !abs.exists() {
        return Ok(None);
    }

    Ok(Some(FileMetadata {
        id: row.id,
        path: row.path,
        absolute_path: abs.to_string_lossy().into_owned(),
        title: row.title,
        file_type: row.file_type,
        mime_type: row.mime_type,
        file_size: row.file_size,
        created: row.created_at,
        modified: row.modified_at,
    }))
}

fn resolve_note_path(state: &AppState, id: &str) -> AppResult<PathBuf> {
    let row = {
        let conn = state.db.conn()?;
        crate::db::note_metadata::get_active_by_id(&conn, id)?
    }
    .ok_or_else(|| AppError::NotFound(format!("note {id}")))?;

    resolve_row_path(&state.vault, &row)
}

fn resolve_row_path(vault: &VaultRuntime, row: &NoteMetadata) -> AppResult<PathBuf> {
    let root = vault.require_current()?;
    vault_paths::resolve_supported(&root, &row.path)
}

fn single_string_arg(args: Vec<String>, name: &str) -> AppResult<String> {
    match args.as_slice() {
        [value] => Ok(value.clone()),
        _ => Err(AppError::Validation(format!(
            "{name} expects exactly one argument"
        ))),
    }
}
