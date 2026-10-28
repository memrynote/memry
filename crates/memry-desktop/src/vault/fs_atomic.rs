//! Atomic file writes (`atomicWrite` and `withTransientFsRetry`, `vault/file-ops.ts`).
//!
//! The bytes go to a fresh `.<12 hex>.tmp` in the target's directory (created exclusively,
//! mode 0600 on Unix, so a planted link is never followed), reach disk, then take the
//! target's place. A crash leaves the old file or the new one, never half of either.
//!
//! Two ways to take the place, and a writer picks by what it knows about the target:
//! - [`atomic_write`] replaces the target (`rename`; on Windows std's rename with POSIX
//!   semantics, which also replaces a file another process holds open). The successor keeps the
//!   replaced file's permissions, owner and group, and on Unix its extended attributes (Finder tags,
//!   quarantine flags), so a save does not quietly turn a 0644 note into 0600 or drop its tags.
//!   Windows ACLs are not copied: the successor inherits the folder's, as a rename from the
//!   Electron app did.
//! - [`atomic_create`] makes a file that must not exist yet. It links (Unix) or moves without
//!   replacing (Windows) the finished temp file into place, so a file another process created
//!   after the caller looked is never overwritten: the call fails with `AlreadyExists`.
//!   [`create_unique`] picks the first free `<name> N<ext>` that way.
//!
//! After a replace or create the directory is synced (Unix), so the rename itself survives a
//! power cut, not only the file's bytes. Windows has no directory sync; a create there is a
//! `MOVEFILE_WRITE_THROUGH` move, a replace relies on the file's own `sync_all`.
//!
//! Cloud-sync clients and antivirus scanners lock files for a moment, so a sharing violation
//! is retried after 50, 150 and 450 ms and then tried once more. The Step 14 lock guard calls
//! in here, before and after the write.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Waits between attempts of a transient failure (`TRANSIENT_FS_RETRY_DELAYS_MS`).
pub const RETRY_DELAYS_MS: [u64; 3] = [50, 150, 450];

#[derive(Debug, thiserror::Error)]
#[error("failed to write file {}: {source}", path.display())]
pub struct WriteError {
    pub path: PathBuf,
    /// The errno is the only thing that tells a cloud-sync lock apart from a full disk or a
    /// read-only vault once a report reaches us.
    #[source]
    pub source: io::Error,
}

impl WriteError {
    /// A create found a file already there.
    pub fn already_exists(&self) -> bool {
        self.source.kind() == io::ErrorKind::AlreadyExists
    }
}

/// A sharing or lock violation: `EBUSY`, `EPERM`, `EACCES`, and on Windows `ERROR_SHARING_VIOLATION` (32)
/// and `ERROR_LOCK_VIOLATION` (33).
pub fn is_transient(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
    ) || cfg!(windows) && matches!(err.raw_os_error(), Some(32 | 33))
}

/// Runs `operation`, retrying a transient failure after each delay and then once more.
pub fn with_transient_retry<T>(
    delays: &[Duration],
    mut operation: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    for (index, delay) in delays.iter().enumerate() {
        match operation() {
            Err(err) if is_transient(&err) => {
                // Only the error kind and the attempt number: the path is note-derived.
                tracing::warn!(
                    scope = "fs_atomic",
                    "transient {:?} on attempt {} of {}, retrying in {}ms",
                    err.kind(),
                    index + 1,
                    delays.len() + 1,
                    delay.as_millis()
                );
                std::thread::sleep(*delay);
            }
            other => return other,
        }
    }
    operation()
}

fn temp_name() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!(".{}.tmp", &id[..12])
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Commit {
    Replace,
    Create,
}

/// Called once per attempt after the temp file is complete and right before it takes the
/// target's place. An error stops the write and removes the temp file.
pub type BeforeCommit<'a> = &'a mut dyn FnMut() -> io::Result<()>;

fn write_once(
    dir: &Path,
    target: &Path,
    bytes: &[u8],
    commit: Commit,
    before_commit: BeforeCommit<'_>,
) -> io::Result<()> {
    // A fresh name per attempt, so a failed attempt cannot collide with its own leftovers.
    let temp = dir.join(temp_name());
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if commit == Commit::Replace {
            carry_over_attributes(target, &temp);
        }
        before_commit()?;
        match commit {
            Commit::Replace => replace_file(&temp, target)?,
            Commit::Create => create_file(&temp, target)?,
        }
        sync_dir(dir);
        Ok(())
    })();
    if result.is_err() || commit == Commit::Create {
        // Best effort: the write error is the one to report. After a create the temp file is
        // the second name of the new file and has done its job.
        let removed = fs::remove_file(&temp);
        // A Windows create moves the temp file, so there is nothing left to remove.
        if result.is_ok()
            && let Err(err) = removed
            && err.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!(
                scope = "fs_atomic",
                "left a temp file behind: {:?}",
                err.kind()
            );
        }
    }
    result
}

/// The replaced file's permissions, owner, group and extended attributes, put on the temp
/// file. A failure is logged and does not stop the save: the content matters more than a tag.
fn carry_over_attributes(target: &Path, temp: &Path) {
    let Ok(existing) = fs::metadata(target) else {
        return;
    };
    if !existing.is_file() {
        return;
    }
    if let Err(err) = fs::set_permissions(temp, existing.permissions()) {
        tracing::warn!(
            scope = "fs_atomic",
            "could not keep the file mode: {:?}",
            err.kind()
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // The owner is this process already; only the group can differ, and only a member of
        // that group may set it.
        let _ = std::os::unix::fs::chown(temp, None, Some(existing.gid()));
        if fs::metadata(temp).is_ok_and(|m| m.gid() != existing.gid()) {
            tracing::warn!(scope = "fs_atomic", "could not keep the file group");
        }
        if let Ok(names) = xattr::list(target) {
            for name in names {
                if let Ok(Some(value)) = xattr::get(target, &name)
                    && let Err(err) = xattr::set(temp, &name, &value)
                {
                    tracing::warn!(
                        scope = "fs_atomic",
                        "could not keep an extended attribute: {:?}",
                        err.kind()
                    );
                }
            }
        }
    }
}

/// `std::fs::rename` replaces the target on both platforms. On Windows it is the POSIX-semantics
/// rename of `SetFileInformationByHandle`, which, unlike `MoveFileExW(REPLACE_EXISTING)`
/// (access denied), replaces a file another process holds open with `FILE_SHARE_DELETE`:
/// the antivirus-style reader the retry table exists for.
fn replace_file(temp: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temp, target)
}

#[cfg(windows)]
fn move_file_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW};
    use windows::core::PCWSTR;
    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both buffers are NUL-terminated and outlive the call.
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(crate::shell::file_open::win_io_error)
}

#[cfg(unix)]
fn create_file(temp: &Path, target: &Path) -> io::Result<()> {
    match fs::hard_link(temp, target) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Err(err),
        Err(err) => {
            // A volume without hard links (FAT, some network and FUSE mounts): create the
            // target exclusively and copy the bytes in. Still never replaces a file, but a
            // crash mid-copy leaves a partial new file, which a hard link cannot.
            tracing::warn!(
                scope = "fs_atomic",
                "no hard links here ({:?}); creating the file in place",
                err.kind()
            );
            let mut target_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)?;
            let copied = (|| {
                io::copy(&mut fs::File::open(temp)?, &mut target_file)?;
                target_file.sync_all()
            })();
            if copied.is_err() {
                let _ = fs::remove_file(target);
            }
            copied
        }
    }
}

#[cfg(windows)]
fn create_file(temp: &Path, target: &Path) -> io::Result<()> {
    // Without MOVEFILE_REPLACE_EXISTING the move fails when the target exists.
    move_file_no_replace(temp, target)
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    // The rename is only durable once the directory entry is. A volume that cannot sync a
    // directory is logged; the file itself is already in place.
    let synced = fs::File::open(dir).and_then(|d| d.sync_all());
    if let Err(err) = synced {
        tracing::warn!(
            scope = "fs_atomic",
            "could not sync the folder: {:?}",
            err.kind()
        );
    }
}

#[cfg(windows)]
fn sync_dir(_dir: &Path) {
    // MOVEFILE_WRITE_THROUGH already waits for the move to reach disk.
}

fn run(
    target: &Path,
    bytes: &[u8],
    delays: &[Duration],
    commit: Commit,
    create_dirs: bool,
    before_commit: BeforeCommit<'_>,
) -> Result<(), WriteError> {
    let fail = |source| WriteError {
        path: target.to_path_buf(),
        source,
    };
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if create_dirs {
        fs::create_dir_all(dir).map_err(fail)?;
    }
    with_transient_retry(delays, || {
        write_once(dir, target, bytes, commit, &mut *before_commit)
    })
    .map_err(fail)
}

fn default_delays() -> [Duration; 3] {
    RETRY_DELAYS_MS.map(Duration::from_millis)
}

/// [`atomic_write`] with explicit retry delays and a check right before the rename.
pub fn atomic_write_checked(
    target: &Path,
    bytes: &[u8],
    delays: &[Duration],
    before_commit: BeforeCommit<'_>,
) -> Result<(), WriteError> {
    run(target, bytes, delays, Commit::Replace, true, before_commit)
}

/// [`atomic_write_checked`] for a file that is there: its folder is never created. A folder
/// that moved or went fails the write (`NotFound`) instead of coming back at the old path.
pub fn atomic_replace_checked(
    target: &Path,
    bytes: &[u8],
    delays: &[Duration],
    before_commit: BeforeCommit<'_>,
) -> Result<(), WriteError> {
    run(target, bytes, delays, Commit::Replace, false, before_commit)
}

pub fn atomic_write_with(
    target: &Path,
    bytes: &[u8],
    delays: &[Duration],
) -> Result<(), WriteError> {
    atomic_write_checked(target, bytes, delays, &mut || Ok(()))
}

pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), WriteError> {
    atomic_write_with(target, bytes, &default_delays())
}

/// Writes a file that must not exist: `AlreadyExists` when one is there, at the check or
/// created by someone else meanwhile.
pub fn atomic_create_checked(
    target: &Path,
    bytes: &[u8],
    delays: &[Duration],
    before_commit: BeforeCommit<'_>,
) -> Result<(), WriteError> {
    run(target, bytes, delays, Commit::Create, true, before_commit)
}

pub fn atomic_create(target: &Path, bytes: &[u8]) -> Result<(), WriteError> {
    atomic_create_checked(target, bytes, &default_delays(), &mut || Ok(()))
}

/// `base`, or the first of `<name> 1<ext>`, `<name> 2<ext>`, ... that did not exist, created
/// with `bytes`. The path returned is the one this call created; two callers never get one.
pub fn create_unique(base: &Path, bytes: &[u8]) -> Result<PathBuf, WriteError> {
    let mut candidates = super::paths::unique_candidates(base);
    loop {
        let candidate = candidates.next().expect("candidates never end");
        match atomic_create(&candidate, bytes) {
            Ok(()) => return Ok(candidate),
            Err(err) if err.already_exists() => {}
            Err(err) => return Err(err),
        }
    }
}
