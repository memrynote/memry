//! Whole `property_definition` records, for the desktop shell (#3530 Step 13k). Desktop keeps
//! each record equal to the definition `.memry/properties.md` holds, as Electron's
//! `PropertyDefinitionsService` rebuilds its `property_definitions` rows from the file and
//! queues the name it changed. [`put`] writes only the fields that differ, so a definition
//! that did not change queues nothing.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{Value, json};

use super::{DEFINITION_TYPES, ITEM_TYPE, refuse};
use crate::api::errors::{AuthError, StorageError};
use crate::api::tasks::Tasks;
use crate::domain::notes::{edit, failed, iso, object, require_payload, tombstone_local};
use crate::domain::recreate::write_over_tombstone;
use crate::seams::secure_store::SecureStore;
use crate::storage::Db;
use crate::storage::repositories::{Change, instants, sync_items};
use crate::sync::outbox;

/// One definition as its record carries it. `options` is the opaque JSON text of §13.7.9.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefinitionRecord {
    pub name: String,
    pub type_name: String,
    pub options: Option<String>,
    pub default_value: Option<String>,
    pub color: Option<String>,
}

/// A live record and when it was first created (ISO 8601), when its payload says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredDefinition {
    pub record: DefinitionRecord,
    pub created_at: Option<String>,
}

/// Every live definition, by name in byte order (Electron's `ORDER BY name`).
pub fn list(conn: &Connection) -> Result<Vec<StoredDefinition>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT name, type, options, default_value, color, created_at
               FROM property_definitions WHERE deleted_at IS NULL ORDER BY name",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok(StoredDefinition {
                record: DefinitionRecord {
                    name: row.get(0)?,
                    type_name: row.get(1)?,
                    options: row.get(2)?,
                    default_value: row.get(3)?,
                    color: row.get(4)?,
                },
                created_at: row.get::<_, Option<i64>>(5)?.and_then(instants::to_iso8601),
            })
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

fn text_or_null(text: Option<&str>) -> Value {
    text.map_or(Value::Null, |text| Value::String(text.to_owned()))
}

/// Two `options` texts hold the same JSON, whatever their key order and spacing.
fn same_options(stored: Option<&Value>, next: Option<&str>) -> bool {
    let stored = stored.and_then(Value::as_str);
    match (stored, next) {
        (Some(a), Some(b)) => match (
            serde_json::from_str::<Value>(a),
            serde_json::from_str::<Value>(b),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => a == b,
        },
        (a, b) => a == b,
    }
}

/// Creates the record of `record.name`, over its tombstone when it has one.
pub(super) fn insert(
    conn: &Connection,
    record: &DefinitionRecord,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let payload = object(json!({
        "name": record.name,
        "type": record.type_name,
        "options": text_or_null(record.options.as_deref()),
        "defaultValue": text_or_null(record.default_value.as_deref()),
        "color": text_or_null(record.color.as_deref()),
        "createdAt": iso(now_ms)?,
    }));
    outbox::commit(
        conn,
        &outbox::Change::upsert(ITEM_TYPE, &record.name),
        now_ms,
        |tx| write_over_tombstone(tx, ITEM_TYPE, &record.name, payload, device_id, now_ms),
    )?
    .acknowledge();
    Ok(())
}

/// Makes the record of `record.name` hold `record`: created when there is no live one, else
/// edited in the fields that differ. Returns whether anything was written.
pub fn put(
    conn: &Connection,
    record: &DefinitionRecord,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    if record.name.trim().is_empty() {
        return Err(refuse("a property needs a name".into()));
    }
    if !DEFINITION_TYPES.contains(&record.type_name.as_str()) {
        return Err(refuse(format!(
            "unknown property type `{}`",
            record.type_name
        )));
    }
    let live = sync_items::load(conn, ITEM_TYPE, &record.name)?
        .is_some_and(|row| row.deleted_at.is_none());
    if !live {
        insert(conn, record, device_id, now_ms)?;
        return Ok(true);
    }
    let stored = require_payload(conn, ITEM_TYPE, &record.name)?;
    let fields = stored.object();
    let mut changes = Vec::new();
    let mut differs = |key: &'static str, next: Option<&str>| {
        if fields.get(key).and_then(Value::as_str) != next {
            changes.push((key, Change::Set(text_or_null(next))));
        }
    };
    differs("type", Some(&record.type_name));
    differs("defaultValue", record.default_value.as_deref());
    differs("color", record.color.as_deref());
    if !same_options(fields.get("options"), record.options.as_deref()) {
        changes.push((
            "options",
            Change::Set(text_or_null(record.options.as_deref())),
        ));
    }
    if changes.is_empty() {
        return Ok(false);
    }
    edit(conn, ITEM_TYPE, &record.name, changes, device_id, now_ms)?.acknowledge();
    Ok(true)
}

/// Tombstones the live record of `name`. Returns whether there was one.
pub fn remove(
    conn: &Connection,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<bool, StorageError> {
    let live = sync_items::load(conn, ITEM_TYPE, name)?.is_some_and(|row| row.deleted_at.is_none());
    if !live {
        return Ok(false);
    }
    outbox::commit(
        conn,
        &outbox::Change::delete(ITEM_TYPE, name),
        now_ms,
        |tx| tombstone_local(tx, ITEM_TYPE, name, device_id, now_ms),
    )?
    .acknowledge();
    Ok(true)
}

/// The records of one vault, written under this device's identity.
pub struct DefinitionRecords {
    db: Db,
    device_id: String,
}

impl DefinitionRecords {
    pub(crate) fn over(db: Db, store: &Arc<dyn SecureStore>) -> Result<Self, AuthError> {
        let tasks = Tasks::over(db, store)?;
        Ok(Self {
            db: tasks.db,
            device_id: tasks.device_id,
        })
    }

    pub fn list(&self) -> Result<Vec<StoredDefinition>, StorageError> {
        self.db.read_blocking(list)
    }

    pub fn put(&self, record: &DefinitionRecord, now_ms: i64) -> Result<bool, StorageError> {
        self.db
            .call_blocking(|conn| put(conn, record, &self.device_id, now_ms))
    }

    pub fn remove(&self, name: &str, now_ms: i64) -> Result<bool, StorageError> {
        self.db
            .call_blocking(|conn| remove(conn, name, &self.device_id, now_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{open_data, test_support::temp_dir};

    const NOW: i64 = 1_760_000_000_000;

    fn record(type_name: &str, options: Option<&str>, color: Option<&str>) -> DefinitionRecord {
        DefinitionRecord {
            name: "Stage".into(),
            type_name: type_name.into(),
            options: options.map(str::to_owned),
            default_value: None,
            color: color.map(str::to_owned),
        }
    }

    fn queued(conn: &Connection) -> Vec<String> {
        let mut statement = conn
            .prepare("SELECT op FROM outbox ORDER BY id")
            .expect("prepare");
        statement
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<Result<_, _>>()
            .expect("rows")
    }

    #[test]
    fn a_put_writes_only_what_changed_and_a_remove_tombstones() {
        let dir = temp_dir("props-records");
        let db = open_data(&dir.path().join("data.db")).expect("open");
        db.call_blocking(|c| {
            let first = record("select", Some(r#"[{"value":"Idea","color":"sky"}]"#), None);
            assert!(put(c, &first, "p", NOW)?);
            assert_eq!(queued(c), ["upsert"]);
            let payload = |c: &Connection| {
                sync_items::load(c, ITEM_TYPE, "Stage").map(|row| row.unwrap().payload)
            };
            let before = payload(c)?;
            // The same JSON in another key order and spacing is no change.
            let same = record(
                "select",
                Some(r#"[ {"color":"sky", "value":"Idea"} ]"#),
                None,
            );
            assert!(!put(c, &same, "p", NOW + 1)?);
            assert_eq!(payload(c)?, before);
            let colored = record("select", same.options.as_deref(), Some("rose"));
            assert!(put(c, &colored, "p", NOW + 2)?);
            // Only the color changed: the options text stays as the first put wrote it.
            let listed = list(c)?;
            assert_eq!(
                listed[0].record,
                record("select", first.options.as_deref(), Some("rose"))
            );
            assert_eq!(
                listed[0].created_at.as_deref(),
                Some("2025-10-09T08:53:20.000Z")
            );

            assert!(remove(c, "Stage", "p", NOW + 3)?);
            assert!(list(c)?.is_empty());
            assert_eq!(queued(c).last().map(String::as_str), Some("delete"));
            assert!(!remove(c, "Stage", "p", NOW + 4)?);
            // Put again over the tombstone.
            assert!(put(c, &record("date", None, None), "p", NOW + 5)?);
            assert_eq!(list(c)?[0].record.type_name, "date");
            assert!(put(c, &record("rating", None, None), "p", NOW + 6).is_err());
            Ok(())
        })
        .expect("records");
    }
}
