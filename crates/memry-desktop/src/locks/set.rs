//! Locking and unlocking a note or a folder on this device (Electron `setVaultLock`,
//! `vault-locks/service.ts`): the lock row, then the disk brought in line at once, not only at
//! the next open.
//!
//! A lock records the locked note's text as it is now, the text an outside edit is reverted to.
//! A baseline left from an earlier lock (an unlock the reconcile did not follow, as a remote one
//! or a crash leaves) would roll the note back to it on the next outside edit, and that rollback
//! would sync to every device. So a lock first drops every baseline of a note no lock covers,
//! and the reconcile records the text fresh. Electron keeps an existing baseline here.
//!
//! The lock rows reach the other devices with Step 16; nothing is queued here.

use memry_core::api::errors::StorageError;
use memry_core::domain::vault_locks::{LockState, SetOutcome, TargetKind, normalize_folder_path};

use std::sync::Arc;

use super::reconcile::files_under;
use super::{Locks, SCOPE};
use crate::notes::error::NotesError;
use crate::notes::folders::vault_folder;
use crate::notes::service::NotesService;
use crate::session::OpenVault;
use crate::tags::schema::rename::resume_after_unlock;

/// What a lock change left: every lock now, and whether the change wrote anything (the windows
/// are told only then, and only an unlock that changed something resumes a field rename).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockSet {
    pub state: LockState,
    pub changed: bool,
}

/// `setVaultLock` on the open vault: [`Locks::set`], then, once a lock is lifted, a field rename
/// a lock held resumes on its own thread (`resumeFieldRenameAfterUnlock`); `renamed` runs after
/// it ran.
pub fn set(
    open: &OpenVault,
    notes: &Arc<NotesService>,
    kind: TargetKind,
    target: &str,
    locked: bool,
    renamed: impl FnOnce() + Send + 'static,
) -> Result<LockSet, NotesError> {
    let set = Locks::of(open).set(kind, target, locked)?;
    if set.changed && !locked {
        resume_after_unlock(open.clone(), notes.clone(), renamed);
    }
    Ok(set)
}

impl Locks<'_> {
    /// Locks or unlocks the note `target` (by id) or the folder `target` (vault-relative). A
    /// note must be live and a folder must be one on disk (`folderExists`), the vault root
    /// aside. A failure to bring the disk in line after the row is written is logged: the row
    /// is the lock, and the next open's reconcile finishes it.
    pub fn set(&self, kind: TargetKind, target: &str, locked: bool) -> Result<LockSet, NotesError> {
        let target = match kind {
            TargetKind::Note => target.to_owned(),
            TargetKind::Folder => self.existing_folder(target)?,
        };
        let store = self.vault.locks();
        if locked {
            self.release_unlocked_notes()?;
        }
        if store.set(kind, &target, locked)? == SetOutcome::Unchanged {
            return Ok(LockSet {
                state: store.list()?,
                changed: false,
            });
        }
        let reconciled = self.reconcile().and_then(|()| match kind {
            TargetKind::Folder if !locked => self.release_unlocked_folder(&target),
            _ => Ok(()),
        });
        if let Err(error) = reconciled {
            tracing::warn!(
                scope = SCOPE,
                kind = kind.as_str(),
                locked,
                "the locked files were not brought in line after a lock change: {error}"
            );
        }
        Ok(LockSet {
            state: store.list()?,
            changed: true,
        })
    }

    fn existing_folder(&self, target: &str) -> Result<String, NotesError> {
        let folder = vault_folder(self.root, &normalize_folder_path(target))?;
        match !folder.is_empty() && self.root.join(&folder).is_dir() {
            true => Ok(folder),
            false => Err(NotesError::FolderNotFound),
        }
    }

    /// A folder just unlocked: each file under it that no other lock covers is writable again,
    /// those an older build made read-only without a record too.
    fn release_unlocked_folder(&self, folder: &str) -> Result<(), StorageError> {
        for rel in files_under(self.root, folder) {
            if !self.is_path_locked(&rel)? {
                self.release(&rel);
            }
        }
        Ok(())
    }
}
