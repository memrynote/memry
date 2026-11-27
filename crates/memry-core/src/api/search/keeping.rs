//! The command line's [`Search`] beside a running app: an open that never sets `index.db`
//! aside, and a reindex that reports every count. Not on the FFI surface.

use std::path::PathBuf;

use super::{Search, SharedPass, now_ms};
use crate::api::errors::StorageError;
use crate::domain::search;
use crate::storage::Db;

impl Search {
    /// [`Search::over`] over [`crate::storage::index_db::open_keeping`]: never sets
    /// `index.db` aside.
    pub(crate) fn over_keeping(
        data: Db,
        pass: SharedPass,
        directory: &str,
    ) -> Result<Self, StorageError> {
        let directory = PathBuf::from(directory);
        let opened = crate::storage::index_db::open_keeping(&directory.join("index.db"))?;
        Ok(Self {
            data,
            index: opened.db,
            pass,
            directory,
            semantic: None,
        })
    }

    /// [`Search::reindex`] with every count of the pass, inbox items included. For the command
    /// line's `vault reindex`. Not on the FFI surface.
    #[doc(hidden)]
    pub fn reindex_counts(&self) -> Result<search::Reindexed, StorageError> {
        let index = self.index.clone();
        self.data.call_blocking(move |data| {
            index.call_blocking(|index| search::reindex(data, index, now_ms()))
        })
    }
}
