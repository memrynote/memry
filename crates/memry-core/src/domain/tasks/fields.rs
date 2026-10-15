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
use crate::domain::notes::{clock_in, require_payload};
use crate::storage::repositories::Change;
use crate::sync::clock::clock_total;
use crate::sync::field_merge::TASK_SYNCABLE_FIELDS;
use crate::sync::outbox::{self, Durable};
use crate::sync::versioned;

use super::{ITEM_TYPE, edit, edit_merged_in, nullable};

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

/// `TASK_FIELD_LIMITS` (`packages/contracts/src/tasks-api.ts`): the caps a
/// local write is held to. A synced value is another device's data and is
/// never checked.
const FIELD_NAME_MAX: usize = 200;
const FIELD_TEXT_MAX: usize = 10_000;
const FIELD_LIST_MAX: usize = 500;

/// Sets one tag field value on a task, stamped by chapter 06 §6.11.3. An
/// unfilled value (`null`, blank text, an empty list) removes it, as desktop's
/// drawer writes it (`isFilledValue`). Returns the plain value before and
/// after, or `None` when the value did not change and nothing was written.
pub fn set_field_value(
    conn: &Connection,
    task_id: &str,
    name: &str,
    value: Value,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<(Value, Value)>, StorageError> {
    let value = match &value {
        Value::String(text) if text.trim().is_empty() => Value::Null,
        Value::Array(items) if items.is_empty() => Value::Null,
        _ => value,
    };
    let length = name.encode_utf16().count();
    let too_long = match &value {
        Value::String(text) => text.encode_utf16().count() > FIELD_TEXT_MAX,
        Value::Array(items) => items.len() > FIELD_LIST_MAX,
        _ => false,
    };
    if name.trim().is_empty() || length > FIELD_NAME_MAX || too_long {
        return Err(StorageError::Invalid {
            what: format!("`{name}` cannot hold that value"),
        });
    }
    let stored = require_payload(conn, ITEM_TYPE, task_id)?;
    let fields = stored.object().get("fields");
    let before = versioned::plain(fields)
        .get(name)
        .cloned()
        .unwrap_or(Value::Null);
    if before == value {
        return Ok(None);
    }
    // `_offline` is part of the total (§6.11.3), and a total is never negative.
    let total = u64::try_from(clock_total(&clock_in(stored.object())?)).unwrap_or(0);
    let patch = serde_json::Map::from_iter([(name.to_owned(), value.clone())]);
    let next = versioned::stamp_map(fields, &patch, total);
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, task_id),
        now_ms,
        |tx| {
            edit_merged_in(
                tx,
                ITEM_TYPE,
                &TASK_SYNCABLE_FIELDS,
                task_id,
                vec![("fields", Change::Set(next))],
                device_id,
                now_ms,
            )
        },
    )?
    .acknowledge();
    Ok(Some((before, value)))
}
