//! [`NotesWriter`]'s answers to the desktop vault tier about the note a vault
//! file is (Step 13d): [`crate::domain::notes::identity`]. Not exported over
//! UniFFI: iOS keeps no vault files. Every method blocks; the shell runs them on
//! the tier's consumer thread.

use super::{NotesWriter, now_ms};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::notes::identity::{self, Adopted, FileNote, Moved, Removed};
use crate::markdown::convert::api::Converter;

impl NotesWriter {
    /// The note of a file no row names: a note that is that file already, or a
    /// new one ([`identity::adopt`]). `converter` is built only when a note may be
    /// the file, to read its body.
    pub fn adopt_file(
        &self,
        file: FileNote<'_>,
        converter: impl FnOnce() -> Converter,
    ) -> Result<Adopted, CrdtError> {
        let device_id = self.device_id.clone();
        let (title, folder) = (file.title, file.folder_path);
        let may_be_a_note = self
            .db
            .call_blocking(move |conn| identity::has_unfiled_note(conn, title, folder))?;
        let converter = may_be_a_note.then(converter);
        self.db
            .call_blocking(move |conn| {
                Ok(identity::adopt(
                    conn,
                    converter.as_ref(),
                    &file,
                    &Self::new_id(),
                    &device_id,
                    now_ms(),
                ))
            })
            .map_err(CrdtError::from)?
    }

    /// The note's file moved ([`identity::renamed`]).
    pub fn file_moved(&self, note_id: &str, moved: Moved<'_>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            identity::renamed(conn, note_id, &moved, &device_id, now_ms())
        })
    }

    /// The note's file at `path` is gone ([`identity::removed`]).
    pub fn file_removed(&self, note_id: &str, path: &str) -> Result<Removed, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| identity::removed(conn, note_id, path, &device_id, now_ms()))
    }
}
