//! A task's tag fields (§13.7.3.1): the read the detail draws and the one
//! write that sets a value. Definitions are desktop's to edit; a value lives
//! in the task's versioned `fields` map, not in note properties.

use serde_json::Value;

use crate::api::errors::StorageError;
use crate::api::task_records::TaskChange;
use crate::api::tasks::Tasks;
use crate::api::tasks_write::now_ms;
use crate::domain::tag_fields::{self, TagFieldGroup};
use crate::domain::{properties, task_activity, task_records, tasks};
use crate::storage::repositories::sync_items;
use crate::sync::versioned;

#[uniffi::export]
impl Tasks {
    /// The task's tag field groups, in desktop's drawer order, each field
    /// holding the task's value. Empty for a task this vault does not hold.
    pub fn tag_fields(&self, id: String) -> Result<Vec<TagFieldGroup>, StorageError> {
        self.db.read_blocking(move |conn| {
            let Some(task) = task_records::get(conn, &id)? else {
                return Ok(Vec::new());
            };
            let payload: Option<Value> = sync_items::load(conn, tasks::ITEM_TYPE, &id)?
                .and_then(|row| row.payload)
                .and_then(|raw| serde_json::from_str(&raw).ok());
            let values = versioned::plain(payload.as_ref().and_then(|p| p.get("fields")));
            tag_fields::groups(conn, &task.tags, &values, &properties::definitions(conn)?)
        })
    }

    /// Sets one field value as JSON text; `None` removes it. An unchanged
    /// value writes nothing. Not undoable: the returned change lists no prior
    /// fields, because restoring a versioned map whole would outrank peers.
    pub fn set_field_value(
        &self,
        id: String,
        name: String,
        value_json: Option<String>,
    ) -> Result<TaskChange, StorageError> {
        let value = match value_json {
            None => Value::Null,
            Some(raw) => serde_json::from_str(&raw).map_err(|error| StorageError::Invalid {
                what: format!("a field value is not JSON: {error}"),
            })?,
        };
        let device = self.device_id.clone();
        self.db.call_blocking(move |conn| {
            let now = now_ms();
            if let Some((old, new)) = tasks::set_field_value(conn, &id, &name, value, &device, now)?
            {
                // Best effort, as every task write's audit row is.
                let field = format!("fields.{name}");
                let _ =
                    task_activity::record_field_change(conn, &id, &field, &old, &new, &device, now);
            }
            Ok(TaskChange {
                changed: Vec::new(),
                created: Vec::new(),
                deleted: Vec::new(),
                removed: Vec::new(),
            })
        })
    }
}
