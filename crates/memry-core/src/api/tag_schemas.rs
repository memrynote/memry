//! `TagSchemas`: the desktop's edits of a tag's schema (`tags:edit-schema`), over
//! [`tag_schema::save`], under this device's identity. Reached from
//! [`crate::api::vault::Vault::tag_schemas`]. Not on the FFI surface: iOS reads fields
//! ([`crate::domain::tag_fields`]) and edits no schema. Every method blocks.

use std::sync::Arc;

use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::tag_schema::rename::{self, FieldRenameJob};
use crate::domain::tag_schema::{self, SaveError, SchemaEdit, Stamped};
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;

pub struct TagSchemas {
    db: Db,
    device_id: String,
}

impl TagSchemas {
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let tasks = Tasks::over(db, store)?;
        Ok(Self {
            db: tasks.db,
            device_id: tasks.device_id,
        })
    }

    /// Hides the tag hub's ready-made tags on this device ([`tag_schema::dismiss_preset_offer`]).
    pub fn dismiss_preset_offer(&self) -> Result<(), StorageError> {
        self.db
            .call_blocking(|conn| tag_schema::dismiss_preset_offer(conn))
    }

    /// Applies `edit` to `tag`'s schema and writes it ([`tag_schema::save`]).
    pub fn save(&self, tag: &str, edit: &SchemaEdit) -> Result<Stamped, SaveError> {
        self.db
            .call_blocking(|conn| Ok(tag_schema::save(conn, tag, edit, &self.device_id, now_ms())))
            .map_err(SaveError::Storage)?
    }

    /// Refuses a field rename any schema refuses, writing nothing ([`rename::plan`]).
    pub fn plan_field_rename(&self, from: &str, to: &str) -> Result<(), SaveError> {
        self.db
            .read_blocking(|conn| Ok(rename::plan(conn, from, to)))
            .map_err(SaveError::Storage)?
    }

    /// Records the field rename before its first write ([`rename::record`]).
    pub fn begin_field_rename(&self, job: &FieldRenameJob) -> Result<(), StorageError> {
        self.db.call_blocking(|conn| rename::record(conn, job))
    }

    /// Clears the recorded field rename once nothing is left ([`rename::finish`]).
    pub fn finish_field_rename(&self) -> Result<(), StorageError> {
        self.db.call_blocking(|conn| rename::finish(conn))
    }

    /// Renames the field in every tag schema and saved view ([`rename::rename_in_definitions`]):
    /// the tag keys it changed.
    pub fn rename_field(
        &self,
        from: &str,
        to: &str,
        resuming: bool,
    ) -> Result<Vec<String>, SaveError> {
        self.db
            .call_blocking(|conn| {
                Ok(rename::rename_in_definitions(
                    conn,
                    from,
                    to,
                    resuming,
                    &self.device_id,
                    now_ms(),
                ))
            })
            .map_err(SaveError::Storage)?
    }
}
