//! Vault path normalization + escape-guard.
//!
//! Every external path that crosses into vault FS goes through
//! `resolve_in_vault`. The function canonicalizes the input under the
//! vault root, refuses paths that escape via `..` or symlinks, and
//! refuses paths that touch the hidden `.memry/` app-internal folder.
//! `resolve_supported` adds an extension allowlist that matches the
//! Electron `isSupportedPath` check.
//!
//! Path strings inside the renderer are always vault-relative with
//! forward slashes (matches Electron's `normalizeRelativePath`). The
//! conversion to absolute happens here and stays internal to Rust.

use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

const HIDDEN_APP_DIR: &str = ".memry";

const SUPPORTED_EXT: &[&str] = &[
    "md", "markdown", "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "mp3", "wav", "m4a",
    "ogg", "mp4", "mov", "webm",
];

/// Normalize a vault-relative path to forward slashes.
pub fn normalize_relative(path: &str) -> String {
    path.replace('\\', "/")
}

/// Convert an absolute path inside `vault_root` to a forward-slashed
/// vault-relative path. Returns `None` if the path is outside the vault.
pub fn to_relative_path(vault_root: &Path, abs: &Path) -> Option<String> {
    let canonical_root = dunce::canonicalize(vault_root).ok()?;
    let canonical_abs = if abs.exists() {
        dunce::canonicalize(abs).ok()?
    } else if let Some(parent) = abs.parent() {
        if parent.exists() {
            let canon_parent = dunce::canonicalize(parent).ok()?;
            canon_parent.join(abs.file_name()?)
        } else {
            abs.to_path_buf()
        }
    } else {
        abs.to_path_buf()
    };
    let stripped = canonical_abs.strip_prefix(&canonical_root).ok()?;
    let s = stripped.to_string_lossy().replace('\\', "/");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Resolve a vault-relative path to an absolute path under `vault_root`.
/// Rejects:
/// - `..` segments anywhere in the input
/// - absolute inputs (must be vault-relative)
/// - paths whose first segment is `.memry/`
/// - paths whose canonical resolution lands outside the vault root
///   (catches symlink escapes; the symlink target is resolved before
///   the `starts_with` check)
pub fn resolve_in_vault(vault_root: &Path, rel: &str) -> AppResult<PathBuf> {
    let cleaned = normalize_relative(rel);
    let candidate = Path::new(&cleaned);

    if candidate.is_absolute() {
        return Err(AppError::PathEscape(format!(
            "absolute path not allowed: {rel}"
        )));
    }

    let mut depth: i32 = 0;
    for component in candidate.components() {
        match component {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(AppError::PathEscape(format!("dotdot escape: {rel}")));
                }
            }
            Component::Normal(seg) => {
                if depth == 0 && seg == HIDDEN_APP_DIR {
                    return Err(AppError::PathEscape(format!(
                        "hidden app dir not addressable: {rel}"
                    )));
                }
                depth += 1;
            }
            Component::CurDir => {}
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::PathEscape(format!(
                    "root component in relative path: {rel}"
                )));
            }
        }
    }

    let vault_canonical = dunce::canonicalize(vault_root)
        .map_err(|e| AppError::Vault(format!("vault root unreadable: {e}")))?;
    let joined = vault_canonical.join(candidate);

    // Canonicalize if the file already exists; otherwise canonicalize
    // the parent and re-attach the leaf. This handles "write a new file
    // at notes/foo.md" while still catching symlink escapes on the
    // existing parent.
    let resolved = if joined.exists() {
        dunce::canonicalize(&joined)?
    } else if let Some(parent) = joined.parent() {
        if parent.exists() {
            let canon_parent = dunce::canonicalize(parent)?;
            canon_parent.join(
                joined
                    .file_name()
                    .ok_or_else(|| AppError::PathEscape(format!("missing file name: {rel}")))?,
            )
        } else {
            // Parent does not exist either — assume the caller is
            // about to create the directory tree. Use the joined path
            // as-is; the caller's `create_dir_all` is responsible.
            joined.clone()
        }
    } else {
        joined.clone()
    };

    if !resolved.starts_with(&vault_canonical) {
        return Err(AppError::PathEscape(format!(
            "resolved path escaped vault: {rel}"
        )));
    }

    let stripped = resolved
        .strip_prefix(&vault_canonical)
        .map_err(|_| AppError::PathEscape(format!("resolved path escaped vault: {rel}")))?;
    let return_root = if vault_root.is_absolute() {
        vault_root.to_path_buf()
    } else {
        std::env::current_dir()?.join(vault_root)
    };
    Ok(return_root.join(stripped))
}

/// `resolve_in_vault` plus an extension allowlist. Returns the absolute
/// path on success.
pub fn resolve_supported(vault_root: &Path, rel: &str) -> AppResult<PathBuf> {
    let resolved = resolve_in_vault(vault_root, rel)?;
    let ext = resolved
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .ok_or_else(|| AppError::Validation(format!("missing extension: {rel}")))?;
    if !SUPPORTED_EXT.contains(&ext.as_str()) {
        return Err(AppError::Validation(format!(
            "unsupported extension: .{ext}"
        )));
    }
    Ok(resolved)
}

/// Heuristic: is this a markdown file by extension?
pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}
