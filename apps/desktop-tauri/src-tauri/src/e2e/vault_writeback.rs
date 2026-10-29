//! The vault write-back under test (Step 12e-3h, #3529): an edit made in the app the way Step
//! 14's editor will make it, and files changed the way another program changes them, on the
//! notes the app's identity (Step 13d) names from their files.
//! `e2e/specs/vault/writeback.e2e.ts` and the Windows soak (`e2e/soak/writeback-soak.ts`) drive
//! them.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use memry_desktop::e2e::E2eGate;
use memry_desktop::e2e::vault as e2e_vault;
use memry_desktop::seams::secure_store::DeviceIdentityStore;
use memry_desktop::session::{OpenVault, Session};
use memry_desktop::vault::consumer::VaultTier;
use memry_desktop::vault::hash::content_hash;
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};

use crate::commands::error::{CommandError, ErrorKind};

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

/// `rel` under the open vault; a path that leaves it, by its parts or through a link, is
/// refused.
fn in_vault(app: &AppHandle<Wry>, rel: &str) -> Result<PathBuf, CommandError> {
    let outside =
        || CommandError::new(ErrorKind::Invalid, "e2e_path_outside_vault", rel.to_owned());
    let plain = Path::new(rel)
        .components()
        .all(|part| matches!(part, Component::Normal(_)));
    if !plain {
        return Err(outside());
    }
    let root =
        std::fs::canonicalize(open(app)?.path).map_err(|error| failed("e2e_vault_root", error))?;
    let target = root.join(rel);
    // The deepest part that exists, resolved: a link anywhere on the way is followed.
    let existing = target
        .ancestors()
        .find(|part| part.exists())
        .ok_or_else(outside)?;
    let resolved =
        std::fs::canonicalize(existing).map_err(|error| failed("e2e_vault_path", error))?;
    if !resolved.starts_with(&root) {
        return Err(outside());
    }
    Ok(target)
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

/// Retypes the note's first block and schedules its write-back. It edits through
/// `NotesWriter::edit_block`, the path iOS uses; the desktop editor of Step 14 (#3531) applies
/// Yjs updates (`Editor::apply_update`), and this command moves to that path then.
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

/// Schedules the notes' write-backs without editing them, as the sync driver does after every
/// committed pull page (Step 17, #3534): a note whose file already says its body is not
/// written.
#[tauri::command]
pub fn e2e_note_schedule(app: AppHandle<Wry>, note_ids: Vec<String>) -> Result<(), CommandError> {
    let tier = tier(&app)?;
    for note_id in &note_ids {
        tier.schedule(note_id);
    }
    Ok(())
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eVaultFile {
    pub text: String,
    /// `content_hash` of the text, the hash a row records for it.
    pub content_hash: String,
    /// Modified time in ms: a rewrite with the same bytes still moves it.
    pub mtime_ms: f64,
    pub size: u64,
}

/// The file's text, hash, modified time and size, `None` when it is not there.
#[tauri::command]
pub fn e2e_vault_read_file(
    app: AppHandle<Wry>,
    path: String,
) -> Result<Option<E2eVaultFile>, CommandError> {
    let target = in_vault(&app, &path)?;
    let read = std::fs::metadata(&target).and_then(|meta| {
        let text = std::fs::read_to_string(&target)?;
        let mtime_ms = meta
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |since| since.as_secs_f64() * 1000.0);
        Ok(E2eVaultFile {
            content_hash: content_hash(&text),
            text,
            mtime_ms,
            size: meta.len(),
        })
    });
    match read {
        Ok(file) => Ok(Some(file)),
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
