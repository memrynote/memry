//! `Versions`: a note's kept versions for the desktop version history (Step 14d,
//! `notes-versions.ts`). Reached from [`crate::api::vault::Vault::versions`]. Not exported
//! over UniFFI: iOS keeps no versions. The rules are in [`crate::domain::note_snapshots`];
//! a restore goes through the desktop's app edit, which keeps the replaced text with
//! [`crate::api::write_back::WriteBackReader::keep_restore_point`]. Every method blocks; the
//! shell runs them off the async runtime.

use crate::api::errors::StorageError;
use crate::api::tasks_write::now_ms;
use crate::domain::note_snapshots::{self, Kept, Listed, Reason, Version};
use crate::domain::write_back;
use crate::markdown::frontmatter::split_frontmatter_block;
use crate::storage::Db;

pub struct Versions {
    db: Db,
}

impl Versions {
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// [`note_snapshots::list`].
    pub fn list(&self, note_id: &str) -> Result<Vec<Listed>, StorageError> {
        self.db
            .read_blocking(|conn| note_snapshots::list(conn, note_id))
    }

    /// [`note_snapshots::get`].
    pub fn get(&self, id: &str) -> Result<Option<Kept>, StorageError> {
        self.db.read_blocking(|conn| note_snapshots::get(conn, id))
    }

    /// [`note_snapshots::delete`].
    pub fn delete(&self, id: &str) -> Result<bool, StorageError> {
        self.db
            .call_blocking(|conn| note_snapshots::delete(conn, id))
    }

    /// Keeps `content`, the file of a note open as the app quits, as a [`Reason::Close`]
    /// version (`createCloseSnapshot`). False when the note holds that text already, or there
    /// is no live note or day by that id.
    pub fn keep_close(&self, note_id: &str, content: &str) -> Result<bool, StorageError> {
        let now = now_ms();
        self.db.call_blocking(|conn| {
            let Some(title) = write_back::title(conn, note_id)? else {
                return Ok(false);
            };
            let version = Version {
                note_id,
                content,
                body: split_frontmatter_block(content).body,
                title: &title,
                reason: Reason::Close,
            };
            note_snapshots::keep(conn, version, now)
        })
    }
}
