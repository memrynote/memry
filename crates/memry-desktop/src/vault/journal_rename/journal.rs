//! The journal folder a pass reads and writes: its files, its paths on disk and relative to the
//! vault, and the folders a pass leaves empty.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use super::{JournalVault, SCOPE};
use crate::vault::paths::safe_join;
use crate::vault::watch::EchoGuard;

/// The folder `folder` (vault-relative) and the folders holding it that are not on disk,
/// deepest first: the folders a pass into it makes. Empty for one that leads out of the vault.
pub(crate) fn missing_folders(root: &Path, folder: &str) -> Vec<String> {
    Journal::of(root, folder.to_owned()).map_or_else(Vec::new, |journal| journal.missing(root))
}

/// Removes the folders a pass made for a new journal folder, deepest first, while each is
/// empty, the watcher told first ([`Journal::remove_empty`]).
pub(super) fn remove_made(at: JournalVault<'_>, made: &[String]) {
    let echo = at.tier.echo();
    for folder in made {
        let Some(path) = safe_join(at.root, &[folder]) else {
            return;
        };
        if echo.removing(folder, || fs::remove_dir(path)).is_err() {
            return;
        }
    }
}

/// Every file under `dir` as a `/`-separated path relative to it; dot entries (`.obsidian`,
/// editor temp files) and links are skipped, names that are not UTF-8 too, since no format
/// renders one. `None` when `dir` is missing.
pub(super) fn list_files(dir: &Path) -> io::Result<Option<Vec<String>>> {
    let mut files = Vec::new();
    let mut folders = vec![String::new()];
    while let Some(relative) = folders.pop() {
        let entries = match fs::read_dir(join(dir, &relative)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound && relative.is_empty() => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let kind = entry.file_type()?;
            if kind.is_dir() {
                folders.push(path);
            } else if kind.is_file() {
                files.push(path);
            }
        }
    }
    Ok(Some(files))
}

/// The journal folder of a pass: where it is on disk and relative to the vault.
pub(super) struct Journal {
    pub(super) dir: PathBuf,
    pub(super) folder: String,
}

impl Journal {
    /// `None`, and a warning, for a folder that leads out of the vault.
    pub(super) fn of(root: &Path, folder: String) -> Option<Self> {
        let Some(dir) = safe_join(root, &[&folder]) else {
            tracing::warn!(
                scope = SCOPE,
                "the journal folder is outside the vault; nothing renamed"
            );
            return None;
        };
        Some(Self { dir, folder })
    }

    /// The journal folder and the folders that hold it that are not there, deepest first.
    pub(super) fn missing(&self, root: &Path) -> Vec<String> {
        std::iter::successors(Some(self.folder.as_str()), |folder| parent_of(folder))
            .take_while(|folder| safe_join(root, &[folder]).is_some_and(|path| !exists(&path)))
            .map(str::to_owned)
            .collect()
    }

    /// A `/`-separated path relative to the journal folder, on disk; `None` when it leads out.
    pub(super) fn path(&self, relative: &str) -> Option<PathBuf> {
        safe_join(&self.dir, &[relative])
    }

    /// The same path relative to the vault, as the rows and the watcher name it.
    pub(super) fn rel(&self, relative: &str) -> String {
        format!("{}/{relative}", self.folder)
    }

    /// Removes `folders`, deepest first, while each is empty; the first that is not, or that
    /// cannot go, ends it. The watcher is told of each removal first, as of a file's move: it
    /// would otherwise take the folder's going for the delete of the notes it last saw in it.
    pub(super) fn remove_empty<'a>(
        &self,
        echo: &EchoGuard,
        folders: impl Iterator<Item = &'a str>,
    ) {
        for folder in folders {
            let (Some(path), rel) = (self.path(folder), self.rel(folder)) else {
                return;
            };
            // `remove_dir` refuses a folder that is not empty, which is the guard wanted here.
            if echo.removing(&rel, || fs::remove_dir(path)).is_err() {
                return;
            }
        }
    }
}

/// The folders that hold `relative` below the journal folder, deepest first: `2025/January`,
/// then `2025`, for `2025/January/2025-01-14.md`.
pub(super) fn folders_of(relative: &str) -> impl Iterator<Item = &str> {
    std::iter::successors(parent_of(relative), |folder| parent_of(folder))
}

pub(super) fn parent_of(relative: &str) -> Option<&str> {
    relative.rsplit_once('/').map(|(up, _)| up)
}

pub(super) fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// `dir` joined with a `/`-separated relative path of names a listing returned.
fn join(dir: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .fold(dir.to_path_buf(), |path, segment| path.join(segment))
}
