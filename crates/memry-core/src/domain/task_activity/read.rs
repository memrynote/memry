//! The read side of [`super`]: desktop's `listTaskActivity`
//! (`apps/desktop/src/main/database/queries/task-activity.ts`).
//!
//! Retention (§13.12) is a read filter here, so a row past the 90-day horizon
//! is never shown even before a prune has removed it.

use std::collections::HashMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension as _, params, params_from_iter};
use serde_json::Value;

use crate::api::errors::StorageError;

use super::super::notes::failed;
use super::{ACTOR_USER, encode, retention_cutoff_ms};

/// One entry of a task's feed, as the read surface reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityEntry {
    pub id: String,
    pub task_id: String,
    pub action: String,
    pub field: Option<String>,
    /// JSON-encoded. For `statusId`, `projectId` and `parentId` the id is
    /// replaced by the referenced row's name when that row is still live.
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub actor: String,
    /// Whether the row was written by `this_device_id` (desktop never shows the
    /// raw device id).
    pub is_this_device: bool,
    /// `createdAt` as epoch milliseconds; `None` when the payload carried none.
    pub created_at_ms: Option<i64>,
}

/// One page of a task's feed, newest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityPage {
    pub entries: Vec<ActivityEntry>,
    /// Every matching row inside retention, not just this page.
    pub total: usize,
    pub has_more: bool,
}

/// What [`list`] reads.
#[derive(Debug, Clone, Copy)]
pub struct ActivityQuery<'a> {
    pub task_id: &'a str,
    /// Only these actions; empty means every action.
    pub actions: &'a [String],
    pub limit: usize,
    pub offset: usize,
}

/// `listTaskActivity`: one task's feed inside retention, newest first, `id`
/// descending as the tiebreak (one multi-field edit writes rows with the same
/// `createdAt`).
///
/// `this_device_id` resolves [`ActivityEntry::is_this_device`]; `None` (no
/// registered device yet) matches nothing this core wrote.
pub fn list(
    conn: &Connection,
    query: &ActivityQuery<'_>,
    this_device_id: Option<&str>,
    now_ms: i64,
) -> Result<ActivityPage, StorageError> {
    let (filter, mut values) = filter_sql(query.task_id, query.actions, now_ms);
    let limit_slot = values.len() + 1;
    values.push(SqlValue::Integer(sql_int(query.limit)));
    values.push(SqlValue::Integer(sql_int(query.offset)));
    let mut statement = conn
        .prepare(&format!(
            "SELECT id, task_id, action, field, old_value, new_value, actor, device_id,
                    created_at
               FROM task_activity
              WHERE {filter}
              ORDER BY created_at DESC, id DESC
              LIMIT ?{limit_slot} OFFSET ?{}",
            limit_slot + 1
        ))
        .map_err(failed)?;
    let mapped = statement
        .query_map(params_from_iter(values), |row| {
            let device_id: Option<String> = row.get(7)?;
            Ok(ActivityEntry {
                id: row.get(0)?,
                task_id: row.get(1)?,
                action: row.get(2)?,
                field: row.get(3)?,
                old_value: row.get(4)?,
                new_value: row.get(5)?,
                actor: row
                    .get::<_, Option<String>>(6)?
                    .unwrap_or_else(|| ACTOR_USER.to_owned()),
                is_this_device: device_id.is_some() && device_id.as_deref() == this_device_id,
                created_at_ms: row.get(8)?,
            })
        })
        .map_err(failed)?;
    let mut entries = Vec::new();
    for entry in mapped {
        entries.push(entry.map_err(failed)?);
    }

    let names = referenced_names(conn, &entries)?;
    for entry in &mut entries {
        let field = entry.field.as_deref();
        entry.old_value = display_value(field, entry.old_value.take(), &names);
        entry.new_value = display_value(field, entry.new_value.take(), &names);
    }

    let total = count(conn, query.task_id, query.actions, now_ms)?;
    let has_more = query.offset + entries.len() < total;
    Ok(ActivityPage {
        entries,
        total,
        has_more,
    })
}

/// How many rows inside retention [`list`] would page over.
pub fn count(
    conn: &Connection,
    task_id: &str,
    actions: &[String],
    now_ms: i64,
) -> Result<usize, StorageError> {
    let (filter, values) = filter_sql(task_id, actions, now_ms);
    conn.query_row(
        &format!("SELECT count(*) FROM task_activity WHERE {filter}"),
        params_from_iter(values),
        |row| row.get::<_, i64>(0),
    )
    .map_err(failed)
    .map(|count| usize::try_from(count).unwrap_or(0))
}

/// The shared `WHERE`: the task, live, inside retention (a row with no
/// `createdAt` has no age and is kept), and the action filter when non-empty.
fn filter_sql(task_id: &str, actions: &[String], now_ms: i64) -> (String, Vec<SqlValue>) {
    let mut filter = String::from(
        "task_id = ?1 AND deleted_at IS NULL AND (created_at IS NULL OR created_at >= ?2)",
    );
    let mut values = vec![
        SqlValue::Text(task_id.to_owned()),
        SqlValue::Integer(retention_cutoff_ms(now_ms)),
    ];
    if !actions.is_empty() {
        let slots: Vec<String> = (0..actions.len())
            .map(|index| format!("?{}", index + 3))
            .collect();
        filter.push_str(&format!(" AND action IN ({})", slots.join(", ")));
        values.extend(actions.iter().cloned().map(SqlValue::Text));
    }
    (filter, values)
}

fn sql_int(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// Fields whose stored value is an entity id, and the table holding its name.
fn reference_lookup(field: Option<&str>) -> Option<&'static str> {
    match field? {
        "statusId" => {
            Some("SELECT name FROM project_statuses WHERE id = ?1 AND deleted_at IS NULL")
        }
        "projectId" => Some("SELECT name FROM projects WHERE id = ?1 AND deleted_at IS NULL"),
        "parentId" => Some("SELECT title FROM tasks WHERE id = ?1 AND deleted_at IS NULL"),
        _ => None,
    }
}

/// A JSON-encoded string value's id, or `None` for anything else.
fn decode_id(raw: Option<&str>) -> Option<String> {
    match serde_json::from_str::<Value>(raw?).ok()? {
        Value::String(id) => Some(id),
        _ => None,
    }
}

/// `resolveReferencedNames`: `(field, id) -> name` for every reference value
/// on the page whose row is still live.
fn referenced_names(
    conn: &Connection,
    entries: &[ActivityEntry],
) -> Result<HashMap<(&'static str, String), String>, StorageError> {
    let mut names = HashMap::new();
    for entry in entries {
        let Some(sql) = reference_lookup(entry.field.as_deref()) else {
            continue;
        };
        for raw in [entry.old_value.as_deref(), entry.new_value.as_deref()] {
            let Some(id) = decode_id(raw) else {
                continue;
            };
            let key = (sql, id);
            if names.contains_key(&key) {
                continue;
            }
            let name: Option<String> = conn
                .query_row(sql, params![key.1], |row| row.get(0))
                .optional()
                .map_err(failed)?;
            if let Some(name) = name {
                names.insert(key, name);
            }
        }
    }
    Ok(names)
}

/// `displayValue`: a reference id becomes its JSON-encoded name, falling back
/// to the id when the row is gone (a deleted project still happened).
fn display_value(
    field: Option<&str>,
    raw: Option<String>,
    names: &HashMap<(&'static str, String), String>,
) -> Option<String> {
    let Some(sql) = reference_lookup(field) else {
        return raw;
    };
    let Some(id) = decode_id(raw.as_deref()) else {
        return raw;
    };
    let name = names.get(&(sql, id.clone())).cloned().unwrap_or(id);
    encode(&Value::String(name))
}
