//! [`NotesWriter`]'s answers to the desktop vault tier about the note a vault
//! file is (Step 13d): [`crate::domain::notes::identity`]. Not exported over
//! UniFFI: iOS keeps no vault files. Every method blocks; the shell runs them on
//! the tier's consumer thread.

use super::{NotesWriter, now_ms};
use crate::api::errors::StorageError;
use crate::domain::notes::identity::{self, Adopted, FileNote, Moved, Removed};

impl NotesWriter {
    /// The note of a file no row names: a note that is that file already, or a
    /// new one ([`identity::adopt`]).
    pub fn adopt_file(&self, file: FileNote<'_>) -> Result<Adopted, StorageError> {
        let device_id = self.device_id.clone();
        let (title, folder) = (file.title.to_owned(), file.folder_path.map(str::to_owned));
        let (created_ms, modified_ms, electron_db_beside) =
            (file.created_ms, file.modified_ms, file.electron_db_beside);
        self.db.call_blocking(move |conn| {
            let file = FileNote {
                title: &title,
                folder_path: folder.as_deref(),
                created_ms,
                modified_ms,
                electron_db_beside,
            };
            identity::adopt(conn, &file, &Self::new_id(), &device_id, now_ms())
        })
    }

    /// The note's file moved ([`identity::renamed`]).
    pub fn file_moved(&self, note_id: &str, moved: Moved<'_>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        let note_id = note_id.to_owned();
        let (old_path, new_path) = (moved.old_path.to_owned(), moved.new_path.to_owned());
        let (title, folder) = (moved.title.to_owned(), moved.folder_path.map(str::to_owned));
        self.db.call_blocking(move |conn| {
            let moved = Moved {
                old_path: &old_path,
                new_path: &new_path,
                title: &title,
                folder_path: folder.as_deref(),
            };
            identity::renamed(conn, &note_id, &moved, &device_id, now_ms())
        })
    }

    /// The note's file at `path` is gone ([`identity::removed`]).
    pub fn file_removed(&self, note_id: &str, path: &str) -> Result<Removed, StorageError> {
        let device_id = self.device_id.clone();
        let (note_id, path) = (note_id.to_owned(), path.to_owned());
        self.db.call_blocking(move |conn| {
            identity::removed(conn, &note_id, &path, &device_id, now_ms())
        })
    }
}
