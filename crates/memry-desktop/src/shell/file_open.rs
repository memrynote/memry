//! The one owner of the open-under-root rule: a file named by a vault-relative path is read
//! only when its real location is inside the root, and only if the file opened is still the
//! file that path resolves to. Everything that reads a vault file by a name a person, a peer or a
//! page could influence goes through [`open_under_root`] (the vault tier, the `memry-file`
//! scheme and the loopback server of Step 10).
//!
//! Port of `resolveVaultFile` and `openVaultFile` in `apps/desktop/src/main/lib/paths.ts`.
//!
//! The rule, in order:
//! 1. `rel` must be a plain relative path: no `..`, no root, no drive or UNC prefix, and on
//!    Windows no `:` (an alternate data stream or a drive-relative name). Anything else is
//!    [`Resolution::Outside`].
//! 2. Symlinks and junctions are followed with `canonicalize`. The target must be inside the
//!    canonical root. A path that does not exist is placed by its nearest existing ancestor,
//!    so a missing file under a folder linked outside is `Outside` too: a reader cannot learn
//!    whether a file exists out there. A dangling link is `Outside`.
//! 3. After the file is open, the path is resolved again and must name the same file (device
//!    and inode on Unix, volume serial and file index on Windows). A save renames a new file
//!    over the note, so on a mismatch the open is retried, three times, then
//!    [`OpenError::KeptChanging`].
//! 4. Only a regular file is returned. A FIFO or a device named like a note never blocks or
//!    reads.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};

const REPLACED_RETRIES: u32 = 3;

/// Where a vault-relative path really points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// The real target, re-rooted at the root the caller passed.
    Inside(PathBuf),
    /// Leaves the root, or is not a plain relative path.
    Outside,
    /// Nothing there yet; the nearest existing ancestor is inside the root.
    Missing,
}

#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error("path is outside the vault")]
    Outside,
    #[error("file kept changing while it was opened")]
    KeptChanging,
    #[error("not a regular file")]
    NotRegular,
    #[error("{0}")]
    Io(#[from] io::Error),
}

/// Whether `rel` is a plain relative path. The only syntactic check; the file system does the rest.
fn is_plain_relative(rel: &str) -> bool {
    if rel.is_empty() || rel.contains('\0') {
        return false;
    }
    let path = Path::new(rel);
    if !path
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return false;
    }
    // On Windows `Path` already rejects drive and UNC prefixes. A colon inside a segment
    // names an alternate data stream.
    !(cfg!(windows) && rel.contains(':'))
}

/// `resolveVaultFile`. `root` must exist.
pub fn resolve_under_root(root: &Path, rel: &str) -> io::Result<Resolution> {
    if !is_plain_relative(rel) {
        return Ok(Resolution::Outside);
    }
    let real_root = fs::canonicalize(root)?;
    let joined = root.join(rel);
    let mut probe = joined.clone();
    loop {
        match fs::canonicalize(&probe) {
            Ok(real) => {
                return Ok(match real.strip_prefix(&real_root) {
                    Err(_) => Resolution::Outside,
                    Ok(relative) if probe == joined => Resolution::Inside(root.join(relative)),
                    Ok(_) => Resolution::Missing,
                });
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                // A link whose target is gone also reports NotFound.
                if fs::symlink_metadata(&probe).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Ok(Resolution::Outside);
                }
                match probe.parent() {
                    Some(parent) if parent != probe => probe = parent.to_path_buf(),
                    _ => return Ok(Resolution::Missing),
                }
            }
            Err(err) => return Err(err),
        }
    }
}

/// Opens the file `rel` names under `root` for reading, or `None` when it does not exist.
pub fn open_under_root(root: &Path, rel: &str) -> Result<Option<File>, OpenError> {
    open_checked(root, rel, &mut || {})
}

/// `open_under_root` with a hook that runs between the open and the re-check, so a test can
/// swap the file in that window.
#[doc(hidden)]
pub fn open_checked(
    root: &Path,
    rel: &str,
    between: &mut dyn FnMut(),
) -> Result<Option<File>, OpenError> {
    for attempt in 1..=REPLACED_RETRIES {
        let path = match resolve_under_root(root, rel)? {
            Resolution::Outside => return Err(OpenError::Outside),
            Resolution::Missing => return Ok(None),
            Resolution::Inside(path) => path,
        };
        let file = match open_read(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        if !file.metadata()?.is_file() {
            return Err(OpenError::NotRegular);
        }
        between();
        let opened = file_id(&file)?;
        match resolve_under_root(root, rel)? {
            Resolution::Outside => return Err(OpenError::Outside),
            Resolution::Inside(now) => {
                if let Ok(current) = File::open(&now)
                    && file_id(&current)? == opened
                {
                    return Ok(Some(file));
                }
            }
            Resolution::Missing => {}
        }
        if attempt == REPLACED_RETRIES {
            return Err(OpenError::KeptChanging);
        }
    }
    Err(OpenError::KeptChanging)
}

#[cfg(unix)]
fn open_read(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    // O_NONBLOCK keeps a FIFO named like a note from hanging the open.
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}

#[cfg(windows)]
fn open_read(path: &Path) -> io::Result<File> {
    // std opens with FILE_SHARE_READ | WRITE | DELETE, so a save renaming over the file is not blocked.
    OpenOptions::new().read(true).open(path)
}

/// Identity of an open file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId(u64, u64);

#[cfg(unix)]
pub fn file_id(file: &File) -> io::Result<FileId> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok(FileId(meta.dev(), meta.ino()))
}

#[cfg(windows)]
pub fn file_id(file: &File) -> io::Result<FileId> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is open for the duration of the call and `info` is a valid out value.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(io::Error::from)?;
    Ok(FileId(
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}
