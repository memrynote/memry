//! The single-field setters beside the ones in [`super`] (`set_title`,
//! `set_due`, `set_priority`, `set_tags`, `set_completed`, `set_archived`,
//! `assign`). Each is one [`super::edit`]: one transaction, one outbox row,
//! the document clock and the changed field's clock ticked.
//!
//! `linkedNoteIds` and `linkedCanvasIds`, like `tags`, are not in
//! `TASK_SYNCABLE_FIELDS` (§6.7), so no field clock ticks for them.

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::storage::repositories::Change;
use crate::sync::outbox::Durable;

use super::{edit, nullable};

/// Sets the markdown description, or clears it with `None`.
pub fn set_description(
    conn: &Connection,
    task_id: &str,
    description: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![("description", Change::Set(nullable(description)))],
        device_id,
        now_ms,
    )
}

/// Sets the start date (`YYYY-MM-DD`), or clears it with `None`.
pub fn set_start_date(
    conn: &Connection,
    task_id: &str,
    start_date: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![("startDate", Change::Set(nullable(start_date)))],
        device_id,
        now_ms,
    )
}

/// Sets the recurrence and what it repeats from, or clears both with `None`.
///
/// `repeat_config` is the wire value, written verbatim (D7): desktop's shape
/// is [`crate::domain::repeat_config::RepeatConfig::to_wire`].
pub fn set_repeat(
    conn: &Connection,
    task_id: &str,
    repeat_config: Option<&Value>,
    repeat_from: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![
            (
                "repeatConfig",
                Change::Set(repeat_config.cloned().unwrap_or(Value::Null)),
            ),
            ("repeatFrom", Change::Set(nullable(repeat_from))),
        ],
        device_id,
        now_ms,
    )
}

/// Replaces the linked note ids.
pub fn set_linked_note_ids(
    conn: &Connection,
    task_id: &str,
    note_ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![("linkedNoteIds", Change::Set(json!(note_ids)))],
        device_id,
        now_ms,
    )
}

/// Replaces the linked canvas ids.
pub fn set_linked_canvas_ids(
    conn: &Connection,
    task_id: &str,
    canvas_ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Durable<String>, StorageError> {
    edit(
        conn,
        task_id,
        vec![("linkedCanvasIds", Change::Set(json!(canvas_ids)))],
        device_id,
        now_ms,
    )
}
