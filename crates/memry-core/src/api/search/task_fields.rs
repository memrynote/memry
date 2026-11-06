//! The task reads behind a tag schema change's counts (`tag-schema-counts.ts`'s
//! `taskIdsWithTags` and `taskFieldValues`): each live task's tags and the fields that hold a
//! value. Not on the FFI surface: iOS edits no schema.

use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::domain::tasks::ITEM_TYPE;
use crate::sync::versioned;

use super::Search;

/// A live task's tags as stored, and the names of its fields that hold a value: a value removed
/// holds none (`plainVersionedMap`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskFieldHolder {
    pub id: String,
    pub tags: Vec<String>,
    pub fields: Vec<String>,
}

impl Search {
    /// Every live task with its tags and filled fields. A payload that does not read as an
    /// object holds neither.
    pub fn task_field_holders(&self) -> Result<Vec<TaskFieldHolder>, StorageError> {
        self.data.read_blocking(|data| {
            let mut statement = data
                .prepare(
                    "SELECT item_id, payload FROM sync_items
                      WHERE item_type = ?1 AND deleted_at IS NULL AND payload IS NOT NULL",
                )
                .map_err(failed)?;
            let rows = statement
                .query_map([ITEM_TYPE], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(failed)?;
            let mut holders = Vec::new();
            for row in rows {
                let (id, raw) = row.map_err(failed)?;
                let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
                let tags = payload
                    .get("tags")
                    .and_then(Value::as_array)
                    .map(|tags| {
                        tags.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default();
                let fields = versioned::plain(payload.get("fields"))
                    .into_iter()
                    .map(|(name, _)| name)
                    .collect();
                holders.push(TaskFieldHolder { id, tags, fields });
            }
            Ok(holders)
        })
    }
}
