//! [`NotesWriter`]'s answers to the desktop vault tier about the note a vault
//! file is (Step 13d): [`crate::domain::notes::identity`]. Not exported over
//! UniFFI: iOS keeps no vault files. Every method blocks; the shell runs them on
//! the tier's consumer thread.

use super::{NotesWriter, now_ms};
use crate::api::errors::StorageError;
use crate::crdt::errors::CrdtError;
use crate::domain::notes::identity::{self, Adopted, FileNote, Moved, OwedPlace, Removed};
use crate::markdown::convert::api::Converter;

impl NotesWriter {
    /// Whether a note may be the file of this title and folder: [`Self::adopt_file`]
    /// then needs a converter to read its body with.
    pub fn may_be_a_note(
        &self,
        title: &str,
        folder_path: Option<&str>,
    ) -> Result<bool, StorageError> {
        self.db
            .call_blocking(move |conn| identity::has_unfiled_note(conn, title, folder_path))
    }

    /// The note of a file no row names: a note that is that file already, or a
    /// new one ([`identity::adopt`]).
    pub fn adopt_file(
        &self,
        file: FileNote<'_>,
        converter: Option<&Converter>,
    ) -> Result<Adopted, CrdtError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| {
                Ok(identity::adopt(
                    conn,
                    converter,
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

    /// The note's file moved from `from_path` and its record was left as it was
    /// ([`identity::owe_place`]).
    pub fn owe_place(&self, note_id: &str, from_path: &str) -> Result<(), StorageError> {
        self.db
            .call_blocking(move |conn| identity::owe_place(conn, note_id, from_path, now_ms()))
    }

    /// The moves the records are owed ([`identity::owed_places`]).
    pub fn owed_places(&self) -> Result<Vec<OwedPlace>, StorageError> {
        self.db.call_blocking(|conn| identity::owed_places(conn))
    }

    /// The note's file at `path` is gone ([`identity::removed`]).
    pub fn file_removed(&self, note_id: &str, path: &str) -> Result<Removed, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| identity::removed(conn, note_id, path, &device_id, now_ms()))
    }
}
