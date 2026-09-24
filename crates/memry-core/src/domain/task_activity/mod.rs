//! Task activity: the append-only audit trail per task (spec 004 TP025,
//! chapter 13 §13.7.5, §13.12).
//!
//! Desktop is the reference: `apps/desktop/src/main/tasks/activity-log.ts`
//! writes (this file), `apps/desktop/src/main/database/queries/task-activity.ts`
//! reads (`read.rs`).
//! Every rule below is theirs, restated only where the port has to pick a
//! shape.
//!
//! **Write side.** Each row is its own `task_activity` sync item with a fresh
//! nanoid-shaped id, a whole-row `clock` of this device's first tick, no
//! `fieldClocks`, and its own outbox row. Rows are immutable, so there is no
//! edit path. The caller records rows for its own local task writes only:
//! logging on the inbound path would make every device log every peer's
//! change and sync the rows back. `superseded` rows are never written here
//! (see [`super::tasks`]).
//!
//! The encoding is desktop's exactly: `oldValue`/`newValue` are
//! `JSON.stringify` of the value, `null` when the value is null; `position` and
//! `modifiedAt` are never logged; a field whose encoded old and new values are
//! equal is not logged; completion is its own action with `field:
//! "completedAt"`; archive is an ordinary `updated` row on `archivedAt`.
//! `description` never stores the body: `oldValue` is `null` and `newValue` is
//! `{"delta":<new length - old length>}` in UTF-16 code units, which is what
//! desktop's feed renders as "N characters added/removed".
//!
//! **Retention (§13.12).** A 90-day age rule. Inbound rows past it are already
//! refused by [`crate::storage::repositories::sync_items::apply_remote`]; reads
//! here never return them, and every record call prunes them locally in the
//! same transaction. A prune is never pushed: every device applies the same
//! rule.

mod read;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::crypto::sodium::random_bytes;
use crate::storage::repositories::projectors::tasks::TASK_ACTIVITY_RETENTION_DAYS;
use crate::storage::repositories::schema::Object;
use crate::sync::outbox;

use super::notes::{failed, insert_local, iso, next_clock, object};
use super::tasks::valid_item_id;

pub use read::{ActivityEntry, ActivityPage, ActivityQuery, count, list};

/// The `(type, _)` half of every key this module writes.
pub const ITEM_TYPE: &str = "task_activity";

/// Desktop's `TaskActivityActions`.
pub const ACTION_CREATED: &str = "created";
pub const ACTION_UPDATED: &str = "updated";
pub const ACTION_COMPLETED: &str = "completed";
pub const ACTION_UNCOMPLETED: &str = "uncompleted";
pub const ACTION_MOVED: &str = "moved";
pub const ACTION_DELETED: &str = "deleted";
/// Read only: written by desktop on a lost merge, never by this core.
pub const ACTION_SUPERSEDED: &str = "superseded";

/// The only actor this core writes. Desktop also reads `google_calendar` and
/// `sync`.
pub const ACTOR_USER: &str = "user";

/// Desktop's page size when the caller names none.
pub const DEFAULT_PAGE_LIMIT: usize = 50;

const MS_PER_DAY: i64 = 86_400_000;

/// Fields desktop never logs: a reorder would otherwise write one row per task.
const IGNORED_FIELDS: [&str; 2] = ["position", "modifiedAt"];

/// Stored as a length delta, never as the body.
const LENGTH_ONLY_FIELD: &str = "description";

const COMPLETED_AT: &str = "completedAt";

/// nanoid's `urlAlphabet`; 64 symbols, so `byte & 63` is uniform.
const NANOID_ALPHABET: &[u8; 64] =
    b"useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const NANOID_LEN: usize = 21;

/// One changed task field, as the task write saw it: the payload value before
/// and after. `Value::Null` is "no value" and encodes as a `null` column.
#[derive(Debug, Clone, Copy)]
pub struct FieldChange<'a> {
    pub field: &'a str,
    pub old: &'a Value,
    pub new: &'a Value,
}

/// A row about to be written.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NewActivity {
    action: &'static str,
    field: Option<String>,
    old_value: Option<String>,
    new_value: Option<String>,
}

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

/// `recordTaskCreated`: one `created` row whose `newValue` is the title.
pub fn record_created(
    conn: &Connection,
    task_id: &str,
    title: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let row = NewActivity {
        action: ACTION_CREATED,
        field: None,
        old_value: None,
        new_value: encode(&json!(title)),
    };
    record(conn, task_id, &[row], device_id, now_ms)
}

/// `recordTaskUpdated`: a `completed`/`uncompleted` row when `completedAt`
/// flipped, then one `updated` row per other changed field.
pub fn record_updated(
    conn: &Connection,
    task_id: &str,
    changes: &[FieldChange<'_>],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    record(conn, task_id, &updated_rows(changes), device_id, now_ms)
}

/// [`record_updated`] for a single field.
pub fn record_field_change(
    conn: &Connection,
    task_id: &str,
    field: &str,
    old: &Value,
    new: &Value,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    record_updated(
        conn,
        task_id,
        &[FieldChange { field, old, new }],
        device_id,
        now_ms,
    )
}

/// `recordTaskCompleted`: a `completed` or `uncompleted` row when the
/// `completedAt` values differ in truthiness, nothing otherwise.
pub fn record_completion(
    conn: &Connection,
    task_id: &str,
    old_completed_at: &Value,
    new_completed_at: &Value,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let rows: Vec<NewActivity> = completion_row(old_completed_at, new_completed_at)
        .into_iter()
        .collect();
    record(conn, task_id, &rows, device_id, now_ms)
}

/// `recordTaskMoved`: one `moved` row per changed field (`projectId`,
/// `statusId`, `parentId`; `position` is dropped).
pub fn record_moved(
    conn: &Connection,
    task_id: &str,
    changes: &[FieldChange<'_>],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    record(
        conn,
        task_id,
        &field_rows(ACTION_MOVED, changes),
        device_id,
        now_ms,
    )
}

/// `recordTaskDeleted`: one `deleted` row whose `oldValue` is the title, or
/// `null` when the caller had no snapshot.
pub fn record_deleted(
    conn: &Connection,
    task_id: &str,
    title: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let row = NewActivity {
        action: ACTION_DELETED,
        field: None,
        old_value: title.and_then(|title| encode(&json!(title))),
        new_value: None,
    };
    record(conn, task_id, &[row], device_id, now_ms)
}

/// Drops every row past the 90-day horizon: its projection, its stored
/// payload and any outbox row still queued for it. Never pushed (§13.12).
/// Returns how many rows went.
pub fn prune_expired(conn: &Connection, now_ms: i64) -> Result<usize, StorageError> {
    in_transaction(conn, |tx| prune_in(tx, now_ms))
}

/// Writes `rows` (possibly none) in one transaction, each with its outbox
/// row, and prunes expired rows alongside. Runs inside the caller's
/// transaction when one is open, so a caller can commit the task write and its
/// activity together; otherwise opens and commits its own.
fn record(
    conn: &Connection,
    task_id: &str,
    rows: &[NewActivity],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    valid_item_id(task_id)?;
    let created_at = iso(now_ms)?;
    in_transaction(conn, |tx| {
        let mut ids = Vec::with_capacity(rows.len());
        for row in rows {
            let id = mint_id();
            let payload = object(json!({
                "taskId": task_id,
                "action": row.action,
                "field": row.field,
                "oldValue": row.old_value,
                "newValue": row.new_value,
                "actor": ACTOR_USER,
                "deviceId": device_id,
                "clock": next_clock(&Object::new(), device_id)?,
                "createdAt": created_at,
            }));
            insert_local(tx, ITEM_TYPE, &id, payload, now_ms)?;
            outbox::enqueue(tx, &outbox::Change::upsert(ITEM_TYPE, &id), now_ms)?;
            ids.push(id);
        }
        prune_in(tx, now_ms)?;
        Ok(ids)
    })
}

fn updated_rows(changes: &[FieldChange<'_>]) -> Vec<NewActivity> {
    let completion = changes
        .iter()
        .find(|change| change.field == COMPLETED_AT)
        .and_then(|change| completion_row(change.old, change.new));
    let rest: Vec<FieldChange<'_>> = changes
        .iter()
        .filter(|change| change.field != COMPLETED_AT)
        .copied()
        .collect();
    completion
        .into_iter()
        .chain(field_rows(ACTION_UPDATED, &rest))
        .collect()
}

/// `fieldRows`: the noise fields dropped, `description` as a length delta,
/// and a field whose encoded values match skipped.
fn field_rows(action: &'static str, changes: &[FieldChange<'_>]) -> Vec<NewActivity> {
    let mut rows = Vec::new();
    for change in changes {
        if IGNORED_FIELDS.contains(&change.field) {
            continue;
        }
        if change.field == LENGTH_ONLY_FIELD {
            let delta = text_length(change.new) - text_length(change.old);
            rows.push(NewActivity {
                action,
                field: Some(change.field.to_owned()),
                old_value: None,
                new_value: Some(json!({ "delta": delta }).to_string()),
            });
            continue;
        }
        let old_value = encode(change.old);
        let new_value = encode(change.new);
        if old_value == new_value {
            continue;
        }
        rows.push(NewActivity {
            action,
            field: Some(change.field.to_owned()),
            old_value,
            new_value,
        });
    }
    rows
}

/// `completionRow`: completion is a state flip, keyed on truthiness.
fn completion_row(old: &Value, new: &Value) -> Option<NewActivity> {
    let was_complete = truthy(old);
    let is_complete = truthy(new);
    if was_complete == is_complete {
        return None;
    }
    Some(NewActivity {
        action: if is_complete {
            ACTION_COMPLETED
        } else {
            ACTION_UNCOMPLETED
        },
        field: Some(COMPLETED_AT.to_owned()),
        old_value: encode(old),
        new_value: encode(new),
    })
}

/// `encodeValue`: `JSON.stringify`, with `null` staying `null`.
fn encode(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        value => serde_json::to_string(value).ok(),
    }
}

/// JavaScript's `Boolean(value)` over a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JavaScript's `string.length`: UTF-16 code units, 0 for a non-string.
fn text_length(value: &Value) -> i64 {
    value
        .as_str()
        .map_or(0, |text| text.encode_utf16().count() as i64)
}

/// A nanoid-shaped id: 21 symbols of `[A-Za-z0-9_-]`, as desktop's
/// `generateId()` mints.
fn mint_id() -> String {
    random_bytes(NANOID_LEN)
        .into_iter()
        .map(|byte| char::from(NANOID_ALPHABET[usize::from(byte & 63)]))
        .collect()
}

fn in_transaction<T>(
    conn: &Connection,
    write: impl FnOnce(&Connection) -> Result<T, StorageError>,
) -> Result<T, StorageError> {
    if !conn.is_autocommit() {
        return write(conn);
    }
    let transaction = conn.unchecked_transaction().map_err(failed)?;
    let value = write(&transaction)?;
    transaction.commit().map_err(failed)?;
    Ok(value)
}

/// Epoch ms before which a row is expired; the projection's `created_at` is
/// epoch ms, so this is the ISO cutoff of §13.12 in the column's unit.
fn retention_cutoff_ms(now_ms: i64) -> i64 {
    now_ms - TASK_ACTIVITY_RETENTION_DAYS * MS_PER_DAY
}

fn prune_in(tx: &Connection, now_ms: i64) -> Result<usize, StorageError> {
    let cutoff = retention_cutoff_ms(now_ms);
    let expired = "SELECT id FROM task_activity WHERE created_at < ?2";
    tx.execute(
        &format!("DELETE FROM outbox WHERE item_type = ?1 AND item_id IN ({expired})"),
        params![ITEM_TYPE, cutoff],
    )
    .map_err(failed)?;
    tx.execute(
        &format!("DELETE FROM sync_items WHERE item_type = ?1 AND item_id IN ({expired})"),
        params![ITEM_TYPE, cutoff],
    )
    .map_err(failed)?;
    tx.execute(
        "DELETE FROM task_activity WHERE created_at < ?1",
        params![cutoff],
    )
    .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minted_id_is_nanoid_shaped() {
        let id = mint_id();
        assert_eq!(id.len(), NANOID_LEN);
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        );
        assert_ne!(id, mint_id());
    }

    #[test]
    fn values_encode_as_json_stringify_does() {
        assert_eq!(encode(&Value::Null), None);
        assert_eq!(encode(&json!("a\"b")).as_deref(), Some(r#""a\"b""#));
        assert_eq!(encode(&json!(3)).as_deref(), Some("3"));
        assert_eq!(encode(&json!(["x"])).as_deref(), Some(r#"["x"]"#));
    }

    #[test]
    fn truthiness_follows_javascript() {
        assert!(!truthy(&Value::Null));
        assert!(!truthy(&json!("")));
        assert!(truthy(&json!("2026-04-16T12:00:00.000Z")));
        assert!(!truthy(&json!(0)));
        assert!(truthy(&json!({})));
    }

    #[test]
    fn description_length_counts_utf16_code_units() {
        assert_eq!(text_length(&json!("a😀")), 3);
        assert_eq!(text_length(&Value::Null), 0);
    }
}
