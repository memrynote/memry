//! `TagSchemas`: the desktop's edits of a tag's schema (`tags:edit-schema`), over
//! [`tag_schema::save`], under this device's identity. Reached from
//! [`crate::api::vault::Vault::tag_schemas`]. Not on the FFI surface: iOS reads fields
//! ([`crate::domain::tag_fields`]) and edits no schema. Every method blocks.

use std::sync::Arc;

use crate::api::errors::AuthError;
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
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

    /// Applies `edit` to `tag`'s schema and writes it ([`tag_schema::save`]).
    pub fn save(&self, tag: &str, edit: &SchemaEdit) -> Result<Stamped, SaveError> {
        self.db
            .call_blocking(|conn| Ok(tag_schema::save(conn, tag, edit, &self.device_id, now_ms())))
            .map_err(SaveError::Storage)?
    }
}
