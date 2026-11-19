//! Desktop's bookmark writes (Step 30a, #3547), on the writer because each
//! one ticks this device's clock. Not on the FFI surface: the phone toggles
//! through [`NotesWriter::toggle_bookmark`]. The rules are
//! [`crate::domain::bookmarks`]'s.

use super::{NotesWriter, now_ms};
use crate::api::errors::StorageError;
use crate::domain::bookmarks::{self, Bookmark, Created, Toggled};

impl NotesWriter {
    /// `bookmarks:create`.
    pub fn create_bookmark(
        &self,
        item_type: String,
        item_id: String,
    ) -> Result<Created, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            bookmarks::create(conn, &item_type, &item_id, &device_id, now_ms())
        })
    }

    /// `bookmarks:toggle`, answering the row it created or the rows it removed.
    pub fn toggle_bookmark_rows(
        &self,
        item_type: String,
        item_id: String,
    ) -> Result<Toggled, StorageError> {
        let device_id = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            bookmarks::toggle_rows(conn, &item_type, &item_id, &device_id, now_ms())
        })
    }

    /// `bookmarks:delete`: the removed row, or `None` when none is live.
    pub fn delete_bookmark(&self, id: String) -> Result<Option<Bookmark>, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| bookmarks::delete(conn, &id, &device_id, now_ms()))
    }

    /// `bookmarks:reorder`.
    pub fn reorder_bookmarks(&self, ids: Vec<String>) -> Result<(), StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| bookmarks::reorder(conn, &ids, &device_id, now_ms()))
    }

    /// `bookmarks:bulk-create`: the rows it created.
    pub fn bulk_create_bookmarks(
        &self,
        items: Vec<(String, String)>,
    ) -> Result<Vec<Bookmark>, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| bookmarks::bulk_create(conn, &items, &device_id, now_ms()))
    }

    /// `bookmarks:bulk-delete`: the rows it removed.
    pub fn bulk_delete_bookmarks(&self, ids: Vec<String>) -> Result<Vec<Bookmark>, StorageError> {
        let device_id = self.device_id.clone();
        self.db
            .call_blocking(move |conn| bookmarks::bulk_delete(conn, &ids, &device_id, now_ms()))
    }
}
