//! Filesystem ops for the vault layer.
//!
//! - `atomic_write`: temp-file-then-rename pattern. Survives mid-write
//!   crash because the partial temp file is never visible at the final
//!   path. POSIX `rename(2)` is atomic on the same filesystem; on
//!   macOS the .memry-internal data DB and the vault tree are usually
//!   on the same APFS volume.
//! - `safe_read`: returns `None` for missing files, errors otherwise.
//! - `list_supported_files`: depth-first walk that skips hidden
//!   entries (`.foo`), `.memry` app-internal dir, and unsupported
//!   extensions. Output is forward-slashed vault-relative paths.
//! - `content_hash`: SHA-256 hex of UTF-8 bytes for change detection.
//!
//! All functions receive already-canonicalized absolute paths from
//! `vault::paths::resolve_in_vault` — they do NOT re-validate.

use crate::error::{AppError, AppResult};
use crate::vault::paths;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::fs;

const TEMP_PREFIX: &str = ".tmp.";

/// Atomically write `content` to `path`. Creates parent dirs as needed.
/// On failure, removes any leftover temp file in the same parent.
pub async fn atomic_write(path: &Path, content: &str) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Vault(format!("path has no parent: {}", path.display())))?;
    fs::create_dir_all(parent).await?;

    let suffix = nanoid::nanoid!(12);
    let temp_name = format!("{TEMP_PREFIX}{suffix}");
    let temp_path = parent.join(temp_name);

    let write_then_rename = async {
        fs::write(&temp_path, content).await?;
        fs::rename(&temp_path, path).await?;
        Ok::<_, AppError>(())
    };

    match write_then_rename.await {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&temp_path).await;
            Err(e)
        }
    }
}

/// Read a file as UTF-8. Returns `Ok(None)` if the file does not exist.
/// Other IO errors propagate as `AppError::Io`.
pub async fn safe_read(path: &Path) -> AppResult<Option<String>> {
    match fs::read_to_string(path).await {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::from(e)),
    }
}

/// Read a file or error if missing.
pub async fn read_required(path: &Path) -> AppResult<String> {
    safe_read(path)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("file not found: {}", path.display())))
}

/// Delete a file. No-op if it does not exist.
pub async fn delete_file(path: &Path) -> AppResult<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::from(e)),
    }
}

/// List every supported file under `vault_root`, returning forward-
/// slashed vault-relative paths sorted lexicographically. Skips:
/// - any directory or file whose basename starts with `.`
/// - the `.memry/` app-internal dir at the vault root
/// - unsupported file extensions (matches `paths::resolve_supported`)
/// - symlinks (defense in depth — `paths::resolve_in_vault` already
///   rejects symlink targets that escape, but the watcher walk skips
///   symlinks entirely so a symlink loop cannot DOS the scan)
pub async fn list_supported_files(vault_root: &Path) -> AppResult<Vec<String>> {
    let canonical_root = dunce::canonicalize(vault_root)?;
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![canonical_root.clone()];

    while let Some(dir) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(e) => return Err(AppError::from(e)),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with('.') {
                continue;
            }

            let metadata = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            let path = entry.path();
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                stack.push(path);
            } else if metadata.is_file() {
                let lower_ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| e.to_lowercase())
                    .unwrap_or_default();
                if lower_ext.is_empty() {
                    continue;
                }
                if paths::resolve_supported(&canonical_root, &format!("dummy.{lower_ext}")).is_err()
                    && !paths::is_markdown(&path)
                    && !is_supported_attachment(&lower_ext)
                {
                    continue;
                }
                if let Some(rel) = paths::to_relative_path(&canonical_root, &path) {
                    out.push(rel);
                }
            }
        }
    }

    out.sort();
    Ok(out)
}

fn is_supported_attachment(ext: &str) -> bool {
    matches!(
        ext,
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "pdf"
            | "mp3"
            | "wav"
            | "m4a"
            | "ogg"
            | "mp4"
            | "mov"
            | "webm"
    )
}

/// SHA-256 hex of `content`. Used by the watcher and notes_io to skip
/// no-op rewrites and emit `vault-changed` only on real diffs.
pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}
