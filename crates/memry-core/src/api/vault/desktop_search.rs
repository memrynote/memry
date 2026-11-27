//! The desktop's and the command line's [`Search`] opens on [`Vault`]. Not on the FFI surface.

use std::sync::Arc;

use crate::api::errors::StorageError;
use crate::api::search::Search;
use crate::api::vault::Vault;

impl Vault {
    /// [`Vault::search`] for a process that is not the index's owner (the command line beside
    /// a running app): an `index.db` that needs a rebuild is an error and stays in place, so
    /// only the app ever sets it aside. Not on the FFI surface.
    #[doc(hidden)]
    pub fn search_keeping_index(&self) -> Result<Arc<Search>, StorageError> {
        Ok(Arc::new(Search::over_keeping(
            self.db.clone(),
            Arc::clone(&self.reindexing),
            &self.directory,
        )?))
    }

    /// [`Vault::search`] that also says why `index.db` was rebuilt (`None` when the file
    /// was reused or migrated in place). Not on the FFI surface.
    pub fn search_reporting(&self) -> Result<(Arc<Search>, Option<String>), StorageError> {
        // Desktop has no on-device semantic search (the `semantic` feature is iOS-only).
        let pass = Arc::clone(&self.reindexing);
        let (search, reason) =
            Search::over_reporting(self.db.clone(), pass, &self.directory, None)?;
        Ok((Arc::new(search), reason))
    }
}
