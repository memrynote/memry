//! The read-only attribute of a locked file (Electron `vault-locks/files.ts`). It is what stops
//! a tool outside the app (an editor, a CLI agent) from saving over a locked file without
//! asking. On Unix it is the write bits; on Windows the read-only attribute, which this module
//! reads and writes as Node does: the owner write bit, so one recorded mode serves both.
//!
//! Locking records the file's bits, then clears every write bit; lifting the lock gives the
//! recorded bits back. A record belongs to one file, named by its identity (`(dev, ino)` on
//! Unix, volume serial and file index on Windows). The app's own writes replace the file and
//! keep the record. A file the app did not just write that is another file than the record's,
//! or is found writable with other bits, was added or replaced from outside, so its bits
//! replace the record: unlocking never gives a file more than it had.

use std::fs::{File, Metadata};

use memry_core::api::errors::StorageError;

use super::{Locks, SCOPE};
use crate::shell::file_open::{OpenError, file_identity};
use crate::vault::paths::open_vault_file;

/// A file's permission bits as Node reports them, and its identity.
pub(super) struct Found {
    pub mode: u32,
    pub identity: String,
}

impl Found {
    pub fn of(file: &File) -> std::io::Result<Self> {
        Ok(Self {
            mode: node_mode(&file.metadata()?),
            identity: file_identity(file)?.0.to_string(),
        })
    }
}

#[cfg(unix)]
fn node_mode(meta: &Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    meta.mode()
}

/// libuv's mode of a Windows file: every write bit is the read-only attribute's opposite.
#[cfg(windows)]
fn node_mode(meta: &Metadata) -> u32 {
    if meta.permissions().readonly() {
        0o444
    } else {
        0o666
    }
}

#[derive(Debug, thiserror::Error)]
enum ModeError {
    #[error(transparent)]
    Open(#[from] OpenError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl Locks<'_> {
    /// `setFileReadOnly`: read-only, or the recorded bits back. Never fails: a file that is
    /// gone has nothing to change, and any other failure is logged.
    pub(super) fn set_read_only(&self, rel: &str, read_only: bool) {
        self.change_mode(rel, read_only, false);
    }

    /// `protectFileAsFound`: read-only, for a locked file the app did not just write.
    pub(super) fn protect_as_found(&self, rel: &str) {
        self.change_mode(rel, true, true);
    }

    /// `releaseLockedFile`: no lock covers the file any more, so its recorded bits come back
    /// and the record goes.
    pub(super) fn release(&self, rel: &str) {
        self.set_read_only(rel, false);
        if let Err(error) = self.vault.locks().forget_file_mode(rel) {
            tracing::warn!(
                scope = SCOPE,
                "the recorded mode of an unlocked file was not dropped: {error}"
            );
        }
    }

    fn change_mode(&self, rel: &str, read_only: bool, as_found: bool) {
        if let Err(error) = self.try_change_mode(rel, read_only, as_found) {
            tracing::warn!(
                scope = SCOPE,
                read_only,
                "the read-only attribute of a file was not changed: {error}"
            );
        }
    }

    fn try_change_mode(&self, rel: &str, read_only: bool, as_found: bool) -> Result<(), ModeError> {
        // Opened once and checked, so a file linked outside the vault is never changed.
        let Some(file) = open_vault_file(self.root, rel)? else {
            return Ok(());
        };
        let found = Found::of(&file)?;
        let Some(next) = self.next_mode(rel, &found, read_only, as_found)? else {
            return Ok(());
        };
        set_mode(self.root, rel, &file, next)
    }

    /// `nextMode`: the mode a lock change leaves the file in, or `None` when it has it already.
    /// A file with no record (one found read-only) only gets the owner write bit back.
    pub(super) fn next_mode(
        &self,
        rel: &str,
        found: &Found,
        read_only: bool,
        as_found: bool,
    ) -> Result<Option<u32>, StorageError> {
        let store = self.vault.locks();
        let bits = found.mode & 0o777;
        let row = store.file_mode(rel)?;
        let mut recorded = row.as_ref().map(|row| row.mode);
        if read_only {
            let writable = found.mode & 0o222 != 0;
            let same_file = |row: &memry_core::domain::vault_locks::FileMode| {
                row.identity.as_deref() == Some(found.identity.as_str())
            };
            let takes_found = match &row {
                None => writable,
                Some(row) => {
                    let replaced = row.identity.is_some() && !same_file(row);
                    as_found && (replaced || (writable && row.mode != bits))
                }
            };
            if takes_found {
                recorded = Some(bits);
                store.record_file_mode(rel, bits, Some(&found.identity))?;
            } else if let Some(row) = row.as_ref().filter(|row| !same_file(row)) {
                store.record_file_mode(rel, row.mode, Some(&found.identity))?;
            }
        }
        let next = match read_only {
            true => recorded.unwrap_or(bits) & !0o222,
            false => recorded.unwrap_or((found.mode | 0o200) & 0o777),
        };
        Ok((next != bits).then_some((found.mode & 0o7000) | next))
    }
}

/// Through the open handle, so a file swapped in after the check is never changed.
#[cfg(unix)]
fn set_mode(_root: &std::path::Path, _rel: &str, file: &File, mode: u32) -> Result<(), ModeError> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    Ok(())
}

/// By name, as Electron does on Windows: the handle is open for reading only, and changing the
/// attribute through it needs write-attribute access. The name is resolved again, inside the
/// vault.
#[cfg(windows)]
fn set_mode(root: &std::path::Path, rel: &str, file: &File, mode: u32) -> Result<(), ModeError> {
    use crate::shell::file_open::Resolution;
    let Resolution::Inside(path) = crate::vault::paths::resolve_vault_file(root, rel)? else {
        return Err(OpenError::Outside.into());
    };
    let mut permissions = file.metadata()?.permissions();
    permissions.set_readonly(mode & 0o200 == 0);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}
