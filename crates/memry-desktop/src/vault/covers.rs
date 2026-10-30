//! The files of home board covers (`home/cover-service.ts`): an image a board owns, at
//! `<vault>/.memry/home-covers/<boardId>/<file>`. Every image source the cover picker offers is
//! copied there, so a board never depends on a note's attachment.
//!
//! A cover's ref, `.memry/home-covers/<boardId>/<file>`, travels in the synced `home_page`
//! payload and Electron builds read it, so its form is Electron's. A ref is remote input: it
//! names a file only inside its own board's folder ([`cover_file_path`]). Step 30 (#3547) owns
//! the board row, the sync of a cover's bytes and the reconcile; this module owns the folder.
//!
//! The board folder is created inside `.memry`, never `.memry` itself: a vault that is away
//! fails the write instead of growing a stray copy of its root. Nothing is read, written or
//! deleted in a board folder that resolves outside `.memry` (a link), and a board id that is not
//! one plain path segment names no folder at all. Electron joins a raw board id into the path.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::fs_atomic::{RETRY_DELAYS_MS, WriteError, atomic_replace_checked};
use super::layout::{HOME_COVERS_DIR, MEMRY_DIR};

const SCOPE: &str = "home_covers";

#[derive(Debug, thiserror::Error)]
pub enum CoverError {
    /// The board id or the file name is not one plain path segment.
    #[error("invalid board cover file name")]
    InvalidName,
    /// The board's folder resolves outside `.memry`.
    #[error("the board cover folder leads out of the vault")]
    Outside,
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Write(#[from] WriteError),
}

/// `isPlainSegment`: one path segment, not `.` or `..`.
fn is_plain(value: &str) -> bool {
    !value.is_empty() && !value.contains(['/', '\\']) && value != "." && value != ".."
}

fn covers_dir(vault: &Path) -> PathBuf {
    vault.join(MEMRY_DIR).join(HOME_COVERS_DIR)
}

/// The board's folder, or `None` for a board id that is not a plain segment.
fn board_dir(vault: &Path, board_id: &str) -> Option<PathBuf> {
    is_plain(board_id).then(|| covers_dir(vault).join(board_id))
}

/// `Ok` when `dir` is there and resolves inside `.memry`, through any link on the way.
fn check_inside(vault: &Path, dir: &Path) -> Result<(), CoverError> {
    if dir
        .canonicalize()?
        .starts_with(vault.join(MEMRY_DIR).canonicalize()?)
    {
        Ok(())
    } else {
        Err(CoverError::Outside)
    }
}

fn create_dir(dir: &Path) -> io::Result<()> {
    match fs::create_dir(dir) {
        Err(error) if error.kind() != io::ErrorKind::AlreadyExists => Err(error),
        _ => Ok(()),
    }
}

/// `homeCoverFilePath`: the file a cover's ref names, or `None` when the ref is a wash, a URL,
/// or not one plain file name directly inside this board's own folder.
pub fn cover_file_path(vault: &Path, board_id: &str, reference: &str) -> Option<PathBuf> {
    let prefix = format!("{MEMRY_DIR}/{HOME_COVERS_DIR}/{board_id}/");
    let name = reference.strip_prefix(&prefix)?;
    is_plain(name).then_some(board_dir(vault, board_id)?.join(name))
}

/// Writes `bytes` as the board's cover file `file_name` (a name the caller made unique) and
/// returns the cover's ref. A file of that name is replaced. The write is atomic.
pub fn write_cover(
    vault: &Path,
    board_id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<String, CoverError> {
    let dir = board_dir(vault, board_id)
        .filter(|_| is_plain(file_name))
        .ok_or(CoverError::InvalidName)?;
    let covers = covers_dir(vault);
    create_dir(&covers)?;
    check_inside(vault, &covers)?;
    create_dir(&dir)?;
    check_inside(vault, &dir)?;
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    atomic_replace_checked(&dir.join(file_name), bytes, &delays, &mut || Ok(()))?;
    Ok(format!(
        "{MEMRY_DIR}/{HOME_COVERS_DIR}/{board_id}/{file_name}"
    ))
}

/// `pruneCoverFiles`: deletes every file of the board's folder but `keep` (a path from
/// [`cover_file_path`]), so a replaced or removed cover leaves nothing behind. A folder that is
/// not there has nothing to delete; a file that could not go is logged and left.
pub fn prune_cover_files(vault: &Path, board_id: &str, keep: Option<&Path>) {
    let Some(dir) = board_dir(vault, board_id) else {
        return;
    };
    let entries = match check_inside(vault, &dir).and_then(|()| Ok(fs::read_dir(&dir)?)) {
        Ok(entries) => entries,
        Err(CoverError::Io(error)) if error.kind() == io::ErrorKind::NotFound => return,
        Err(error) => {
            return tracing::warn!(
                scope = SCOPE,
                board_id,
                "the cover folder was not read: {error}"
            );
        }
    };
    for entry in entries {
        let removed = entry.and_then(|entry| match entry.path() {
            path if keep == Some(path.as_path()) => Ok(()),
            path => fs::remove_file(path),
        });
        match removed {
            Err(error) if error.kind() != io::ErrorKind::NotFound => {
                tracing::warn!(scope = SCOPE, board_id, kind = ?error.kind(), "an old cover file was not deleted");
            }
            _ => {}
        }
    }
}

/// `deleteHomeCoverFiles`: a deleted board's cover folder goes with it.
pub fn delete_cover_dir(vault: &Path, board_id: &str) {
    let Some(dir) = board_dir(vault, board_id) else {
        return;
    };
    let deleted = check_inside(vault, &dir).and_then(|()| Ok(fs::remove_dir_all(&dir)?));
    match deleted {
        Ok(()) => {}
        Err(CoverError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            tracing::warn!(
                scope = SCOPE,
                board_id,
                "the cover folder was not deleted: {error}"
            );
        }
    }
}
