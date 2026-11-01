//! `TagHub`: the desktop tag hub's edits (`tags:update-color`, `tags:update-icon`, the category
//! commands and `tags:reorder`) over [`tag_admin`] and [`tag_categories`], under this device's
//! identity. Reached from [`crate::api::vault::Vault::tag_hub`]. Not on the FFI surface: iOS
//! sets a colour and an icon through [`Tasks`] and has no hub. Every method blocks.

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::tag_admin;
use crate::domain::tag_categories::{self, TagAssignment, TagCategory};
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;

pub struct TagHub {
    db: Db,
    device_id: String,
}

impl TagHub {
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let tasks = Tasks::over(db, store)?;
        Ok(Self {
            db: tasks.db,
            device_id: tasks.device_id,
        })
    }

    /// A colour picked by a person; creates the tag's definition when it has none.
    pub fn set_color(&self, tag: &str, color: &str) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| tag_admin::set_color(conn, tag, color, &self.device_id, now_ms()))
    }

    /// An emoji or `icon:Name`; `None` clears it.
    pub fn set_icon(&self, tag: &str, icon: Option<&str>) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| tag_admin::set_icon(conn, tag, icon, &self.device_id, now_ms()))
    }

    pub fn create_category(&self, name: &str) -> Result<TagCategory, StorageError> {
        self.db
            .call_blocking(|conn| tag_categories::create(conn, name, &self.device_id, now_ms()))
    }

    pub fn rename_category(&self, id: &str, name: &str) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| tag_categories::rename(conn, id, name, &self.device_id, now_ms()))
    }

    /// Returns how many tags left the category.
    pub fn delete_category(&self, id: &str) -> Result<usize, StorageError> {
        self.db
            .call_blocking(|conn| tag_categories::delete(conn, id, &self.device_id, now_ms()))
    }

    /// A drag in the hub: tag assignments and category order, all or nothing.
    pub fn arrange(
        &self,
        assignments: &[TagAssignment],
        order: &[(String, i64)],
    ) -> Result<(), StorageError> {
        self.db.call_blocking(|conn| {
            tag_categories::arrange(conn, assignments, order, &self.device_id, now_ms())
        })
    }
}
