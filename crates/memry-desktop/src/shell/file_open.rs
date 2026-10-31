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
//!    whether a file exists out there. A dangling link is `Outside`. A file another program
//!    renames a new one over while it is resolved is neither: on Windows the old file answers
//!    from the volume's deleted-files area (`\$Extend\$Deleted\...`), and the path is
//!    resolved again after short waits ([`RESOLVE_AGAIN_MS`]); one that never settles is an
//!    error, never `Outside` nor `Inside` (#3732). The old file can also fail while it is being
//!    deleted, with an error a file denied for good gives too: that is asked again once only.
//!    The name can also be missing for an instant of the replacement, which stays `Missing`,
//!    as asking again would cost every missing file the waits. Nothing on disk is lost, but a
//!    reader that takes it for gone may miss that save until the next one.
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

/// The waits before each new ask of a path whose file was being replaced (38 ms in all).
/// Asked again at once, a file another program keeps saving answers from its next
/// replacement just as often; a wait lets one replacement end.
const RESOLVE_AGAIN_MS: [u64; 5] = [1, 2, 5, 10, 20];

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

/// Whether `name` is one path segment that every platform reads as written. This is the owner of
/// the check for a file or folder name that arrives as data (a synced id, a file name in a
/// ref), where [`is_plain_relative`] takes a path a person's own file system holds. No
/// separator of either platform. No `:` on any platform: on Windows `C:x` is a drive-relative
/// path, which `PathBuf::push` takes for a whole new path, and `a:b` an alternate data stream.
/// No NUL. No trailing `.` or space, which Windows strips, so `b1.` would be the folder `b1`;
/// that also refuses `.` and `..`. What is left of a non-empty name is exactly one normal
/// component on every platform.
pub fn is_plain_segment(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\', ':', '\0']) && !name.ends_with(['.', ' '])
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
        match canonicalize_settled(&probe) {
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

/// `fs::canonicalize`, asked again while `path` is a file being replaced. The answer for a
/// file renamed over is the old file's: its name in the deleted-files area, or an error
/// while it is being deleted. Neither says where `path` points, and asking again finds the
/// new file. The deleted-files name only a replacement gives, so it is asked again through
/// every wait of [`RESOLVE_AGAIN_MS`] and is an error after the last. The error is also what
/// a file denied for good gives on every lookup, so it gets one ask after the first wait.
fn canonicalize_settled(path: &Path) -> io::Result<PathBuf> {
    settle(|| fs::canonicalize(path))
}

/// [`canonicalize_settled`]'s asking, over the answers `ask` gives.
fn settle(mut ask: impl FnMut() -> io::Result<PathBuf>) -> io::Result<PathBuf> {
    let mut waits = RESOLVE_AGAIN_MS.into_iter();
    loop {
        let answer = ask();
        let replaced = match &answer {
            Ok(real) => in_deleted_area(real),
            Err(err) => is_being_deleted(err) && waits.len() == RESOLVE_AGAIN_MS.len(),
        };
        if !replaced {
            return answer;
        }
        let Some(ms) = waits.next() else {
            return match answer {
                Ok(_) => Err(io::Error::other(
                    "the file kept being replaced while it was resolved",
                )),
                err => err,
            };
        };
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// NTFS keeps a file deleted while it is open, as a save that renames over it leaves the old
/// one, under `\$Extend\$Deleted` at the root of its volume until the last handle closes.
#[cfg(windows)]
fn in_deleted_area(real: &Path) -> bool {
    let mut parts = real
        .components()
        .skip_while(|c| matches!(c, Component::Prefix(_) | Component::RootDir));
    let mut next_is = |name: &str| {
        parts
            .next()
            .is_some_and(|c| c.as_os_str().eq_ignore_ascii_case(name))
    };
    real.has_root() && next_is("$Extend") && next_is("$Deleted")
}

#[cfg(not(windows))]
fn in_deleted_area(_real: &Path) -> bool {
    false
}

/// The errors of opening a file in the middle of its deletion: `ERROR_ACCESS_DENIED` (the
/// code `STATUS_DELETE_PENDING` maps to) and `ERROR_DELETE_PENDING`.
#[cfg(windows)]
fn is_being_deleted(err: &io::Error) -> bool {
    use windows::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_DELETE_PENDING};
    [ERROR_ACCESS_DENIED, ERROR_DELETE_PENDING]
        .iter()
        .any(|code| err.raw_os_error() == i32::try_from(code.0).ok())
}

#[cfg(not(windows))]
fn is_being_deleted(_err: &io::Error) -> bool {
    false
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

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn only_the_volume_roots_deleted_area_is_a_file_being_replaced() {
        for (path, deleted) in [
            (r"\\?\C:\$Extend\$Deleted\000500000000B31853FE9168", true),
            (r"\\?\C:\$extend\$deleted\1", true),
            (r"\\?\Volume{0a1b}\$Extend\$Deleted\1", true),
            (r"\\?\UNC\srv\share\$Extend\$Deleted\1", true),
            (r"C:\$Extend\$Deleted\1", true),
            (r"\\?\C:\vault\$Extend\$Deleted\1", false),
            (r"\\?\C:\$Extend\other\1", false),
            (r"\\?\C:\Users\agent\vault\notes\a.md", false),
            (r"$Extend\$Deleted\1", false),
        ] {
            assert_eq!(in_deleted_area(Path::new(path)), deleted, "{path}");
        }
    }

    /// A denial (os 5) or a pending delete (os 303) is asked again once, after the first
    /// wait, and is the answer if it comes again. The old file's deleted-files name is asked
    /// again through every wait. Any other answer is kept at once.
    #[test]
    fn a_denial_is_asked_again_once_and_a_deleted_name_through_every_wait() {
        let inside = || Ok(PathBuf::from(r"\\?\C:\vault\notes\a.md"));
        let deleted = || Ok(PathBuf::from(r"\\?\C:\$Extend\$Deleted\1"));
        let os = |code| move || Err(io::Error::from_raw_os_error(code));
        type Answer = Box<dyn Fn() -> io::Result<PathBuf>>;
        /// The path holds this part, or the error has this OS code.
        type Want = Result<&'static str, Option<i32>>;
        let cases: Vec<(&str, Vec<Answer>, Want, usize)> = vec![
            (
                "denied, then the file",
                vec![Box::new(os(5)), Box::new(inside)],
                Ok("notes"),
                2,
            ),
            (
                "denied twice",
                vec![Box::new(os(5)), Box::new(os(5))],
                Err(Some(5)),
                2,
            ),
            (
                "delete pending, then denied",
                vec![Box::new(os(303)), Box::new(os(5))],
                Err(Some(5)),
                2,
            ),
            (
                "deleted, then denied",
                vec![Box::new(deleted), Box::new(os(5))],
                Err(Some(5)),
                2,
            ),
            (
                "deleted, then the file",
                vec![Box::new(deleted), Box::new(inside)],
                Ok("notes"),
                2,
            ),
            (
                "deleted on every ask",
                vec![Box::new(deleted)],
                Err(None),
                RESOLVE_AGAIN_MS.len() + 1,
            ),
            (
                "outside",
                vec![Box::new(|| Ok(PathBuf::from(r"C:\other\a.md")))],
                Ok("other"),
                1,
            ),
            (
                "missing",
                vec![Box::new(os(2)), Box::new(inside)],
                Err(Some(2)),
                1,
            ),
        ];
        for (case, answers, want, asks) in cases {
            let mut asked = 0;
            let got = settle(|| {
                asked += 1;
                answers[(asked - 1).min(answers.len() - 1)]()
            });
            match (got, want) {
                (Ok(path), Ok(part)) => assert!(path.to_string_lossy().contains(part), "{case}"),
                (Err(error), Err(code)) => assert_eq!(error.raw_os_error(), code, "{case}"),
                (got, want) => panic!("{case}: {got:?}, want {want:?}"),
            }
            assert_eq!(asked, asks, "{case}");
        }
    }
}
