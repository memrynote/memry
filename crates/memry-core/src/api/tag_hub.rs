//! `TagHub`: the desktop tag hub's edits (`tags:update-color`, `tags:update-icon`, the category
//! commands, `tags:reorder`) and a tag's pins, over [`tag_admin`], [`tag_categories`] and
//! [`tags`], under this device's identity. Reached from [`crate::api::vault::Vault::tag_hub`].
//! Not on the FFI surface: iOS sets a colour and an icon through [`Tasks`] and has no hub. Every
//! method blocks.

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::tag_admin;
use crate::domain::tag_categories::{self, TagAssignment, TagCategory};
use crate::domain::tag_rename::{self, Holder, RenameJob, RenamePlan};
use crate::domain::tags;
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

    /// Pins or unpins `tag` on the note or journal day `id` ([`tags::set_pinned`]); `false`
    /// when it already was so.
    pub fn set_pinned(&self, id: &str, tag: &str, pinned: bool) -> Result<bool, StorageError> {
        self.db.call_blocking(|conn| {
            tags::set_pinned(conn, id, tag, pinned, &self.device_id, now_ms())
        })
    }

    /// Records `job` as the rename in progress with its plan, or answers the other one recorded
    /// ([`tag_rename::begin`]).
    pub fn rename_begin(
        &self,
        job: &RenameJob,
        holders: Vec<Holder>,
    ) -> Result<Option<RenameJob>, StorageError> {
        self.db
            .call_blocking(|conn| tag_rename::begin(conn, job, holders))
    }

    /// The rename in progress and what it has left ([`tag_rename::recorded`]).
    pub fn rename_recorded(&self) -> Result<Option<RenamePlan>, StorageError> {
        self.db.read_blocking(tag_rename::recorded)
    }

    pub fn rename_finish(&self) -> Result<(), StorageError> {
        self.db.call_blocking(|conn| tag_rename::finish(conn))
    }

    /// What the recorded rename has left of its tasks, definitions and schema references
    /// ([`tag_rename::rename_shared`]).
    pub fn rename_shared(&self) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| tag_rename::rename_shared(conn, &self.device_id, now_ms()))
    }

    /// The recorded rename in the record of the holder `id`, struck off the plan
    /// ([`tag_rename::rename_holder`]); `false` when the record did not change.
    pub fn rename_in(&self, id: &str) -> Result<bool, StorageError> {
        self.db
            .call_blocking(|conn| tag_rename::rename_holder(conn, id, &self.device_id, now_ms()))
    }

    /// The holder `id` struck off the recorded rename, keeping the old name
    /// ([`tag_rename::skip_holder`]).
    pub fn rename_skip(&self, id: &str) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| tag_rename::skip_holder(conn, id))
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
