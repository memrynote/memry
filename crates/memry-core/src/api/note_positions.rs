//! `NotePositions`: the sidebar's manual order ([`crate::domain::note_positions`]), for the
//! desktop vault tier's own file moves (Step 12). Reached from
//! [`crate::api::vault::Vault::note_positions`]. Not exported over UniFFI: the order is
//! device-local, and iOS keeps no vault files.

use crate::api::errors::StorageError;
use crate::domain::note_positions;
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
}
