//! Atomic file writes (`atomicWrite` and `withTransientFsRetry`, `vault/file-ops.ts`).
//!
//! The bytes go to a fresh `.<12 hex>.tmp` in the target's directory (created exclusively,
//! mode 0600 on Unix, so a planted link is never followed), reach disk, then replace the
//! target by rename. A crash leaves the old file or the new one, never half of either.
//! On Windows `std::fs::rename` is `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`.
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

fn write_once(dir: &Path, target: &Path, bytes: &[u8]) -> io::Result<()> {
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
        fs::rename(&temp, target)
    })();
    if result.is_err() {
        // Cleanup is best effort: the write error is the one to report.
        let _ = fs::remove_file(&temp);
    }
    result
}

/// [`atomic_write`] with explicit retry delays.
pub fn atomic_write_with(
    target: &Path,
    bytes: &[u8],
    delays: &[Duration],
) -> Result<(), WriteError> {
    let fail = |source| WriteError {
        path: target.to_path_buf(),
        source,
    };
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir).map_err(fail)?;
    with_transient_retry(delays, || write_once(dir, target, bytes)).map_err(fail)
}

pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), WriteError> {
    let delays = RETRY_DELAYS_MS.map(Duration::from_millis);
    atomic_write_with(target, bytes, &delays)
}
