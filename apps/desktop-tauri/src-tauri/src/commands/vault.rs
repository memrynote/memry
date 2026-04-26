//! Vault command surface. Thin async wrappers over `vault::*` modules.
//!
//! Every command takes a single named-input struct. Path-bearing
//! commands always go through `paths::resolve_*` before any FS call —
//! the renderer can never poke a path outside the open vault.
//!
//! The commands fall into three groups:
//! 1. lifecycle: open, close, get_status, get_current
//! 2. registry: get_all, switch, remove
//! 3. note IO: list_notes, read_note, write_note, delete_note,
//!    get_config, update_config, reveal, reindex (no-op until M7)

use crate::app_state::AppState;
use crate::error::AppResult;
use crate::vault::{
    frontmatter::NoteFrontmatter, fs as vfs, notes_io, preferences, registry::VaultInfo,
    state::VaultStatus, watcher,
};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenInput {
    pub path: String,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultOpenOutput {
    pub success: bool,
    pub vault: Option<VaultInfo>,
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_open(
    state: State<'_, AppState>,
    app: AppHandle,
    input: VaultOpenInput,
) -> AppResult<VaultOpenOutput> {
    let target = PathBuf::from(&input.path);
    if !target.is_dir() {
        return Ok(VaultOpenOutput {
            success: false,
            vault: None,
            error: Some(format!("not a directory: {}", input.path)),
        });
    }
    if let Err(e) = std::fs::metadata(&target).and_then(|m| {
        if m.permissions().readonly() {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "vault path is read-only",
            ))
        } else {
            Ok(())
        }
    }) {
        return Ok(VaultOpenOutput {
            success: false,
            vault: None,
            error: Some(e.to_string()),
        });
    }

    preferences::init_vault(&target)?;
    state.vault.set_indexing(true, 0);

    // Stop any prior watcher.
    {
        let mut slot = state
            .vault
            .watcher_slot
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        slot.take();
    }

    state.vault.set_current(Some(target.clone()))?;

    // Compute counts cheaply for the registry blurb.
    let cfg = preferences::read_config(&target)?;
    let note_count = preferences::count_markdown_files(&target, &cfg.exclude_patterns);

    let info = VaultInfo {
        path: target.to_string_lossy().into_owned(),
        name: preferences::vault_name(&target),
        note_count,
        task_count: 0,
        last_opened: now_iso(),
        is_default: state.vault.registry_snapshot().vaults.is_empty(),
    };
    state.vault.upsert_registry(info.clone())?;
    state.vault.touch_registry(&info.path)?;

    // Start watcher.
    let app_handle = app.clone();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let handle = watcher::start(&target, tx)?;
    {
        let mut slot = state
            .vault
            .watcher_slot
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        *slot = Some(handle);
    }
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = app_handle.emit("vault-changed", &event);
        }
    });

    state.vault.set_indexing(false, 100);

    let _ = app.emit("vault-status-changed", &state.vault.status());

    Ok(VaultOpenOutput {
        success: true,
        vault: Some(info),
        error: None,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn vault_close(state: State<'_, AppState>, app: AppHandle) -> AppResult<()> {
    {
        let mut slot = state
            .vault
            .watcher_slot
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        slot.take();
    }
    state.vault.set_current(None)?;
    state.vault.set_indexing(false, 0);
    let _ = app.emit("vault-status-changed", &state.vault.status());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn vault_get_status(state: State<'_, AppState>) -> AppResult<VaultStatus> {
    Ok(state.vault.status())
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultCurrent {
    pub path: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_get_current(state: State<'_, AppState>) -> AppResult<VaultCurrent> {
    Ok(VaultCurrent {
        path: state
            .vault
            .current_path()
            .map(|p| p.to_string_lossy().into_owned()),
    })
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultGetAllOutput {
    pub vaults: Vec<VaultInfo>,
    pub current_vault: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_get_all(state: State<'_, AppState>) -> AppResult<VaultGetAllOutput> {
    let snap = state.vault.registry_snapshot();
    Ok(VaultGetAllOutput {
        vaults: snap.vaults,
        current_vault: snap.current,
    })
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultPathInput {
    pub path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_switch(
    state: State<'_, AppState>,
    app: AppHandle,
    input: VaultPathInput,
) -> AppResult<VaultOpenOutput> {
    vault_open(state, app, VaultOpenInput { path: input.path }).await
}

#[tauri::command]
#[specta::specta]
pub async fn vault_remove(
    state: State<'_, AppState>,
    app: AppHandle,
    input: VaultPathInput,
) -> AppResult<()> {
    let current = state.vault.current_path();
    if current.as_ref().map(|p| p.to_string_lossy().into_owned()) == Some(input.path.clone()) {
        let _ = vault_close(state.clone(), app.clone()).await;
    }
    state.vault.remove_from_registry(&input.path)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn vault_get_config(state: State<'_, AppState>) -> AppResult<preferences::VaultConfig> {
    let path = state.vault.require_current()?;
    preferences::read_config(&path)
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultUpdateConfigInput {
    pub exclude_patterns: Option<Vec<String>>,
    pub default_note_folder: Option<String>,
    pub journal_folder: Option<String>,
    pub attachments_folder: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_update_config(
    state: State<'_, AppState>,
    input: VaultUpdateConfigInput,
) -> AppResult<preferences::VaultConfig> {
    let path = state.vault.require_current()?;
    let mut cfg = preferences::read_config(&path)?;
    if let Some(p) = input.exclude_patterns {
        cfg.exclude_patterns = p;
    }
    if let Some(s) = input.default_note_folder {
        cfg.default_note_folder = s;
    }
    if let Some(s) = input.journal_folder {
        cfg.journal_folder = s;
    }
    if let Some(s) = input.attachments_folder {
        cfg.attachments_folder = s;
    }
    preferences::update_config(&path, &cfg)
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultListNotesOutput {
    pub paths: Vec<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_list_notes(state: State<'_, AppState>) -> AppResult<VaultListNotesOutput> {
    let path = state.vault.require_current()?;
    let entries = vfs::list_supported_files(&path).await?;
    let only_md: Vec<String> = entries
        .into_iter()
        .filter(|p| p.ends_with(".md") || p.ends_with(".markdown"))
        .collect();
    Ok(VaultListNotesOutput { paths: only_md })
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultReadNoteInput {
    pub relative_path: String,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_read_note(
    state: State<'_, AppState>,
    input: VaultReadNoteInput,
) -> AppResult<Option<notes_io::ReadNoteResult>> {
    let root = state.vault.require_current()?;
    notes_io::read_note_from_disk(&root, &input.relative_path).await
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultWriteNoteInput {
    pub relative_path: String,
    pub frontmatter: NoteFrontmatter,
    pub content: String,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_write_note(
    state: State<'_, AppState>,
    input: VaultWriteNoteInput,
) -> AppResult<notes_io::NoteOnDisk> {
    let root = state.vault.require_current()?;
    notes_io::write_note_to_disk(
        &root,
        &input.relative_path,
        &input.frontmatter,
        &input.content,
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn vault_delete_note(
    state: State<'_, AppState>,
    input: VaultReadNoteInput,
) -> AppResult<()> {
    let root = state.vault.require_current()?;
    notes_io::delete_note_from_disk(&root, &input.relative_path).await
}

#[tauri::command]
#[specta::specta]
pub async fn vault_reveal(state: State<'_, AppState>) -> AppResult<()> {
    let path = state.vault.require_current()?;
    crate::commands::shell::reveal_in_finder_inner(&path)
}

/// Deferred to M7 (rebuildable index.db). Returns a fixed payload so
/// the renderer's settings UI can render its "reindex" button without
/// breaking in production.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultReindexOutput {
    pub success: bool,
    pub files_indexed: i64,
    pub duration: i64,
    pub deferred_until: String,
}

#[tauri::command]
#[specta::specta]
pub async fn vault_reindex(_state: State<'_, AppState>) -> AppResult<VaultReindexOutput> {
    Ok(VaultReindexOutput {
        success: true,
        files_indexed: 0,
        duration: 0,
        deferred_until: "M7".into(),
    })
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    crate::vault::frontmatter_iso(secs)
}
