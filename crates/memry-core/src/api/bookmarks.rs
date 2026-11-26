//! Desktop's bookmark reads (`bookmarks:list`, `get`, `get-by-item`,
//! `is-bookmarked`, `list-by-type`), Step 30a (#3547). The rules are
//! [`crate::domain::bookmarks`]'s; the writes are on
//! [`crate::api::notes_write::NotesWriter`], which carries the device
//! identity a write ticks. Not on the FFI surface: the phone reads its list
//! through [`crate::api::notes::Notes`].

use crate::api::errors::StorageError;
use crate::domain::bookmarks::{self, Bookmark, Page, PageQuery};
use crate::storage::Db;

/// Bookmark reads over one opened vault.
pub struct Bookmarks {
    db: Db,
}

impl Bookmarks {
    /// Built by [`crate::api::vault::Vault::bookmarks`].
    pub(crate) fn over(db: Db) -> Self {
        Self { db }
    }

    /// One page of live bookmarks, each with what it resolves to.
    pub fn page(&self, query: PageQuery) -> Result<Page, StorageError> {
        self.db
            .read_blocking(move |conn| bookmarks::page(conn, &query))
    }

    /// The live bookmark `id`.
    pub fn get(&self, id: String) -> Result<Option<Bookmark>, StorageError> {
        self.db.read_blocking(move |conn| bookmarks::get(conn, &id))
    }

    /// The live bookmark of an item.
    pub fn get_by_item(
        &self,
        item_type: String,
        item_id: String,
    ) -> Result<Option<Bookmark>, StorageError> {
        self.db
            .read_blocking(move |conn| bookmarks::get_by_item(conn, &item_type, &item_id))
    }

    /// Whether a live bookmark names the item.
    pub fn is_bookmarked(&self, item_type: String, item_id: String) -> Result<bool, StorageError> {
        self.db
            .read_blocking(move |conn| bookmarks::is_bookmarked(conn, &item_type, &item_id))
    }
}
