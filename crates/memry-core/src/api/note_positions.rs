//! `NotePositions`: the sidebar's manual order ([`crate::domain::note_positions`]), for the
//! desktop vault tier's own file moves (Step 12), the app's creates and deletes (Step 13f), and the
//! sidebar's drag (Step 13g). Reached from
//! [`crate::api::vault::Vault::note_positions`]. Not exported over UniFFI: the order is
//! device-local, and iOS keeps no vault files.

use crate::api::errors::StorageError;
use crate::domain::note_positions::{self, NotePosition};
use crate::storage::Db;

pub struct NotePositions {
    db: Db,
}

impl NotePositions {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// [`note_positions::carry`]. Blocks; the shell runs it off the async runtime.
    pub fn carry(&self, old_path: &str, new_path: &str) -> Result<(), StorageError> {
        let (old_path, new_path) = (old_path.to_owned(), new_path.to_owned());
        self.db
            .call_blocking(move |conn| note_positions::carry(conn, &old_path, &new_path))
    }

    /// [`note_positions::place_at_top`]: a new item goes first in its folder.
    pub fn place_at_top(&self, path: &str, folder: &str) -> Result<(), StorageError> {
        let (path, folder) = (path.to_owned(), folder.to_owned());
        self.db
            .call_blocking(move |conn| note_positions::place_at_top(conn, &path, &folder))
    }

    /// [`note_positions::reorder`]: `paths` become the order of `folder`, all or nothing.
    pub fn reorder(&self, folder: &str, paths: Vec<String>) -> Result<(), StorageError> {
        let folder = folder.to_owned();
        self.db
            .call_blocking(move |conn| note_positions::reorder(conn, &folder, &paths))
    }

    /// [`note_positions::all`]: every ordered item, for the tree's first paint.
    pub fn all(&self) -> Result<Vec<NotePosition>, StorageError> {
        self.db.call_blocking(|conn| note_positions::all(conn))
    }

    /// [`note_positions::remove`]. True when the path had a slot.
    pub fn remove(&self, path: &str) -> Result<bool, StorageError> {
        let path = path.to_owned();
        self.db
            .call_blocking(move |conn| note_positions::remove(conn, &path))
    }
}
