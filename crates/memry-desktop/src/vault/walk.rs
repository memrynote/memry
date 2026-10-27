//! The vault walk (`findVaultFiles`, `vault/indexer.ts`): every supported file under the
//! root, as vault-relative `/` paths.
//!
//! Skips names starting with a dot, the root `attachments` folder (a nested one is the
//! user's), and any name in the exclude list. Symlinks are neither followed nor listed. An
//! unreadable folder is skipped and counted, never fatal. The walk keeps its own stack, so
//! a deep tree cannot overflow the thread's, and it visits each entry once.

use std::fs;
use std::path::{Path, PathBuf};

use super::file_types::is_supported_path;
use super::layout::ATTACHMENTS_DIR;

/// `SCAN_COLLECT_LIMIT`: how many unsupported paths are kept for the activity log.
pub const UNSUPPORTED_COLLECT_LIMIT: usize = 10_000;

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
}

pub fn walk_vault(root: &Path, exclude: &[String]) -> Walk {
    let mut walk = Walk::default();
    // (absolute dir, vault-relative prefix with trailing `/` or empty)
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
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
            walk.visited += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
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
                stack.push((entry.path(), format!("{rel}/")));
            } else if kind.is_file() {
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
    walk.files.sort();
    walk.unsupported.sort();
    walk
}
