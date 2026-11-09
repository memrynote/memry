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
//! A lock change holds the rows' lane from its row through the reconcile, as the write-back
//! pass holds it from its lock check through its write and stamp, and the consumer while it
//! restores a locked file. Without it, a lock set inside a write-back's write records the file
//! the write is about to replace as the baseline and leaves the new file writable, so the next
//! outside edit is reverted to the replaced text; and an unlock there has the write make the
//! file read-only again after the unlock freed it.
//!
//! The lock rows reach the other devices with Step 16; nothing is queued here.

use memry_core::api::errors::StorageError;
use memry_core::domain::vault_locks::{LockState, SetOutcome, TargetKind, normalize_folder_path};

use std::sync::Arc;

use super::reconcile::files_under;
use super::{Locks, SCOPE};
use crate::notes::error::NotesError;
use crate::notes::folders::vault_folder;
use crate::notes::moves::{OnDisk, folder_on_disk};
use crate::notes::service::NotesService;
use crate::session::OpenVault;
use crate::tags::schema::rename::resume_after_unlock;
use crate::vault::consumer::rows::{RowOwner, RowSession};

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
    let rows = notes.tier.rows();
    let session = rows.session_for(&open.vault)?;
    let set = Locks::of(open).set(&rows, session, kind, target, locked)?;
    if set.changed && !locked {
        resume_after_unlock(open.clone(), notes.clone(), renamed);
    }
    Ok(set)
}

impl Locks<'_> {
    /// Locks or unlocks the note `target` (by id) or the folder `target` (vault-relative). A
    /// note must be live and a folder must be one on disk (`folderExists`), the vault root
    /// aside. A failure to bring the disk in line after the row is written is logged: the row
    /// is the lock, and the next open's reconcile finishes it. Under the rows' lane of
    /// `session`, which the caller does not hold.
    pub(crate) fn set(
        &self,
        rows: &RowOwner,
        session: RowSession,
        kind: TargetKind,
        target: &str,
        locked: bool,
    ) -> Result<LockSet, NotesError> {
        let _lane = rows.lane_of(session)?;
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

    /// The folder as the disk spells it ([`folder_on_disk`], as create, move and delete check
    /// it): on a case-blind volume or under another Unicode form, `archive` names `Archive`,
    /// whose files every lock check compares by the disk's spelling.
    fn existing_folder(&self, target: &str) -> Result<String, NotesError> {
        let given = vault_folder(self.root, &normalize_folder_path(target))?;
        if given.is_empty() {
            return Err(NotesError::FolderNotFound);
        }
        let folder = match folder_on_disk(self.root, &given)? {
            OnDisk::Spelled(folder) => folder,
            OnDisk::NotPlain => given,
            OnDisk::Ambiguous => return Err(NotesError::FolderNotFound),
        };
        match self.root.join(&folder).is_dir() {
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
