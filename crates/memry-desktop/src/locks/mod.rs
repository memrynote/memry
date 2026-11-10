//! The desktop side of read-only locks (Step 14e-2b, #3531), the port of Electron's
//! `vault-locks/{registry,files,service}.ts` over the core's [`LockStore`].
//!
//! A lock stops what this device does to a note or a folder. The core refuses the body and
//! record edits (14e-2a); this module refuses what moves, creates or removes files, keeps a
//! locked file read-only on disk ([`mode`]), brings the disk in line with the locks at every
//! open ([`reconcile`]), and gives a locked note's file changed or removed outside the app its
//! locked text back ([`restore`]).
//!
//! Electron lifts its checks inside `runWithLockedWritesAllowed`, an ambient async scope. Rust
//! has none, so each writer states its own: an operation of this device refuses at its entry
//! ([`Locks::refuse_note`] and its siblings), before anything is written, and a writer that
//! only carries another device's text (the write-back of a locked note's document, whose local
//! edits the core refuses) goes through [`Locks::write_through`].
//!
//! [`LockStore`]: memry_core::api::vault_locks::LockStore

mod mode;
mod reconcile;
mod restore;

pub use restore::RestoreError;

use std::path::Path;
use std::sync::Arc;

use memry_core::api::errors::StorageError;
use memry_core::api::vault::Vault;
use memry_core::domain::vault_locks::normalize_folder_path;

use crate::notes::error::NotesError;
use crate::session::{OpenStage, OpenVault, Session};
use crate::vault::layout::ATTACHMENTS_DIR;

const SCOPE: &str = "vault_locks";

/// A folder's own settings file, never locked: the folder's icon and template stay editable.
const FOLDER_CONFIG_FILE: &str = ".folder.md";

/// What a refused operation says, Electron's two fixed texts (`VAULT_LOCKED_NOTE_MESSAGE`,
/// `VAULT_LOCKED_FOLDER_MESSAGE`), which the renderer maps to its localized message and agents
/// relay verbatim. `Excluded`: the note's file is one no write of the app reaches
/// (`ExcludedPaths`, #3530 13m-7b-3b); the renderer maps its code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    Note,
    Folder,
    Excluded,
}

impl Refused {
    pub fn message(self) -> &'static str {
        match self {
            Self::Note => "The owner made this note read-only.",
            Self::Folder => "The owner made this folder read-only.",
            Self::Excluded => "This note is in an excluded folder.",
        }
    }
}

/// The locks of one open vault, and the files they cover.
pub struct Locks<'a> {
    root: &'a Path,
    vault: &'a Vault,
}

impl<'a> Locks<'a> {
    pub fn new(root: &'a Path, vault: &'a Vault) -> Self {
        Self { root, vault }
    }

    pub fn of(open: &'a OpenVault) -> Self {
        Self::new(&open.path, &open.vault)
    }

    /// `assertNoteWritable`: a rename, move or delete of a locked note, or of one in a locked
    /// folder; and of an excluded one, which Electron's index does not hold.
    pub fn refuse_note(&self, note_id: &str, path: &str) -> Result<(), NotesError> {
        if self.vault.locks().is_note_locked(note_id, Some(path))? {
            return Err(NotesError::Locked(Refused::Note));
        }
        match self.vault.excluded().covers(path) {
            true => Err(NotesError::Locked(Refused::Excluded)),
            false => Ok(()),
        }
    }

    /// Whether the file of the note or day `id` is excluded: a change across notes passes it
    /// by, as Electron's index-wide changes do, which never see it.
    pub fn is_excluded(&self, id: &str) -> Result<bool, StorageError> {
        let file = self.vault.note_files().by_id(id)?;
        Ok(file.is_some_and(|file| self.vault.excluded().covers(&file.path)))
    }

    /// `assertFolderWritable`: creating or moving anything into a locked folder.
    pub fn refuse_folder(&self, folder: &str) -> Result<(), NotesError> {
        match self.vault.locks().folder_covering(folder)? {
            Some(_) => Err(NotesError::Locked(Refused::Folder)),
            None => Ok(()),
        }
    }

    /// `assertParentFolderWritable`: creating a folder, or moving one, to a path inside a
    /// locked folder.
    pub fn refuse_parent_folder(&self, folder: &str) -> Result<(), NotesError> {
        let folder = normalize_folder_path(folder);
        self.refuse_folder(folder.rsplit_once('/').map_or("", |(parent, _)| parent))
    }

    /// `assertFolderTreeWritable`: a rename, move or delete of a folder that is locked, sits in
    /// a locked folder, or holds a locked folder or a locked note's file, each of which would
    /// move or remove a locked item with it.
    pub fn refuse_folder_tree(&self, folder: &str) -> Result<(), NotesError> {
        let folder = normalize_folder_path(folder);
        let state = self.vault.locks().list()?;
        let mut locked = state
            .folders
            .iter()
            .any(|locked| is_under(&folder, locked) || is_under(locked, &folder));
        for note_id in &state.notes {
            if locked {
                break;
            }
            let file = self.vault.note_files().by_id(note_id)?;
            locked = file.is_some_and(|file| is_under(&normalize_folder_path(&file.path), &folder));
        }
        match locked {
            true => Err(NotesError::Locked(Refused::Folder)),
            false => Ok(()),
        }
    }

    /// The refusal of a write to the vault file at `rel` (Electron's file guard,
    /// `beforeVaultFileWrite`): a locked note's file, or a file under a locked note's
    /// attachments, says "note"; any other file in a locked folder says "folder".
    pub fn refuse_path(&self, rel: &str) -> Result<(), NotesError> {
        if !self.is_path_locked(rel)? {
            // An excluded file, which no write of the app reaches, as Electron's index does not
            // hold it.
            return match self.vault.excluded().covers(rel) {
                true => Err(NotesError::Locked(Refused::Excluded)),
                false => Ok(()),
            };
        }
        let rel = normalize_folder_path(rel);
        let at_note = self.vault.note_files().by_path(&rel)?.is_some();
        match at_note || self.vault.locks().folder_covering(&rel)?.is_none() {
            true => Err(NotesError::Locked(Refused::Note)),
            false => Err(NotesError::Locked(Refused::Folder)),
        }
    }

    /// `isVaultPathLocked`: the file at `rel` sits in a locked folder, is a locked note's file,
    /// or is in a locked note's attachments folder. A folder's `.folder.md` never is. With no
    /// lock at all (every write-back pass asks) it reads the lock rows once and nothing else.
    pub fn is_path_locked(&self, rel: &str) -> Result<bool, StorageError> {
        let rel = normalize_folder_path(rel);
        if rel.rsplit('/').next() == Some(FOLDER_CONFIG_FILE) {
            return Ok(false);
        }
        let store = self.vault.locks();
        let state = store.list()?;
        if state.folders.iter().any(|folder| is_under(&rel, folder)) {
            return Ok(true);
        }
        if state.notes.is_empty() && state.folders.is_empty() {
            return Ok(false);
        }
        if let Some(owner) = attachment_owner(&rel)
            && store.is_note_locked(owner, None)?
        {
            return Ok(true);
        }
        if state.notes.is_empty() {
            return Ok(false);
        }
        let file = self.vault.note_files().by_path(&rel)?;
        Ok(file.is_some_and(|file| state.notes.contains(&file.note_id)))
    }

    /// `writeThroughLock`, for a writer that only carries another device's text: no refusal. A
    /// locked file's read-only attribute is cleared so the write can replace it (Windows refuses
    /// to replace a read-only file), and set again after, whether `write` landed or failed.
    /// Once it landed, `content` becomes the locked note's baseline, the text an outside edit
    /// is reverted to.
    pub fn write_through<T, E>(
        &self,
        rel: &str,
        content: &str,
        write: impl FnOnce() -> Result<T, E>,
    ) -> Result<T, E> {
        let locked = self.is_path_locked(rel).unwrap_or_else(|error| {
            // Not known to be locked: the write goes as for any file, and a read-only one fails
            // it, to be tried again.
            tracing::warn!(
                scope = SCOPE,
                "the lock of a written file could not be read: {error}"
            );
            false
        });
        if !locked {
            return write();
        }
        self.set_read_only(rel, false);
        let written = write();
        self.set_read_only(rel, true);
        if written.is_ok() {
            self.record_locked_bytes(rel, content);
        }
        written
    }

    /// `recordLockedBytes`: the bytes the app just put in a locked note's file become its
    /// baseline. Never fails: the file is written already.
    fn record_locked_bytes(&self, rel: &str, content: &str) {
        if !rel.ends_with(".md") {
            return;
        }
        let recorded = self.vault.note_files().by_path(rel).and_then(|file| {
            let Some(file) = file else {
                return Ok(());
            };
            let hash = crate::vault::hash::content_hash(content);
            self.vault
                .locks()
                .write_baseline(&file.note_id, content, &hash)
        });
        if let Err(error) = recorded {
            tracing::warn!(
                scope = SCOPE,
                "the locked text of a note was not recorded: {error}"
            );
        }
    }
}

/// Brings the disk in line with the locks at every open, before the watcher starts: records of
/// a copied vault follow its files, every locked file is read-only, and every file a lock no
/// longer covers is writable again (`checkLockedFilesAtOpen`, its restore of outside edits
/// aside). A failure is logged and never stops the open.
pub fn register(session: &Session) {
    session.on_open(
        "vault-lock-guard",
        OpenStage::LockGuard,
        Arc::new(|open| {
            let locks = Locks::of(open);
            locks.adopt_copied_identities();
            if let Err(error) = locks.reconcile() {
                tracing::warn!(
                    scope = SCOPE,
                    "the locked files were not brought in line: {error}"
                );
            }
            Ok(())
        }),
    );
}

/// The note that owns a file in its attachments folder (`attachments/<noteId>/<file>`). Fixed
/// like Electron's `getAttachmentsRoot`: the app saves attachments there whatever the vault
/// config says.
fn attachment_owner(rel: &str) -> Option<&str> {
    let mut segments = rel.split('/');
    match (
        segments.next(),
        segments.next(),
        segments.next(),
        segments.next(),
    ) {
        (Some(ATTACHMENTS_DIR), Some(owner), Some(_), None) => Some(owner),
        _ => None,
    }
}

/// `path` is `folder` or under it; every path is under the vault root `""`.
fn is_under(path: &str, folder: &str) -> bool {
    folder.is_empty()
        || path == folder
        || path
            .strip_prefix(folder)
            .is_some_and(|rest| rest.starts_with('/'))
}
