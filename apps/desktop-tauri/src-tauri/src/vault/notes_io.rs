//! High-level note IO. Composes path resolution, atomic write, and
//! frontmatter parse/serialize into the operations Tauri commands
//! call directly.
//!
//! - `read_note_from_disk` returns `None` on missing path. If the
//!   on-disk file is missing required frontmatter fields, this writes
//!   the repaired version back via atomic_write so subsequent reads
//!   do not have to repeat the auto-fill — matches Electron's behavior
//!   in `vault/notes.ts::ensureFrontmatter`.
//! - `write_note_to_disk` always serializes via `frontmatter::serialize_note`
//!   (which bumps `modified`), then atomic-writes. The returned
//!   `NoteOnDisk` includes a SHA-256 content hash so the watcher /
//!   sync queue can detect no-op rewrites cheaply.
//! - All paths are vault-relative and forward-slashed.

use crate::error::{AppError, AppResult};
use crate::vault::frontmatter::{self, NoteFrontmatter, ParsedNote};
use crate::vault::fs as vfs;
use crate::vault::paths;
use std::path::Path;
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteOnDisk {
    pub relative_path: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReadNoteResult {
    pub relative_path: String,
    pub raw: String,
    pub content_hash: String,
    pub parsed: ParsedNote,
}

pub async fn read_note_from_disk(
    vault_root: &Path,
    relative_path: &str,
) -> AppResult<Option<ReadNoteResult>> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    let raw = match vfs::safe_read(&abs).await? {
        Some(s) => s,
        None => return Ok(None),
    };

    let parsed = frontmatter::parse_note(&raw, Some(relative_path))?;

    if parsed.was_modified {
        let serialized = frontmatter::serialize_note(&parsed.frontmatter, &parsed.content)?;
        vfs::atomic_write(&abs, &serialized).await?;
        let hash = vfs::content_hash(&serialized);
        return Ok(Some(ReadNoteResult {
            relative_path: relative_path.to_string(),
            raw: serialized,
            content_hash: hash,
            parsed,
        }));
    }

    let hash = vfs::content_hash(&raw);
    Ok(Some(ReadNoteResult {
        relative_path: relative_path.to_string(),
        raw,
        content_hash: hash,
        parsed,
    }))
}

pub async fn write_note_to_disk(
    vault_root: &Path,
    relative_path: &str,
    frontmatter_in: &NoteFrontmatter,
    content: &str,
) -> AppResult<NoteOnDisk> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    let serialized = frontmatter::serialize_note(frontmatter_in, content)?;
    let new_hash = vfs::content_hash(&serialized);

    if let Some(existing) = vfs::safe_read(&abs).await? {
        if vfs::content_hash(&existing) == new_hash {
            return Ok(NoteOnDisk {
                relative_path: relative_path.to_string(),
                content_hash: new_hash,
            });
        }
    }

    vfs::atomic_write(&abs, &serialized).await?;
    Ok(NoteOnDisk {
        relative_path: relative_path.to_string(),
        content_hash: new_hash,
    })
}

pub async fn write_new_note_to_disk(
    vault_root: &Path,
    relative_path: &str,
    frontmatter_in: &NoteFrontmatter,
    content: &str,
) -> AppResult<NoteOnDisk> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    let serialized = frontmatter::serialize_note(frontmatter_in, content)?;
    let new_hash = vfs::content_hash(&serialized);
    let parent = abs
        .parent()
        .ok_or_else(|| AppError::Vault(format!("path has no parent: {}", abs.display())))?;
    fs::create_dir_all(parent).await?;

    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&abs)
        .await
    {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(AppError::Conflict(format!(
                "note file already exists: {relative_path}"
            )));
        }
        Err(err) => return Err(err.into()),
    };

    if let Err(err) = file.write_all(serialized.as_bytes()).await {
        let _ = fs::remove_file(&abs).await;
        return Err(err.into());
    }

    Ok(NoteOnDisk {
        relative_path: relative_path.to_string(),
        content_hash: new_hash,
    })
}

pub async fn delete_note_from_disk(vault_root: &Path, relative_path: &str) -> AppResult<()> {
    let abs = paths::resolve_supported(vault_root, relative_path)?;
    vfs::delete_file(&abs).await
}

pub async fn move_note_to_trash(
    vault_root: &Path,
    relative_path: &str,
    note_id: &str,
) -> AppResult<String> {
    let source = paths::resolve_supported(vault_root, relative_path)?;
    let trash_dir = vault_root.join(".trash");
    fs::create_dir_all(&trash_dir).await?;

    let ext = source
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("md");
    let safe_id = safe_trash_stem(note_id);
    let mut suffix = 0;
    let target = loop {
        let name = if suffix == 0 {
            format!("{safe_id}.{ext}")
        } else {
            format!("{safe_id}-{suffix}.{ext}")
        };
        let candidate = trash_dir.join(name);
        if !fs::try_exists(&candidate).await? {
            break candidate;
        }
        suffix += 1;
    };

    match fs::rename(&source, &target).await {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }

    Ok(paths::to_relative_path(vault_root, &target)
        .unwrap_or_else(|| target.to_string_lossy().replace('\\', "/")))
}

fn safe_trash_stem(note_id: &str) -> String {
    let stem = note_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();

    if stem.is_empty() {
        "note".into()
    } else {
        stem
    }
}

/// Walk the vault tree and return forward-slashed vault-relative paths
/// for every directory below the root. Hidden directories (`.foo`) and
/// the `.memry/` app-internal slot are skipped, matching the supported
/// file scan in `vault::fs::list_supported_files`.
pub async fn list_folders(vault_root: &Path) -> AppResult<Vec<String>> {
    let canonical_root = dunce::canonicalize(vault_root)?;
    let mut out: Vec<String> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![canonical_root.clone()];

    while let Some(dir) = stack.pop() {
        let mut entries = match fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => continue,
            Err(e) => return Err(e.into()),
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
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let path = entry.path();
            if let Some(rel) = paths::to_relative_path(&canonical_root, &path) {
                out.push(rel);
            }
            stack.push(path);
        }
    }

    out.sort();
    Ok(out)
}

/// Create a vault directory (no-op if it already exists). Resolves the
/// path through the vault escape-guard before touching disk.
pub async fn create_folder(vault_root: &Path, relative: &str) -> AppResult<()> {
    let abs = paths::resolve_in_vault(vault_root, relative)?;
    fs::create_dir_all(&abs).await?;
    Ok(())
}

/// Rename a vault directory. Both paths are resolved through the
/// escape-guard. Errors with `AppError::NotFound` if the source is
/// missing, `AppError::Conflict` if the destination already exists.
pub async fn rename_folder(
    vault_root: &Path,
    old_relative: &str,
    new_relative: &str,
) -> AppResult<()> {
    let from = paths::resolve_in_vault(vault_root, old_relative)?;
    let to = paths::resolve_in_vault(vault_root, new_relative)?;

    if to == from || to.starts_with(&from) {
        return Err(AppError::Validation(
            "folder cannot be renamed into itself or a descendant".into(),
        ));
    }

    if !fs::try_exists(&from).await? {
        return Err(crate::error::AppError::NotFound(format!(
            "folder not found: {old_relative}"
        )));
    }
    if fs::try_exists(&to).await? {
        return Err(crate::error::AppError::Conflict(format!(
            "folder already exists: {new_relative}"
        )));
    }

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).await?;
    }
    fs::rename(&from, &to).await?;
    Ok(())
}

/// Delete a vault directory. With `recursive == false`, the OS rejects
/// the call when the directory is non-empty, surfaced here as a generic
/// IO error. The caller is expected to have already enforced the
/// emptiness rule against the metadata DB.
pub async fn delete_folder(vault_root: &Path, relative: &str, recursive: bool) -> AppResult<()> {
    if relative.trim().trim_matches('/').is_empty() {
        return Err(AppError::Validation("folder path cannot be root".into()));
    }
    let abs = paths::resolve_in_vault(vault_root, relative)?;
    if !fs::try_exists(&abs).await? {
        return Ok(());
    }
    if recursive {
        fs::remove_dir_all(&abs).await?;
    } else {
        fs::remove_dir(&abs).await?;
    }
    Ok(())
}
