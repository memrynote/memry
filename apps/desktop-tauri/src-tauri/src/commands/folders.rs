//! Folder commands. Folders are physical directories in the vault tree;
//! the optional `folder_configs` row keeps per-folder icon and template
//! metadata.
//!
//! All disk-mutating commands hold the DB connection only briefly —
//! `MutexGuard<Connection>` is `!Send` so it cannot live across `.await`
//! when Tauri's runtime ships work between threads.

use crate::app_state::AppState;
use crate::commands::notes::{note_deleted_event_payload, NOTE_DELETED_EVENT, TAGS_CHANGED_EVENT};
use crate::db::folder_configs;
use crate::db::note_positions;
use crate::error::{AppError, AppResult};
use crate::vault::{notes_io, VaultRuntime};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderDeletedNote {
    pub id: String,
    pub path: String,
    pub trash_path: String,
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
    let notes_root = notes_root_for(vault)?;
    let folders = notes_io::list_folders(&root).await?;
    let mut out = Vec::with_capacity(folders.len());
    for path in folders
        .into_iter()
        .filter_map(|path| logical_folder_path(&path, &notes_root))
    {
        let icon = folder_configs::get(conn, &path)?.and_then(|c| c.icon);
        out.push(FolderInfo { path, icon });
    }
    Ok(out)
}

pub async fn notes_create_folder_inner(vault: &VaultRuntime, path: &str) -> AppResult<()> {
    let path = validate_folder_path_no_parent(path)?;
    let root = vault.require_current()?;
    let notes_root = notes_root_for(vault)?;
    notes_io::create_folder(&root, &note_folder_path(&path, &notes_root)).await
}

pub async fn notes_rename_folder_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    old_path: &str,
    new_path: &str,
) -> AppResult<()> {
    let old_path = validate_folder_path_no_parent(old_path)?;
    let new_path = validate_folder_path_no_parent(new_path)?;
    let root = vault.require_current()?;
    let notes_root = notes_root_for(vault)?;
    notes_io::rename_folder(
        &root,
        &note_folder_path(&old_path, &notes_root),
        &note_folder_path(&new_path, &notes_root),
    )
    .await?;
    apply_rename_to_db(conn, &old_path, &new_path, &notes_root)
}

pub async fn notes_delete_folder_inner(
    conn: &Connection,
    vault: &VaultRuntime,
    path: &str,
    recursive: bool,
) -> AppResult<Vec<FolderDeletedNote>> {
    let path = validate_deletable_folder_path(path)?;
    let notes_root = notes_root_for(vault)?;
    let count = active_children_count(conn, &path, &notes_root)?;
    if count > 0 && !recursive {
        return Err(AppError::Conflict(format!("folder {path} not empty")));
    }
    let root = vault.require_current()?;
    let deleted_notes = if recursive {
        let prefix = note_folder_prefix(&path, &notes_root);
        let deleted_notes = active_child_notes_with_prefix(conn, &prefix)?;
        move_deleted_notes_to_trash(&root, deleted_notes).await?
    } else {
        Vec::new()
    };
    notes_io::delete_folder(&root, &note_folder_path(&path, &notes_root), recursive).await?;
    finalize_folder_delete(conn, &path, recursive, &notes_root, &deleted_notes)?;
    Ok(deleted_notes)
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

pub fn notes_get_folder_template_inner(conn: &Connection, path: &str) -> AppResult<Option<String>> {
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
    let notes_root = notes_root_for(&state.vault)?;
    let folders = notes_io::list_folders(&root).await?;
    let conn = state.db.conn()?;
    let mut out = Vec::with_capacity(folders.len());
    for path in folders
        .into_iter()
        .filter_map(|path| logical_folder_path(&path, &notes_root))
    {
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
    let old_path = validate_folder_path_no_parent(&old_path)?;
    let new_path = validate_folder_path_no_parent(&new_path)?;

    let root = state.vault.require_current()?;
    let notes_root = notes_root_for(&state.vault)?;
    notes_io::rename_folder(
        &root,
        &note_folder_path(&old_path, &notes_root),
        &note_folder_path(&new_path, &notes_root),
    )
    .await?;

    {
        let conn = state.db.conn()?;
        apply_rename_to_db(&conn, &old_path, &new_path, &notes_root)?;
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
    let path = validate_deletable_folder_path(&path)?;
    let notes_root = notes_root_for(&state.vault)?;
    {
        let conn = state.db.conn()?;
        let count = active_children_count(&conn, &path, &notes_root)?;
        if count > 0 && !recursive {
            return Err(AppError::Conflict(format!("folder {path} not empty")));
        }
    }

    let root = state.vault.require_current()?;
    let deleted_notes = if recursive {
        let deleted_notes = {
            let conn = state.db.conn()?;
            let prefix = note_folder_prefix(&path, &notes_root);
            active_child_notes_with_prefix(&conn, &prefix)?
        };
        move_deleted_notes_to_trash(&root, deleted_notes).await?
    } else {
        Vec::new()
    };
    notes_io::delete_folder(&root, &note_folder_path(&path, &notes_root), recursive).await?;

    {
        let conn = state.db.conn()?;
        finalize_folder_delete(&conn, &path, recursive, &notes_root, &deleted_notes)?;
    }

    for note in &deleted_notes {
        let _ = app.emit(
            NOTE_DELETED_EVENT,
            note_deleted_event_payload(&note.id, &note.path),
        );
    }
    if !deleted_notes.is_empty() {
        let _ = app.emit(TAGS_CHANGED_EVENT, serde_json::json!({}));
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
fn active_children_count(conn: &Connection, folder: &str, notes_root: &str) -> AppResult<i64> {
    let prefix = note_folder_prefix(folder, notes_root);
    active_children_count_with_prefix(conn, &prefix)
}

fn active_children_count_with_prefix(conn: &Connection, prefix: &str) -> AppResult<i64> {
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM note_metadata
            WHERE (?1 = '' OR substr(path, 1, length(?1)) = ?1)
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
fn apply_rename_to_db(
    conn: &Connection,
    old_path: &str,
    new_path: &str,
    notes_root: &str,
) -> AppResult<()> {
    let prefix_old = note_folder_prefix(old_path, notes_root);
    let prefix_new = note_folder_prefix(new_path, notes_root);
    let raw_prefix_old = raw_folder_prefix(old_path);

    conn.execute(
        "UPDATE note_metadata
            SET path = ?1 || substr(path, length(?2) + 1)
          WHERE substr(path, 1, length(?2)) = ?2",
        rusqlite::params![&prefix_new, &prefix_old],
    )?;
    conn.execute(
        "UPDATE notes_cache
            SET path = ?1 || substr(path, length(?2) + 1)
          WHERE substr(path, 1, length(?2)) = ?2",
        rusqlite::params![&prefix_new, &prefix_old],
    )?;
    conn.execute(
        "UPDATE note_positions
            SET path = ?1 || substr(path, length(?2) + 1)
          WHERE substr(path, 1, length(?2)) = ?2",
        rusqlite::params![&prefix_new, &prefix_old],
    )?;
    conn.execute(
        "UPDATE note_positions
            SET path = ?1 || substr(path, length(?2) + 1)
          WHERE path = ?2 OR substr(path, 1, length(?3)) = ?3",
        rusqlite::params![new_path, old_path, &raw_prefix_old],
    )?;
    conn.execute(
        "UPDATE note_positions
            SET folder_path = ?1 || substr(folder_path, length(?2) + 1)
          WHERE folder_path = ?2 OR substr(folder_path, 1, length(?3)) = ?3",
        rusqlite::params![new_path, old_path, &raw_prefix_old],
    )?;
    conn.execute(
        "UPDATE folder_configs
            SET path = ?1 || substr(path, length(?2) + 1)
          WHERE path = ?2 OR substr(path, 1, length(?3)) = ?3",
        rusqlite::params![new_path, old_path, &raw_prefix_old],
    )?;
    Ok(())
}

/// Drop the folder config and (when recursively deleted) tombstone every
/// child note + drop their position rows, mirroring `notes_delete_inner`.
fn finalize_folder_delete(
    conn: &Connection,
    path: &str,
    recursive: bool,
    notes_root: &str,
    deleted_notes: &[FolderDeletedNote],
) -> AppResult<()> {
    if recursive {
        let prefix = note_folder_prefix(path, notes_root);
        let raw_prefix = raw_folder_prefix(path);
        for note in deleted_notes {
            conn.execute(
                "UPDATE note_metadata
                    SET path = ?1,
                        clock = json_set(coalesce(clock, '{}'), '$.deleted_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                  WHERE id = ?2
                    AND substr(path, 1, length(?3)) = ?3
                    AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''",
                rusqlite::params![&note.trash_path, &note.id, &prefix],
            )?;
        }
        conn.execute(
            "DELETE FROM notes_cache WHERE substr(path, 1, length(?1)) = ?1",
            [&prefix],
        )?;
        conn.execute(
            "DELETE FROM note_positions WHERE substr(path, 1, length(?1)) = ?1 OR folder_path = ?2 OR substr(folder_path, 1, length(?3)) = ?3",
            rusqlite::params![&prefix, path, &raw_prefix],
        )?;
        conn.execute(
            "DELETE FROM folder_configs WHERE path = ?1 OR substr(path, 1, length(?2)) = ?2",
            rusqlite::params![path, &raw_prefix],
        )?;
    }
    folder_configs::delete(conn, path)?;
    conn.execute(
        "DELETE FROM note_positions WHERE path = ?1 OR folder_path = ?1",
        [path],
    )?;
    Ok(())
}

async fn move_deleted_notes_to_trash(
    vault_root: &Path,
    deleted_notes: Vec<FolderDeletedNote>,
) -> AppResult<Vec<FolderDeletedNote>> {
    let mut out = Vec::with_capacity(deleted_notes.len());
    for mut note in deleted_notes {
        note.trash_path = notes_io::move_note_to_trash(vault_root, &note.path, &note.id).await?;
        out.push(note);
    }
    Ok(out)
}

fn active_child_notes_with_prefix(
    conn: &Connection,
    prefix: &str,
) -> AppResult<Vec<FolderDeletedNote>> {
    let mut stmt = conn.prepare(
        "SELECT id, path FROM note_metadata
            WHERE substr(path, 1, length(?1)) = ?1
              AND coalesce(json_extract(clock, '$.deleted_at'), '') = ''
            ORDER BY path",
    )?;
    let rows = stmt.query_map([prefix], |row| {
        Ok(FolderDeletedNote {
            id: row.get(0)?,
            path: row.get(1)?,
            trash_path: String::new(),
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn note_folder_prefix(path: &str, notes_root: &str) -> String {
    let raw = normalize_folder_input(path);
    let root = normalized_notes_root(notes_root);
    if raw.is_empty() {
        format!("{root}/")
    } else {
        format!("{root}/{raw}/")
    }
}

fn note_folder_path(path: &str, notes_root: &str) -> String {
    let raw = normalize_folder_input(path);
    let root = normalized_notes_root(notes_root);
    if raw.is_empty() {
        root
    } else {
        format!("{root}/{raw}")
    }
}

fn logical_folder_path(path: &str, notes_root: &str) -> Option<String> {
    let raw = normalize_folder_input(path);
    let root = normalized_notes_root(notes_root);
    if raw == root || raw.is_empty() {
        return None;
    }
    raw.strip_prefix(&format!("{root}/"))
        .map(|path| path.trim_matches('/').to_string())
        .filter(|path| !path.is_empty())
}

fn notes_root_for(vault: &VaultRuntime) -> AppResult<String> {
    let root = vault.require_current()?;
    let configured = crate::vault::preferences::read_config(&root)?.default_note_folder;
    Ok(normalized_notes_root(&configured))
}

fn normalized_notes_root(notes_root: &str) -> String {
    let trimmed = notes_root.trim().trim_matches('/');
    if trimmed.is_empty() {
        "notes".into()
    } else {
        trimmed.to_string()
    }
}

fn raw_folder_prefix(path: &str) -> String {
    let path = normalize_folder_input(path);
    if path.is_empty() {
        String::new()
    } else {
        format!("{path}/")
    }
}

fn normalize_folder_input(path: &str) -> String {
    path.trim().replace('\\', "/").trim_matches('/').to_string()
}

fn single_string_arg(args: Vec<String>, name: &str) -> AppResult<String> {
    match args.as_slice() {
        [value] => Ok(value.clone()),
        _ => Err(AppError::Validation(format!(
            "{name} expects exactly one argument"
        ))),
    }
}

fn validate_deletable_folder_path(path: &str) -> AppResult<String> {
    let path = validate_folder_path_no_parent(path)?;
    if path.is_empty() || path == "." {
        return Err(AppError::Validation("folder path cannot be root".into()));
    }
    Ok(path)
}

fn validate_folder_path_no_parent(path: &str) -> AppResult<String> {
    let path = normalize_folder_input(path);
    if path.split('/').any(|component| component == "..") {
        return Err(AppError::Validation("folder path cannot contain ..".into()));
    }
    Ok(path)
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
