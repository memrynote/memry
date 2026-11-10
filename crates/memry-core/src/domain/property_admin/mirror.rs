//! What the desktop's `.memry/properties.md` last took of each `property_definition` record,
//! so the desktop tells a record a pull changed from one its file is ahead of (#3530 13k-4,
//! #2896).
//!
//! The desktop shows the union of the file and the records, the file winning for every name it
//! lists, and an edit writes the file's definition to the record. Electron keeps that safe by
//! writing every pulled definition into the file as the pull applies it (`applyRemoteUpsert`,
//! `applyRemoteDelete`). Here the file catches up from state instead of from the pull: this
//! device-local `meta` row ([`META_KEY`]) holds, per name, the record's definition as the file
//! last took it (`null` once deleted). A record that differs from it moved since, which only a
//! pull does, because every write of this device records what it wrote. So the desktop writes
//! it into the file before it reads the file or edits it. Nothing depends on a pull calling
//! back, and a crash between the two writes repeats the same file write.
//!
//! A name the row does not hold (the first run of a vault Electron left, a definition only the
//! file holds, a lost or unreadable row) is decided by where its record came from. A record or a
//! delete the server sent wins: Electron wrote every pulled record into its file as it applied it,
//! and a pulled record wins over a row its file alone made (no clock), so a file that differs
//! missed a pull (another device's edit while this one was closed, or before this build). Only a
//! live record this device wrote and never pulled leaves the file winning ([`Pulled::file_wins`]),
//! as Electron's reload lets the file win over its own rows (#4099).
//!
//! [`write`] puts an edit's record only while the record still holds what the edit was decided
//! on: a pull that lands between the file read and the record write is [`Written::Moved`], and
//! the desktop takes it into the file and decides again, instead of sending the file's older
//! definition over it.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::ITEM_TYPE;
use super::records::{DefinitionRecord, put, remove};
use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::storage::repositories::payload::StoredPayload;

/// The `meta` row: a JSON object from a name to the definition the file last took, or `null`
/// for a record the file saw deleted.
pub const META_KEY: &str = "property_definitions.file_versions";

/// A pulled change the file has not taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pulled {
    pub name: String,
    /// The record's definition, or `None` once it is deleted.
    pub record: Option<DefinitionRecord>,
    /// The file never took a version of the name and the record is a live one this device wrote:
    /// what the file lists was written apart from it, and wins.
    pub file_wins: bool,
}

/// Every record as the mirror compares it, and what the file took, read together.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    /// By name: the record's version, its live definition, and whether this device wrote it.
    records: BTreeMap<String, Stored>,
    /// Every name with a `sync_items` row, including one this device cannot read.
    known: BTreeSet<String>,
    taken: Map<String, Value>,
}

#[derive(Debug, Clone)]
struct Stored {
    version: Value,
    record: Option<DefinitionRecord>,
    written_here: bool,
}

impl Snapshot {
    /// The records whose version the file has not taken, by name.
    pub fn pulled(&self) -> Vec<Pulled> {
        self.records
            .iter()
            .filter(|(name, stored)| self.taken.get(*name) != Some(&stored.version))
            .map(|(name, stored)| Pulled {
                name: name.clone(),
                record: stored.record.clone(),
                file_wins: stored.written_here && !self.taken.contains_key(name),
            })
            .collect()
    }

    /// The live record of `name`.
    pub fn record(&self, name: &str) -> Option<&DefinitionRecord> {
        self.records
            .get(name)
            .and_then(|stored| stored.record.as_ref())
    }

    /// Whether the record of `name` is deleted.
    pub fn deleted(&self, name: &str) -> bool {
        self.records
            .get(name)
            .is_some_and(|stored| stored.record.is_none())
    }

    /// Whether `name` has a record in any state: live, deleted, or one this device cannot read
    /// (a row with no payload yet, a corrupt one, or a payload that does not parse).
    pub fn known(&self, name: &str) -> bool {
        self.known.contains(name)
    }

    fn version(&self, name: &str) -> &Value {
        self.records
            .get(name)
            .map_or(&Value::Null, |stored| &stored.version)
    }
}

/// What an edit does to the record of its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    Keep,
    Put(DefinitionRecord),
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    /// The record holds the edit (or already did), and the file's versions are recorded.
    Done,
    /// The record holds the edit, and recording what the file holds failed (the message). The
    /// next settle writes the record into the file again, which then holds the same.
    Unrecorded(String),
    /// The record changed since the snapshot: nothing was written.
    Moved,
}

/// The definition fields of a payload: what the file mirrors. `options` compares as JSON, so
/// its spelling never counts as a change.
fn version_of(fields: &Map<String, Value>) -> Value {
    let options = match fields.get("options") {
        Some(Value::String(text)) => {
            serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.clone()))
        }
        other => other.cloned().unwrap_or(Value::Null),
    };
    let field = |key: &str| fields.get(key).cloned().unwrap_or(Value::Null);
    json!({
        "type": field("type"),
        "options": options,
        "defaultValue": field("defaultValue"),
        "color": field("color"),
    })
}

fn record_of(name: &str, fields: &Map<String, Value>) -> DefinitionRecord {
    let text = |key: &str| match fields.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
    };
    DefinitionRecord {
        name: name.to_owned(),
        type_name: text("type").unwrap_or_default(),
        options: text("options"),
        default_value: text("defaultValue"),
        color: text("color"),
    }
}

fn taken(conn: &Connection) -> Result<Map<String, Value>, StorageError> {
    let text: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [META_KEY], |row| {
            row.get(0)
        })
        .optional()
        .map_err(failed)?;
    Ok(match text.map(|text| serde_json::from_str(&text)) {
        Some(Ok(Value::Object(taken))) => taken,
        // A row this build cannot read starts over: every record the server sent wins, and
        // the file wins over one only this device wrote, until the next write records it.
        Some(_) => {
            eprintln!("memry-core: the `{META_KEY}` row does not read; starting over");
            Map::new()
        }
        None => Map::new(),
    })
}

fn store(conn: &Connection, taken: &Map<String, Value>) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_KEY, Value::Object(taken.clone()).to_string()],
    )
    .map_err(failed)?;
    Ok(())
}

/// Every `property_definition` record, live or deleted, and what the file took. A deleted one
/// counts with no payload (a delete of an item this device never held stores none); a live one
/// with no readable payload is left out of the records, with nothing in it to mirror, and only
/// [`Snapshot::known`].
///
/// A live record was written here when it carries neither a server cursor nor a signer: the pull
/// stores the signer of every record it applies, and a `/sync/pull` item carries no `serverCursor`
/// (chapter 05 §5.11.1). A delete is never one: this device deletes a definition only through
/// [`write`], which records it, so one the file never took came from the server.
pub fn snapshot(conn: &Connection) -> Result<Snapshot, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT item_id, payload, deleted_at, server_cursor, signer_device_id FROM sync_items
              WHERE item_type = ?1",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([ITEM_TYPE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    let mut records = BTreeMap::new();
    let mut known = BTreeSet::new();
    for (name, payload, deleted_at, server_cursor, signer) in rows {
        known.insert(name.clone());
        let written_here = server_cursor.is_none() && signer.is_none();
        let stored = match (payload, deleted_at) {
            (None, None) => continue,
            (Some(payload), None) => {
                let Ok(payload) = StoredPayload::parse(&payload) else {
                    continue;
                };
                let fields = payload.object();
                Stored {
                    version: version_of(fields),
                    record: Some(record_of(&name, fields)),
                    written_here,
                }
            }
            (_, Some(_)) => Stored {
                version: Value::Null,
                record: None,
                written_here: false,
            },
        };
        records.insert(name, stored);
    }
    Ok(Snapshot {
        records,
        known,
        taken: taken(conn)?,
    })
}

/// The file now holds every pulled change of `snapshot`: records their versions.
pub fn take(conn: &Connection, snapshot: &Snapshot) -> Result<(), StorageError> {
    let mut taken = taken(conn)?;
    let before = taken.clone();
    for pulled in snapshot.pulled() {
        taken.insert(pulled.name.clone(), snapshot.version(&pulled.name).clone());
    }
    if taken != before {
        store(conn, &taken)?;
    }
    Ok(())
}

/// The version `name`'s record holds now.
fn current(conn: &Connection, name: &str) -> Result<Value, StorageError> {
    let row: Option<(Option<String>, Option<i64>)> = conn
        .query_row(
            "SELECT payload, deleted_at FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
            params![ITEM_TYPE, name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(failed)?;
    Ok(match row {
        Some((Some(payload), None)) => StoredPayload::parse(&payload)
            .map(|payload| version_of(payload.object()))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    })
}

/// Writes `edit` to the record of `name`, once the file holds the edit and every pulled change
/// of `snapshot`, and records what the file now holds. Nothing is written when the record
/// changed since `snapshot` was read ([`Written::Moved`]).
pub fn write(
    conn: &Connection,
    snapshot: &Snapshot,
    name: &str,
    edit: &Edit,
    device_id: &str,
    now_ms: i64,
) -> Result<Written, StorageError> {
    if *edit != Edit::Keep && current(conn, name)? != *snapshot.version(name) {
        return Ok(Written::Moved);
    }
    match edit {
        Edit::Keep => {}
        Edit::Put(record) => drop(put(conn, record, device_id, now_ms)?),
        Edit::Remove => drop(remove(conn, name, device_id, now_ms)?),
    }
    let recorded = take(conn, snapshot).and_then(|()| {
        if *edit == Edit::Keep {
            return Ok(());
        }
        let mut taken = taken(conn)?;
        taken.insert(name.to_owned(), current(conn, name)?);
        store(conn, &taken)
    });
    Ok(match recorded {
        Ok(()) => Written::Done,
        // The edit landed: reporting it failed would have the user redo it.
        Err(error) => Written::Unrecorded(error.to_string()),
    })
}

#[cfg(test)]
mod tests;
