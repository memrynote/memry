//! Folder commands. Folders are physical directories in the vault tree;
//! the optional `folder_configs` row keeps per-folder icon and template
//! metadata.
//!
//! All disk-mutating commands hold the DB connection only briefly —
//! `MutexGuard<Connection>` is `!Send` so it cannot live across `.await`
//! when Tauri's runtime ships work between threads.

use crate::app_state::AppState;
use crate::db::folder_configs;
use crate::db::note_positions;
use crate::error::{AppError, AppResult};
use crate::vault::{notes_io, VaultRuntime};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub path: String,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FolderSimpleSuccess {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFolderInput {
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SetFolderConfigInput {
    pub path: String,
    pub icon: Option<String>,
    pub template_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReorderInput {
    pub folder_path: String,
    pub note_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PositionsResponse {
    pub success: bool,
    pub positions: HashMap<String, i64>,
}

// ---- Inner helpers (called from tests, runtime, and Tauri wrappers) -------

pub async fn notes_get_folders_inner(
    conn: &Connection,
    vault: &VaultRuntime,
) -> AppResult<Vec<FolderInfo>> {
    let root = vault.require_current()?;
    let folders = notes_io::list_folders(&root).await?;
    let mut out = Vec::with_capacity(folders.len());
    for path in folders {
        let icon = folder_configs::get(conn, &path)?.and_then(|c| c.icon);
        out.push(FolderInfo { path, icon });
    }
    Ok(out)
}

pub async fn notes_create_folder_inner(vault: &VaultRuntime, path: &str) -> AppResult<()> {
    let root = vault.require_current()?;
    notes_io::create_folder(&root, path).await
}

pub async fn notes_rename_folder_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    old_path: &str,
    new_path: &str,
) -> AppResult<()> {
    let root = vault.require_current()?;
    notes_io::rename_folder(&root, old_path, new_path).await?;
    apply_rename_to_db(conn, old_path, new_path)
}

pub async fn notes_delete_folder_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    path: &str,
    recursive: bool,
) -> AppResult<()> {
    let count = active_children_count(conn, path)?;
    if count > 0 && !recursive {
        return Err(AppError::Conflict(format!("folder {path} not empty")));
    }
    let root = vault.require_current()?;
    notes_io::delete_folder(&root, path, recursive).await?;
    finalize_folder_delete(conn, path, recursive)
}

pub fn notes_get_folder_config_inner(
    conn: &Connection,
    path: &str,
) -> AppResult<Option<folder_configs::FolderConfig>> {
    folder_configs::get(conn, path)
}

pub fn notes_set_folder_config_inner(
    conn: &Connection,
    input: SetFolderConfigInput,
) -> AppResult<()> {
    folder_configs::set(
        conn,
        &folder_configs::FolderConfigRow {
            path: input.path,
            icon: input.icon,
            template_json: input.template_json,
        },
    )
}

pub fn notes_get_folder_template_inner(
    conn: &Connection,
    path: &str,
) -> AppResult<Option<String>> {
    folder_configs::get_template_inherited(conn, path)
}

pub fn notes_get_positions_inner(
    conn: &Connection,
    folder_path: &str,
) -> AppResult<HashMap<String, i64>> {
    note_positions::get_for_folder(conn, folder_path)
}

pub fn notes_get_all_positions_inner(conn: &Connection) -> AppResult<HashMap<String, i64>> {
    note_positions::get_all(conn)
}

pub fn notes_reorder_inner(
    conn: &Connection,
    folder_path: &str,
    note_paths: &[String],
) -> AppResult<()> {
    note_positions::reorder(conn, folder_path, note_paths)
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn notes_get_folders(state: State<'_, AppState>) -> AppResult<Vec<FolderInfo>> {
    let root = state.vault.require_current()?;
    let folders = notes_io::list_folders(&root).await?;
    let conn = state.db.conn()?;
    let mut out = Vec::with_capacity(folders.len());
    for path in folders {
        let icon = folder_configs::get(&conn, &path)?.and_then(|c| c.icon);
        out.push(FolderInfo { path, icon });
    }
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn notes_create_folder(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<FolderSimpleSuccess> {
    let path = single_string_arg(args, "path")?;
    notes_create_folder_inner(&state.vault, &path).await?;
    Ok(FolderSimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub async fn notes_rename_folder(
    state: State<'_, AppState>,
    app: AppHandle,
    args: Vec<String>,
) -> AppResult<FolderSimpleSuccess> {
    let (old_path, new_path) =
        two_string_args(args, "notes_rename_folder", "old_path", "new_path")?;

    let root = state.vault.require_current()?;
    notes_io::rename_folder(&root, &old_path, &new_path).await?;

    {
        let conn = state.db.conn()?;
        apply_rename_to_db(&conn, &old_path, &new_path)?;
    }

    let _ = app.emit(
        "notes:folder-renamed",
        serde_json::json!({ "oldPath": old_path, "newPath": new_path, "source": "internal" }),
    );
    Ok(FolderSimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub async fn notes_delete_folder(
    state: State<'_, AppState>,
    app: AppHandle,
    input: DeleteFolderInput,
) -> AppResult<FolderSimpleSuccess> {
    let DeleteFolderInput { path, recursive } = input;
    {
        let conn = state.db.conn()?;
        let count = active_children_count(&conn, &path)?;
        if count > 0 && !recursive {
            return Err(AppError::Conflict(format!("folder {path} not empty")));
        }
    }

    let root = state.vault.require_current()?;
    notes_io::delete_folder(&root, &path, recursive).await?;

    {
        let conn = state.db.conn()?;
        finalize_folder_delete(&conn, &path, recursive)?;
    }

    let _ = app.emit(
        "notes:folder-deleted",
        serde_json::json!({ "path": path, "recursive": recursive, "source": "internal" }),
    );
    Ok(FolderSimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub fn notes_get_folder_config(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<Option<folder_configs::FolderConfig>> {
    let path = single_string_arg(args, "path")?;
    let conn = state.db.conn()?;
    notes_get_folder_config_inner(&conn, &path)
}

#[tauri::command]
#[specta::specta]
pub fn notes_set_folder_config(
    state: State<'_, AppState>,
    input: SetFolderConfigInput,
) -> AppResult<FolderSimpleSuccess> {
    let conn = state.db.conn()?;
    notes_set_folder_config_inner(&conn, input)?;
    Ok(FolderSimpleSuccess { success: true })
}

#[tauri::command]
#[specta::specta]
pub fn notes_get_folder_template(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<Option<String>> {
    let path = single_string_arg(args, "path")?;
    let conn = state.db.conn()?;
    notes_get_folder_template_inner(&conn, &path)
}

#[tauri::command]
#[specta::specta]
pub fn notes_get_positions(
    state: State<'_, AppState>,
    args: Vec<String>,
) -> AppResult<PositionsResponse> {
    let folder_path = single_string_arg(args, "folder_path")?;
    let conn = state.db.conn()?;
    let positions = notes_get_positions_inner(&conn, &folder_path)?;
    Ok(PositionsResponse {
        success: true,
        positions,
    })
}

#[tauri::command]
#[specta::specta]
pub fn notes_get_all_positions(state: State<'_, AppState>) -> AppResult<PositionsResponse> {
    let conn = state.db.conn()?;
    let positions = notes_get_all_positions_inner(&conn)?;
    Ok(PositionsResponse {
        success: true,
        positions,
    })
}

#[tauri::command]
#[specta::specta]
pub fn notes_reorder(
    state: State<'_, AppState>,
    input: ReorderInput,
) -> AppResult<FolderSimpleSuccess> {
    let conn = state.db.conn()?;
    notes_reorder_inner(&conn, &input.folder_path, &input.note_paths)?;
    Ok(FolderSimpleSuccess { success: true })
}

// ---- Internal helpers -----------------------------------------------------

/// Count children of `folder` that are still active (not soft-deleted).
fn active_children_count(conn: &Connection, folder: &str) -> AppResult<i64> {
    let prefix = folder_prefix(folder);
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM note_metadata
            WHERE path LIKE ?1 || '%'
              AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
        [&prefix],
        |r| r.get(0),
    )?;
    Ok(count)
}

/// Bulk-rewrite every metadata path under `old/` to live under `new/`.
/// `notes_cache.path`, `note_positions.path` + `folder_path`, and any
/// nested `folder_configs.path` are updated to keep cross-table state
/// consistent so a follow-up read does not see stale paths.
fn apply_rename_to_db(conn: &Connection, old_path: &str, new_path: &str) -> AppResult<()> {
    let prefix_old = folder_prefix(old_path);
    let prefix_new = folder_prefix(new_path);
    let prefix_old_len = prefix_old.len() as i64;

    conn.execute(
        "UPDATE note_metadata
            SET path = ?1 || substr(path, ?2 + 1)
          WHERE path LIKE ?3 || '%'",
        rusqlite::params![&prefix_new, prefix_old_len, &prefix_old],
    )?;
    conn.execute(
        "UPDATE notes_cache
            SET path = ?1 || substr(path, ?2 + 1)
          WHERE path LIKE ?3 || '%'",
        rusqlite::params![&prefix_new, prefix_old_len, &prefix_old],
    )?;
    conn.execute(
        "UPDATE note_positions
            SET path = ?1 || substr(path, ?2 + 1)
          WHERE path LIKE ?3 || '%'",
        rusqlite::params![&prefix_new, prefix_old_len, &prefix_old],
    )?;
    conn.execute(
        "UPDATE note_positions
            SET folder_path = ?1 || substr(folder_path, ?2 + 1)
          WHERE folder_path = ?3 OR folder_path LIKE ?4 || '%'",
        rusqlite::params![new_path, old_path.len() as i64, old_path, &prefix_old],
    )?;
    conn.execute(
        "UPDATE folder_configs
            SET path = ?1 || substr(path, ?2 + 1)
          WHERE path = ?3 OR path LIKE ?4 || '%'",
        rusqlite::params![new_path, old_path.len() as i64, old_path, &prefix_old],
    )?;
    Ok(())
}

/// Drop the folder config and (when recursively deleted) tombstone every
/// child note + drop their position rows, mirroring `notes_delete_inner`.
fn finalize_folder_delete(conn: &Connection, path: &str, recursive: bool) -> AppResult<()> {
    if recursive {
        let prefix = folder_prefix(path);
        conn.execute(
            "UPDATE note_metadata
                SET clock = json_set(coalesce(clock, '{}'), '$.deleted_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE path LIKE ?1 || '%'
                AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
            [&prefix],
        )?;
        conn.execute(
            "DELETE FROM notes_cache WHERE path LIKE ?1 || '%'",
            [&prefix],
        )?;
        conn.execute(
            "DELETE FROM note_positions WHERE path LIKE ?1 || '%' OR folder_path = ?2 OR folder_path LIKE ?1 || '%'",
            [&prefix, path],
        )?;
        conn.execute(
            "DELETE FROM folder_configs WHERE path LIKE ?1 || '%'",
            [&prefix],
        )?;
    }
    folder_configs::delete(conn, path)?;
    conn.execute(
        "DELETE FROM note_positions WHERE folder_path = ?1",
        [path],
    )?;
    Ok(())
}

fn folder_prefix(path: &str) -> String {
    if path.is_empty() {
        String::new()
    } else {
        format!("{path}/")
    }
}

fn single_string_arg(args: Vec<String>, name: &str) -> AppResult<String> {
    match args.as_slice() {
        [value] => Ok(value.clone()),
        _ => Err(AppError::Validation(format!(
            "{name} expects exactly one argument"
        ))),
    }
}

fn two_string_args(
    args: Vec<String>,
    command: &str,
    first: &str,
    second: &str,
) -> AppResult<(String, String)> {
    match args.as_slice() {
        [a, b] => Ok((a.clone(), b.clone())),
        _ => Err(AppError::Validation(format!(
            "{command} expects exactly two arguments ({first}, {second})"
        ))),
    }
}
