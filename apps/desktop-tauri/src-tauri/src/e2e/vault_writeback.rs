//! The vault write-back under test (Step 12e-3h, #3529): notes with rows before Step 13 names
//! them, an edit made in the app the way Step 14's editor will make it, and files changed the
//! way another program changes them. `e2e/specs/vault/writeback.e2e.ts` and the Windows soak
//! (`e2e/soak/writeback-soak.ts`) drive them.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use memry_desktop::e2e::E2eGate;
use memry_desktop::e2e::vault::{self as e2e_vault, AdoptFiles};
use memry_desktop::launch_env::LaunchEnv;
use memry_desktop::paths::AppPaths;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenSource, OpenVault, Session};
use memry_desktop::vault::consumer::VaultTier;
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};

/// In the data dir: the next launches adopt files too, so a relaunch keeps naming notes.
const ADOPT_MARKER: &str = "e2e-adopt-files";

fn failed(code: &'static str, error: impl ToString) -> CommandError {
    CommandError::new(ErrorKind::Internal, code, error.to_string())
}

fn store(app: &AppHandle<Wry>) -> Result<Arc<DeviceIdentityStore>, CommandError> {
    let store = app
        .try_state::<Arc<DeviceIdentityStore>>()
        .ok_or_else(|| failed("e2e_no_device_store", "no device identity store"))?;
    Ok(store.inner().clone())
}

fn tier(app: &AppHandle<Wry>) -> Result<Arc<VaultTier>, CommandError> {
    let tier = app
        .try_state::<Arc<VaultTier>>()
        .ok_or_else(|| failed("e2e_no_vault_tier", "the vault tier is not running"))?;
    Ok(tier.inner().clone())
}

fn open(app: &AppHandle<Wry>) -> Result<OpenVault, CommandError> {
    app.state::<Session>()
        .current()
        .ok_or_else(|| failed("e2e_no_vault", "no vault is open"))
}

/// `rel` under the open vault; a path that leaves it is refused.
fn in_vault(app: &AppHandle<Wry>, rel: &str) -> Result<PathBuf, CommandError> {
    let inside = Path::new(rel)
        .components()
        .all(|part| matches!(part, Component::Normal(_)));
    if !inside {
        return Err(CommandError::new(
            ErrorKind::Invalid,
            "e2e_path_outside_vault",
            rel.to_owned(),
        ));
    }
    Ok(open(app)?.path.join(rel))
}

/// Called before the first open: a launch after `e2e_vault_adopt_files` adopts files too.
pub fn adopt_at_launch(app: &AppHandle<Wry>, tier: &VaultTier, store: Arc<DeviceIdentityStore>) {
    let gate = E2eGate::from_env(&app.state::<LaunchEnv>());
    let marker = app.state::<AppPaths>().data_dir.join(ADOPT_MARKER);
    if gate.is_open() && marker.exists() {
        tier.set_identity(AdoptFiles::new(store));
    }
}

/// Every new markdown file becomes a note, from now and at every later launch of this
/// profile. The open vault is opened again, so its files are offered at once.
#[tauri::command]
pub async fn e2e_vault_adopt_files(app: AppHandle<Wry>) -> Result<(), CommandError> {
    let marker = app.state::<AppPaths>().data_dir.join(ADOPT_MARKER);
    std::fs::write(&marker, b"").map_err(|error| failed("e2e_adopt_marker", error))?;
    tier(&app)?.set_identity(AdoptFiles::new(store(&app)?));
    let path = open(&app)?.path;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Session>().replace(&path, OpenSource::Select)
    })
    .await
    .map_err(|error| failed("e2e_adopt_reopen", error))?
    .map_err(|error| failed("e2e_adopt_reopen", error))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eNoteFile {
    pub note_id: String,
    pub path: String,
    pub content_hash: Option<String>,
}

/// The rows of the open vault.
#[tauri::command]
pub fn e2e_vault_note_files(app: AppHandle<Wry>) -> Result<Vec<E2eNoteFile>, CommandError> {
    let rows = e2e_vault::note_files(&open(&app)?.vault)
        .map_err(|error| failed("e2e_note_files", error))?;
    Ok(rows
        .into_iter()
        .map(|(note_id, path, content_hash)| E2eNoteFile {
            note_id,
            path,
            content_hash,
        })
        .collect())
}

/// Retypes the note's first block, as the editor does, and schedules its write-back.
#[tauri::command]
pub async fn e2e_note_edit(
    app: AppHandle<Wry>,
    note_id: String,
    text: String,
) -> Result<(), CommandError> {
    let vault = open(&app)?.vault;
    let (store, tier) = (store(&app)?, tier(&app)?);
    tauri::async_runtime::spawn_blocking(move || {
        e2e_vault::edit_first_block(&vault, store, &note_id, &text)
            .map_err(|error| failed("e2e_note_edit", error))?;
        tier.schedule(&note_id);
        Ok(())
    })
    .await
    .map_err(|error| failed("e2e_note_edit", error))?
}

/// The text of the note's body, block by block, one line each.
#[tauri::command]
pub fn e2e_note_body(app: AppHandle<Wry>, note_id: String) -> Result<String, CommandError> {
    e2e_vault::body_text(&open(&app)?.vault, &note_id)
        .map_err(|error| failed("e2e_note_body", error))
}

/// Writes a vault file as another program does: not through the own-write record, so the
/// watcher reports it. `replace` writes a side file and renames it over, as editors that save
/// atomically do.
#[tauri::command]
pub fn e2e_vault_write_outside(
    app: AppHandle<Wry>,
    path: String,
    text: String,
    replace: bool,
) -> Result<(), CommandError> {
    let target = in_vault(&app, &path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| failed("e2e_write_outside", error))?;
    }
    let written = if replace {
        let side = target.with_extension("md.e2e-save");
        std::fs::write(&side, text).and_then(|()| std::fs::rename(&side, &target))
    } else {
        std::fs::write(&target, text)
    };
    written.map_err(|error| failed("e2e_write_outside", error))
}

/// The file's text, `None` when it is not there.
#[tauri::command]
pub fn e2e_vault_read_file(
    app: AppHandle<Wry>,
    path: String,
) -> Result<Option<String>, CommandError> {
    match std::fs::read_to_string(in_vault(&app, &path)?) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(failed("e2e_read_file", error)),
    }
}

/// `[NSApp terminate:]`, which is what Cmd+Q and the Dock's Quit send (macOS only).
#[tauri::command]
pub fn e2e_app_terminate(app: AppHandle<Wry>) -> Result<(), CommandError> {
    #[cfg(target_os = "macos")]
    {
        app.run_on_main_thread(|| {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                objc2_app_kit::NSApplication::sharedApplication(mtm).terminate(None);
            }
        })
        .map_err(|error| failed("e2e_app_terminate", error))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(CommandError::new(
            ErrorKind::Invalid,
            "e2e_app_terminate",
            "macOS only",
        ))
    }
}
