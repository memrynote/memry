//! The disk brought in line with the locks (Electron `reconcileLockedFiles` and
//! `adoptCopiedVaultIdentities`).

use std::fs;
use std::path::Path;

use memry_core::api::errors::StorageError;

use super::mode::Found;
use super::{ATTACHMENTS_DIR, Locks, SCOPE};
use crate::vault::note_file::read_note;
use crate::vault::paths::open_vault_file;

impl Locks<'_> {
    /// Every locked file read-only, every locked markdown note with a baseline, every note that
    /// lost its lock writable again with its baseline dropped, and every recorded file no lock
    /// covers any more given its recorded bits back. (Electron's pass for a folder just unlocked
    /// comes with the lock command.)
    pub fn reconcile(&self) -> Result<(), StorageError> {
        let store = self.vault.locks();
        let files = self.vault.note_files();
        let state = store.list()?;
        for note_id in &state.notes {
            if let Some(file) = files.by_id(note_id)? {
                self.protect_note_file(note_id, &file.path)?;
            }
        }
        for folder in &state.folders {
            for rel in files_under(self.root, folder) {
                match files.by_path(&rel)? {
                    Some(file) => self.protect_note_file(&file.note_id, &rel)?,
                    None => self.protect_as_found(&rel),
                }
            }
        }
        for note_id in store.baseline_note_ids()? {
            if store.is_note_locked(&note_id, None)? {
                continue;
            }
            if let Some(file) = files.by_id(&note_id)? {
                self.release(&file.path);
            }
            store.delete_baseline(&note_id)?;
        }
        for (rel, _) in store.file_modes()? {
            if !self.is_path_locked(&rel)? {
                self.release(&rel);
            }
        }
        Ok(())
    }

    /// `protectNoteFile`: read-only with the files of its attachments folder, and its text as
    /// the baseline when it is a markdown note that has none.
    fn protect_note_file(&self, note_id: &str, rel: &str) -> Result<(), StorageError> {
        let store = self.vault.locks();
        if rel.ends_with(".md") && store.baseline(note_id)?.is_none() {
            match read_note(self.root, rel) {
                Ok(Some(file)) => store.write_baseline(note_id, &file.raw, &file.hash)?,
                Ok(None) => {}
                // Outside the vault, not UTF-8, too large: no text to restore, and an outside
                // edit of it then becomes the baseline.
                Err(error) => tracing::warn!(
                    scope = SCOPE,
                    note_id,
                    "a locked note's text was not recorded: {error}"
                ),
            }
        }
        self.protect_as_found(rel);
        for attachment in files_under(self.root, &format!("{ATTACHMENTS_DIR}/{note_id}")) {
            self.protect_as_found(&attachment);
        }
        Ok(())
    }

    /// At open: a vault copied or restored with its data gives every file a new identity, so
    /// each record would name another file and unlocking would keep the read-only bits. When
    /// every recorded file still on disk has a new identity and exactly the bits the lock left,
    /// the records move to the new identities. One file that really changed keeps the per-file
    /// rule. Never fails: a record left as it is only frees less on unlock.
    pub fn adopt_copied_identities(&self) {
        if let Err(error) = self.try_adopt_copied_identities() {
            tracing::warn!(
                scope = SCOPE,
                "the records of locked files did not follow a copied vault: {error}"
            );
        }
    }

    fn try_adopt_copied_identities(&self) -> Result<(), StorageError> {
        let store = self.vault.locks();
        let mut moved = Vec::new();
        for (rel, row) in store.file_modes()? {
            // A file that cannot be read is skipped here; the reconcile logs it when its mode
            // cannot change.
            let Ok(Some(file)) = open_vault_file(self.root, &rel) else {
                continue;
            };
            let Ok(found) = Found::of(&file) else {
                continue;
            };
            if row
                .identity
                .as_deref()
                .is_none_or(|id| id == found.identity)
            {
                return Ok(());
            }
            if found.mode & 0o777 != row.mode & !0o222 {
                return Ok(());
            }
            moved.push((rel, row.mode, found.identity));
        }
        if moved.is_empty() {
            return Ok(());
        }
        for (rel, mode, identity) in &moved {
            store.record_file_mode(rel, *mode, Some(identity))?;
        }
        tracing::info!(
            scope = SCOPE,
            files = moved.len(),
            "locked files have new identities, as in a copied vault; kept their recorded modes"
        );
        Ok(())
    }
}

/// Every file under the vault folder `folder`, vault-relative with `/`, skipping hidden entries
/// (a folder's `.folder.md` among them) and never following a link (`listFilesUnder`). A folder
/// that cannot be read lists nothing.
fn files_under(root: &Path, folder: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![folder.to_owned()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(root.join(&dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let rel = format!("{dir}/{name}");
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(rel),
                Ok(kind) if kind.is_file() => found.push(rel),
                _ => {}
            }
        }
    }
    found
}
