//! A locked note's file changed or removed outside the app gets its locked text back (Electron
//! `restoreLockedNoteFile`, `vault-locks/service.ts`). The vault consumer asks before it feeds
//! an outside edit or deletes a removed file's note, so neither reaches the document, the record
//! or the peers. That covers what changed while the app was closed too: the watcher's first
//! rescan reports the removals and the open walk the edits, through the same consumer. Electron
//! checks again after its walk because its index can be empty at open (#2978); here the rows and
//! the baselines live in the one `data.db`, so the consumer always knows the note.
//!
//! The app's own writes are not reverted: [`Locks::write_through`] records what it wrote as the
//! baseline, and a file that holds its baseline is left alone.

use memry_core::api::errors::StorageError;

use super::{Locks, SCOPE};
use crate::vault::late_writes::Replaced;
use crate::vault::note_file::{NoteFile, NoteFileError, write_new_text, write_note_over};

#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
    #[error(transparent)]
    Storage(#[from] StorageError),
    /// The changed text could not be kept as a version, so nothing is written over it.
    #[error("the outside change was not kept as a version: {0}")]
    Unkept(StorageError),
    #[error("the locked text was not written back: {0}")]
    Write(#[from] NoteFileError),
}

impl Locks<'_> {
    /// The locked note `note_id`'s file at `rel` holds `changed`, or is gone (`None`).
    ///
    /// `Ok(Some)`: `changed` is kept as a version and the locked text is back on disk; the
    /// caller feeds and deletes nothing, and keeps what a writer still writing `changed` puts in
    /// it ([`Replaced`]). `Ok(None)`: the caller goes on as for any file: the
    /// note is not locked, or one of Electron's fallbacks holds: no baseline (`changed` becomes
    /// it), or `changed` is the baseline. `Err`: the file is left as it is, its text kept as a
    /// version or not; the caller tries again later, and feeds nothing meanwhile. Electron feeds
    /// a change it could not keep, which sends it to every device past the lock.
    pub fn restore(
        &self,
        note_id: &str,
        rel: &str,
        changed: Option<&NoteFile>,
    ) -> Result<Option<Replaced>, RestoreError> {
        let store = self.vault.locks();
        if !store.is_note_locked(note_id, Some(rel))? {
            return Ok(None);
        }
        let Some(baseline) = store.baseline(note_id)? else {
            if let Some(file) = changed {
                store.write_baseline(note_id, &file.raw, &file.hash)?;
            }
            return Ok(None);
        };
        if let Some(file) = changed {
            if file.hash == baseline.content_hash {
                return Ok(None);
            }
            self.vault
                .write_back()
                .keep_outside_write(note_id, &file.raw, file.split().body)
                .map_err(RestoreError::Unkept)?;
        }
        // Only over the bytes just kept, or into the path while it is free: a newer outside
        // edit is the watcher's next report, and is kept before it is written over.
        let replaced = self.write_through(rel, &baseline.content, || match changed {
            Some(file) => write_note_over(self.root, rel, &baseline.content, &file.hash),
            None => write_new_text(self.root, rel, &baseline.content).map(|()| Replaced::default()),
        })?;
        tracing::warn!(
            scope = SCOPE,
            note_id,
            removed = changed.is_none(),
            "wrote the locked text back over an outside change"
        );
        Ok(Some(replaced))
    }
}
