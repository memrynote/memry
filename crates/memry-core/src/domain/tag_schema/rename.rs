//! A field renamed across the vault (`tags/schema/field-rename.ts`): the job's record and the
//! step no note file holds, the tag definitions. Desktop's `tags::schema::rename` runs the job;
//! the note files and the tasks follow there.
//!
//! The job is one device-local `meta` row (`tags.fieldRenameJob`, `{from, to, runId}`), written
//! before the first write and cleared after the last, so a run the app did not finish is run
//! again at the next open with `resuming`, which finishes what the first run left and changes
//! nothing it did.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::edit::apply;
use super::{SaveError, SchemaEdit, SchemaEditError, StoredSchema, definitions, resolve};
use crate::api::errors::StorageError;
use crate::domain::tag_admin;
use crate::domain::tag_fields::is_reserved;
use crate::storage::repositories::Change;
use crate::sync::first_sync_store::{read_meta, write_meta};

/// The `meta` key of the rename in progress (desktop's `FIELD_RENAME_JOB_SETTING`).
const JOB: &str = "tags.fieldRenameJob";

/// A field rename (`FieldRenameJob`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldRenameJob {
    pub from: String,
    pub to: String,
    /// Names the run's progress events.
    pub run_id: String,
}

/// The rename recorded in `meta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordedRename {
    Job(FieldRenameJob),
    /// Not a job this build reads, with why.
    Unreadable(String),
}

/// The rename recorded, if any (`readJob`): a record with no `runId` is a job named `resume`.
pub fn recorded(conn: &Connection) -> Result<Option<RecordedRename>, StorageError> {
    let Some(raw) = read_meta(conn, JOB)? else {
        return Ok(None);
    };
    let job = serde_json::from_str::<Value>(&raw).ok().and_then(|value| {
        let text = |key: &str| value.get(key)?.as_str().map(str::to_owned);
        Some(FieldRenameJob {
            from: text("from")?,
            to: text("to")?,
            run_id: text("runId").unwrap_or_else(|| "resume".to_owned()),
        })
    });
    Ok(Some(match job {
        Some(job) => RecordedRename::Job(job),
        None => RecordedRename::Unreadable(format!("{} bytes that are not a job", raw.len())),
    }))
}

pub fn record(conn: &Connection, job: &FieldRenameJob) -> Result<(), StorageError> {
    let text = serde_json::to_string(job).map_err(|error| StorageError::Failed {
        what: error.to_string(),
    })?;
    write_meta(conn, JOB, &text)
}

pub fn finish(conn: &Connection) -> Result<(), StorageError> {
    conn.execute("DELETE FROM meta WHERE key = ?1", [JOB])
        .map_err(|error| StorageError::Failed {
            what: error.to_string(),
        })?;
    Ok(())
}

/// What the rename changes in one definition: its `schema` and `views` keys.
type Changes = Vec<(&'static str, Change)>;

/// The definitions the rename changes, by tag key, decided over every live one. A schema this
/// build cannot read is left (its views are still renamed); a schema that refuses the rename
/// refuses it whole (`DuplicateField` unless `resuming`, `ReservedName`), and so does a reserved
/// `to` when no schema lists the field.
fn renamed(
    conn: &Connection,
    from: &str,
    to: &str,
    resuming: bool,
) -> Result<BTreeMap<String, Changes>, SaveError> {
    if is_reserved(to) {
        return Err(SaveError::Edit(SchemaEditError::ReservedName {
            name: to.trim().to_owned(),
        }));
    }
    let defs = definitions(conn)?;
    let resolved = resolve(&defs, &|_| None);
    let edit = SchemaEdit::RenameField {
        from: from.to_owned(),
        to: to.to_owned(),
        resuming,
    };
    let mut out = BTreeMap::new();
    for (key, definition) in &defs {
        let mut changes = Changes::new();
        if let Some(StoredSchema::Readable(schema)) = &definition.schema {
            let stamped = apply(Some(schema), &edit, key, &resolved).map_err(SaveError::Edit)?;
            if stamped.changed {
                changes.push(("schema", Change::Set(Value::Object(stamped.next))));
            }
        }
        let payload = tag_admin::live_definition(conn, &definition.name)?;
        if let Some(views) = payload
            .as_ref()
            .and_then(|p| p.get("views"))
            .and_then(|views| renamed_views(views, from, to))
        {
            changes.push(("views", Change::Set(views)));
        }
        if !changes.is_empty() {
            out.insert(key.clone(), changes);
        }
    }
    Ok(out)
}

/// `renameInViews`: a saved view's column ids, sort properties and grouping property naming
/// `from` exactly take `to`; every other key stays. `None` when none names it.
fn renamed_views(views: &Value, from: &str, to: &str) -> Option<Value> {
    let mut next = views.as_array()?.clone();
    let mut changed = false;
    let mut swap = |value: Option<&mut Value>| {
        if let Some(name) = value.filter(|name| name.as_str() == Some(from)) {
            *name = Value::String(to.to_owned());
            changed = true;
        }
    };
    for view in next.iter_mut().filter_map(Value::as_object_mut) {
        for column in list(view.get_mut("columns")) {
            swap(column.get_mut("id"));
        }
        for order in list(view.get_mut("order")) {
            swap(order.get_mut("property"));
        }
        if let Some(group) = view.get_mut("groupBy").and_then(Value::as_object_mut) {
            swap(group.get_mut("property"));
        }
    }
    changed.then_some(Value::Array(next))
}

fn list(value: Option<&mut Value>) -> impl Iterator<Item = &mut serde_json::Map<String, Value>> {
    value
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object_mut)
}

/// Refuses a rename any schema refuses, writing nothing (`planSchemaEdit` over every schema).
pub fn plan(conn: &Connection, from: &str, to: &str) -> Result<(), SaveError> {
    renamed(conn, from, to, false).map(drop)
}

/// Renames the field in every tag schema and saved tag view, each definition in one write
/// through the definition writer (one outbox row each). Returns the tag keys it changed.
pub fn rename_in_definitions(
    conn: &Connection,
    from: &str,
    to: &str,
    resuming: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, SaveError> {
    let changed = renamed(conn, from, to, resuming)?;
    for (key, changes) in &changed {
        tag_admin::upsert_definition(conn, key, None, changes.clone(), device_id, now_ms)?;
    }
    Ok(changed.into_keys().collect())
}

#[cfg(test)]
#[path = "rename_tests.rs"]
mod tests;
