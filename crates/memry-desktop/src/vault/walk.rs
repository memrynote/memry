//! The vault walk (`findVaultFiles`, `vault/indexer.ts`): every supported file under the
//! root, as vault-relative `/` paths.
//!
//! Skips names starting with a dot, the root `attachments` folder (a nested one is the
//! user's), and any name in the exclude list. Symlinks are neither followed nor listed. An
//! unreadable folder is skipped and counted, never fatal. The walk keeps its own stack, so
//! a deep tree cannot overflow the thread's.
//!
//! A vault folder is untrusted input (a copied archive, a synced share), so the walk is
//! bounded in steps, not time: [`Limits`] caps folder depth, entries looked at and files
//! listed. A cap that is hit stops that part of the walk and is reported in the result
//! ([`Walk::truncated`], [`Walk::too_deep`]). A truncated walk is a partial listing: nothing
//! may conclude from it that a file is gone, so a caller never syncs a delete from one.
//! A name that is not valid UTF-8 cannot be a vault-relative `/` path here; it is skipped and
//! counted ([`Walk::non_utf8`]), never listed under a lossy spelling that names another file.

use std::fs;
use std::path::{Path, PathBuf};

use super::file_types::is_supported_path;
use super::layout::ATTACHMENTS_DIR;

/// `SCAN_COLLECT_LIMIT`: how many unsupported paths are kept for the activity log.
pub const UNSUPPORTED_COLLECT_LIMIT: usize = 10_000;

/// Step bounds of a walk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Folder levels below the root that are read. The watcher's own depth is 99; the OS path
    /// length limit stops real trees well before this.
    pub max_depth: usize,
    /// Directory entries looked at.
    pub max_entries: usize,
    /// Files listed (supported and unsupported).
    pub max_files: usize,
}

impl Limits {
    pub const DEFAULT: Limits = Limits {
        max_depth: 256,
        max_entries: 2_000_000,
        max_files: 1_000_000,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cap {
    Entries,
    Files,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Walk {
    /// Supported files, sorted.
    pub files: Vec<String>,
    /// Unsupported files, at most [`UNSUPPORTED_COLLECT_LIMIT`], sorted.
    pub unsupported: Vec<String>,
    pub unsupported_count: usize,
    /// Folders that could not be read.
    pub unreadable: Vec<String>,
    /// Directory entries looked at.
    pub visited: usize,
    /// Entries whose name is not valid UTF-8.
    pub non_utf8: usize,
    /// Folders left unread because they sit deeper than `max_depth`.
    pub too_deep: usize,
    /// The cap that stopped the walk, if one did.
    pub truncated: Option<Cap>,
}

pub fn walk_vault(root: &Path, exclude: &[String]) -> Walk {
    walk_vault_with(root, exclude, Limits::DEFAULT)
}

pub fn walk_vault_with(root: &Path, exclude: &[String], limits: Limits) -> Walk {
    let mut walk = Walk::default();
    // (absolute dir, vault-relative prefix with trailing `/` or empty, depth)
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    'folders: while let Some((dir, prefix, depth)) = stack.pop() {
        if depth > limits.max_depth {
            walk.too_deep += 1;
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) => {
                tracing::warn!(
                    scope = "vault_walk",
                    "skipping an unreadable folder: {:?}",
                    err.kind()
                );
                walk.unreadable
                    .push(prefix.trim_end_matches('/').to_owned());
                continue;
            }
        };
        for entry in entries.flatten() {
            if walk.visited >= limits.max_entries {
                walk.truncated = Some(Cap::Entries);
                break 'folders;
            }
            walk.visited += 1;
            let Ok(name) = entry.file_name().into_string() else {
                walk.non_utf8 += 1;
                continue;
            };
            if name.starts_with('.') || exclude.contains(&name) {
                continue;
            }
            if prefix.is_empty() && name == ATTACHMENTS_DIR {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let rel = format!("{prefix}{name}");
            if kind.is_dir() {
                stack.push((entry.path(), format!("{rel}/"), depth + 1));
            } else if kind.is_file() {
                if walk.files.len() + walk.unsupported_count >= limits.max_files {
                    walk.truncated = Some(Cap::Files);
                    break 'folders;
                }
                if is_supported_path(&name) {
                    walk.files.push(rel);
                } else {
                    walk.unsupported_count += 1;
                    if walk.unsupported.len() < UNSUPPORTED_COLLECT_LIMIT {
                        walk.unsupported.push(rel);
                    }
                }
            }
        }
    }
    if walk.non_utf8 > 0 {
        tracing::warn!(
            scope = "vault_walk",
            "skipped {} entries whose names are not valid UTF-8",
            walk.non_utf8
        );
    }
    walk.files.sort();
    walk.unsupported.sort();
    walk
}
