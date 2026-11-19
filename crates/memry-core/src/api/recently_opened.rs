//! Desktop's "recently opened" trail (`recents:record`, `recents:list`), Step
//! 30a (#3547). The rules are [`crate::domain::recently_opened`]'s. Not on the
//! FFI surface: the Rust desktop shell is its only caller.

use crate::api::errors::StorageError;
use crate::domain::recently_opened::{self, Opened};
use crate::storage::Db;

/// The trail over one opened vault.
pub struct RecentlyOpened {
    db: Db,
}

impl RecentlyOpened {
    /// Built by [`crate::api::vault::Vault::recently_opened`].
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// Records that a note or canvas was opened now.
    pub fn record(&self, item_type: String, item_id: String) -> Result<(), StorageError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or_default();
        self.db
            .call_blocking(move |conn| recently_opened::record(conn, &item_type, &item_id, now))
    }

    /// The newest opened items that still exist, at most `limit`.
    pub fn list(&self, limit: u32) -> Result<Vec<Opened>, StorageError> {
        self.db
            .read_blocking(move |conn| recently_opened::list(conn, limit))
    }
}
