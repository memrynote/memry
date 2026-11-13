//! `TagHub`: the desktop tag hub's edits (`tags:update-color`, `tags:update-icon`, the category
//! commands, `tags:reorder`) and a tag's pins, over [`tag_admin`], [`tag_categories`] and
//! [`tags`], under this device's identity. Reached from [`crate::api::vault::Vault::tag_hub`].
//! Not on the FFI surface: iOS sets a colour and an icon through [`Tasks`] and has no hub. Every
//! method blocks.

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::body_tags;
use crate::domain::notes::failed;
use crate::domain::tag_admin;
use crate::domain::tag_categories::{self, TagAssignment, TagCategory};
use crate::domain::tag_mint;
use crate::domain::tag_rename::{self, Holder, RenameJob, Started};
use crate::domain::tag_retag;
use crate::domain::tags;
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;
use crate::sync::engine::PassSeed;

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

    /// Mints a definition for each of `tags` that has no record ([`tag_mint::define_used`]);
    /// how many it minted.
    pub fn define_used(&self, tags: &[String]) -> Result<usize, StorageError> {
        self.db
            .call_blocking(|conn| tag_mint::define_used(conn, tags, now_ms()))
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

    /// The `#tags` the body of `id` carries now, cached ([`body_tags::write`]): a rename that
    /// wrote the file says them before the vault reads the file back, so the tag list read when
    /// the rename answers counts the new name alone. The read back writes the same.
    pub fn cache_body_tags(&self, id: &str, tags: &[String]) -> Result<(), StorageError> {
        self.db.call_blocking(|conn| {
            // One write: a cache half cleared drops tags the body has.
            let tx = conn.unchecked_transaction().map_err(failed)?;
            body_tags::write(&tx, id, tags)?;
            tx.commit().map_err(failed)
        })
    }

    /// `source` merged into `target`, or deleted with no `target`, in the record of the note or
    /// day `id` ([`tag_retag::retag`]).
    pub fn retag_in(
        &self,
        id: &str,
        source: &str,
        target: Option<&str>,
    ) -> Result<tag_retag::Retag, StorageError> {
        self.db.call_blocking(|conn| {
            tag_retag::retag(conn, id, source, target, &self.device_id, now_ms())
        })
    }

    /// A merge's part besides the notes and days ([`tag_retag::merge_shared`]): the number of
    /// tasks retagged.
    pub fn merge_shared(&self, source: &str, target: &str) -> Result<u32, StorageError> {
        self.db.call_blocking(|conn| {
            tag_retag::merge_shared(conn, source, target, &self.device_id, now_ms())
        })
    }

    /// A delete's part besides the notes and days ([`tag_retag::delete_shared`]): the number of
    /// tasks retagged.
    pub fn delete_shared(&self, tag: &str) -> Result<u32, StorageError> {
        self.db
            .call_blocking(|conn| tag_retag::delete_shared(conn, tag, &self.device_id, now_ms()))
    }

    /// Whether the recorded rename still lists the holder `id` ([`tag_rename::listed`]).
    pub fn rename_listed(&self, id: &str) -> Result<bool, StorageError> {
        self.db.read_blocking(|conn| tag_rename::listed(conn, id))
    }

    /// The file edit begun on the holder `id` ([`tag_rename::started`]).
    pub fn rename_started(&self, id: &str) -> Result<Option<Started>, StorageError> {
        self.db.read_blocking(|conn| tag_rename::started(conn, id))
    }

    /// The holder's file edit about to be written ([`tag_rename::start_holder`]).
    pub fn rename_start(&self, id: &str, before: &str, after: &str) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| tag_rename::start_holder(conn, id, before, after))
    }

    /// The file edit begun on the holder `id` forgotten, its file not written
    /// ([`tag_rename::unstart_holder`]).
    pub fn rename_unstart(&self, id: &str) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| tag_rename::unstart_holder(conn, id))
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

/// The minted definitions seeded by a sync pass ([`tag_mint::seed`]), as Electron's full sync
/// seeds its unclocked tag rows between its pull and its push. Step 17's driver registers it
/// with `SyncEngine::with_seed` for the open vault.
pub struct TagSeed(pub Arc<TagHub>);

#[async_trait::async_trait]
impl PassSeed for TagSeed {
    async fn seed(&self) -> Result<(), StorageError> {
        let hub = &self.0;
        let device_id = hub.device_id.clone();
        hub.db
            .call(move |conn| tag_mint::seed(conn, &device_id, now_ms()))
            .await?;
        Ok(())
    }
}
