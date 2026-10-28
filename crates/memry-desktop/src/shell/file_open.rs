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
//!    reads, including when one is swapped in between the open and the re-check.
//! 5. A file with more than one hard link is refused unless the caller says [`LinkPolicy::Allow`].

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};

const REPLACED_RETRIES: u32 = 3;

/// Where a vault-relative path really points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// The real target: re-rooted at the root the caller passed ([`resolve_under_root`]), or
    /// canonical, root included ([`resolve_real_under_root`]).
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
    #[error("file has more than one hard link")]
    HardLinked,
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
    resolve(root, rel, Rooted::AtRoot)
}

/// [`resolve_under_root`], with `Inside` holding the canonical target itself instead of the
/// target re-rooted at `root`: for a path handed to another program, which follows any link
/// left in it after this check.
pub fn resolve_real_under_root(root: &Path, rel: &str) -> io::Result<Resolution> {
    resolve(root, rel, Rooted::Real)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Rooted {
    AtRoot,
    Real,
}

fn resolve(root: &Path, rel: &str, rooted: Rooted) -> io::Result<Resolution> {
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
                    Ok(_) if probe == joined && rooted == Rooted::Real => Resolution::Inside(real),
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

/// What to do with a file that has more than one hard link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkPolicy {
    /// Refuse it. A hard link is a second name for a file the vault tier did not put under
    /// the root: containment cannot be checked by path, and a save that renames over it
    /// would quietly split the two names. The default; logged without the path.
    RejectHardLinks,
    /// Serve it. For a folder that deliberately holds linked files (deduplicated attachments).
    Allow,
}

/// Opens the file `rel` names under `root` for reading, or `None` when it does not exist.
/// Refuses a file with more than one hard link ([`LinkPolicy::RejectHardLinks`]).
pub fn open_under_root(root: &Path, rel: &str) -> Result<Option<File>, OpenError> {
    open_under_root_with(root, rel, LinkPolicy::RejectHardLinks)
}

pub fn open_under_root_with(
    root: &Path,
    rel: &str,
    links: LinkPolicy,
) -> Result<Option<File>, OpenError> {
    open_checked(root, rel, links, &mut || {})
}

/// `open_under_root_with` and a hook that runs between the open and the re-check, so a test
/// can swap the file in that window.
#[doc(hidden)]
pub fn open_checked(
    root: &Path,
    rel: &str,
    links: LinkPolicy,
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
        let (opened, link_count) = file_identity(&file)?;
        if link_count > 1 && links == LinkPolicy::RejectHardLinks {
            tracing::warn!(
                scope = "file_open",
                "refusing a file with {link_count} hard links"
            );
            return Err(OpenError::HardLinked);
        }
        match resolve_under_root(root, rel)? {
            Resolution::Outside => return Err(OpenError::Outside),
            Resolution::Inside(now) => {
                // Opened the same way as the file: a FIFO swapped in meanwhile must not block.
                if let Ok(current) = open_read(&now)
                    && file_identity(&current)?.0 == opened
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

/// Identity of an open file: the volume and the file on it. 128 bits for the file, because
/// ReFS and some network file systems have no 64-bit index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId(u64, u128);

/// The identity of an open file and its number of hard links.
#[cfg(unix)]
pub fn file_identity(file: &File) -> io::Result<(FileId, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    Ok((FileId(meta.dev(), u128::from(meta.ino())), meta.nlink()))
}

/// A Win32 error carried by a `windows` crate `Result`, as the `io::Error` of that code, so its
/// kind (`AlreadyExists`, `PermissionDenied`, ...) is the one std would report.
#[cfg(windows)]
pub(crate) fn win_io_error(err: windows::core::Error) -> io::Error {
    let code = err.code().0 as u32;
    // HRESULT_FROM_WIN32: facility 7 in the high word, the Win32 code in the low word.
    if code >> 16 == 0x8007 {
        io::Error::from_raw_os_error((code & 0xFFFF) as i32)
    } else {
        io::Error::other(err)
    }
}

#[cfg(windows)]
pub fn file_identity(file: &File) -> io::Result<(FileId, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_ID_INFO, FileIdInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx,
    };
    let handle = HANDLE(file.as_raw_handle());
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is open for the duration of the call and `info` is a valid out value.
    unsafe { GetFileInformationByHandle(handle, &mut info) }.map_err(win_io_error)?;
    let narrow = FileId(
        u64::from(info.dwVolumeSerialNumber),
        (u128::from(info.nFileIndexHigh) << 32) | u128::from(info.nFileIndexLow),
    );
    let mut wide = FILE_ID_INFO::default();
    // SAFETY: `wide` is a valid out buffer of the size passed. Windows 8 and later; a volume
    // that does not answer keeps the 64-bit index.
    let wide_ok = unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            std::ptr::from_mut(&mut wide).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .is_ok();
    let id = if wide_ok {
        FileId(
            wide.VolumeSerialNumber,
            u128::from_le_bytes(wide.FileId.Identifier),
        )
    } else {
        narrow
    };
    Ok((id, u64::from(info.nNumberOfLinks)))
}
