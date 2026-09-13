//! Note and journal property **values** (T127, FR-048).
//!
//! Chapter 13 §13.7.1 is explicit about the split: `note.properties` is
//! "free-form: **values only, never definitions**", and the definitions live in
//! their own record type, `property_definition` (§13.7.9). Both halves of
//! FR-048's "property definitions and value types MUST behave identically to
//! desktop" follow from keeping that split, so this module does two things and
//! refuses a third:
//!
//! 1. it reads the definitions, for a surface that has to render an editor;
//! 2. it edits the values on one note;
//! 3. **it never writes a `property_definition`.** Editing a value is not a
//!    schema change, and a value edit that quietly retyped the property would
//!    retype it for every note in the vault.
//!
//! ## "Never retyped by an edit"
//!
//! A value keeps the JSON type it already has. Setting `area` — a string — to
//! the number `3` is [`PropertyError::Retyped`], not a silent coercion, because
//! a coercion is invisible at the call site and permanent on the wire: the
//! merged payload is what every other device then reads.
//!
//! Two values are exempt, and both are exempt for the same reason — neither
//! claims a type:
//!
//! - an **explicit `null`**, which is §13.4's clear; and
//! - a property the note does not carry yet, or carries as `null`, where the
//!   first write is what establishes the type rather than changing one.
//!
//! The check is against the value **on this note**, not against
//! `property_definition.type`. §13.7.9 marks that field required but never
//! enumerates its values — the committed vectors show `select` and `text` and
//! nothing pins the rest — so mapping a declared type name to a JSON type would
//! mean inventing a table this specification does not contain, and getting it
//! wrong would refuse a legitimate edit on real data. The type already in the
//! payload is evidence; a guess is not.
//!
//! ## The merge shape
//!
//! `note` and `journal` merge **document-level** (chapter 06 §6.8), so the
//! whole `properties` object travels as one value and there is no per-key
//! clock. The absent-versus-`null` distinction inside `properties` is therefore
//! about what a surface displays, not about how a peer merges.

use rusqlite::Connection;
use serde_json::{Map, Value};
use thiserror::Error;

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::clock::{self, VectorClock};
use crate::sync::outbox;

/// The record types carrying a free-form `properties` object (§13.7.1,
/// §13.7.2). `template.properties` is an **array** of definitions, not a value
/// map (§13.7.6), and is not one of these.
pub const PROPERTIED_TYPES: [&str; 2] = ["note", "journal"];

/// Why a property edit was refused.
///
/// [`Retyped`](PropertyError::Retyped) is typed rather than folded into
/// [`StorageError::Failed`] because it is the behaviour FR-048 names: a caller
/// has to be able to tell "this is not a valid value for that property" from
/// "the disk is full", and a surface has to be able to say so.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PropertyError {
    #[error(
        "property `{name}` holds {existing} and the edit would make it {proposed}; a value edit never retypes a property (FR-048)"
    )]
    Retyped {
        name: String,
        existing: &'static str,
        proposed: &'static str,
    },

    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// One `property_definition`, as the projection holds it (data-model §A.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertyDefinition {
    pub name: String,
    /// `property_definition.type`. Carried as the string the payload spells,
    /// never mapped to a JSON type — see the module comment.
    pub type_name: String,
    /// Opaque JSON **text**, exactly as the payload carries it (§13.7.9).
    pub options: Option<String>,
    pub default_value: Option<String>,
    pub color: Option<String>,
}

/// Every live property definition, by name.
///
/// A row that will not read is a hard error, never a skipped row: a
/// `filter_map` here would make a definitions list silently short, and the
/// surface would offer the user a property the vault does not have.
pub fn definitions(conn: &Connection) -> Result<Vec<PropertyDefinition>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT name, type, options, default_value, color FROM property_definitions
             WHERE deleted_at IS NULL ORDER BY name",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok(PropertyDefinition {
                name: row.get(0)?,
                type_name: row.get(1)?,
                options: row.get(2)?,
                default_value: row.get(3)?,
                color: row.get(4)?,
            })
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}

/// One definition by name, or `None` when the vault has none.
pub fn definition(
    conn: &Connection,
    name: &str,
) -> Result<Option<PropertyDefinition>, StorageError> {
    Ok(definitions(conn)?.into_iter().find(|it| it.name == name))
}

/// The property values on one item.
///
/// An item with no row has no properties. An item whose payload will not parse,
/// or whose `properties` is neither an object nor `null`, is a **hard error**
/// and never an empty map — a silent empty would make the next [`set`] push a
/// payload that deleted every other property on the note.
pub fn values(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Map<String, Value>, StorageError> {
    let Some(payload) = stored(conn, item_type, item_id)? else {
        return Ok(Map::new());
    };
    read_values(payload.object(), item_type, item_id)
}

/// Writes one property value, keeping its JSON type.
///
/// `Value::Null` is the explicit clear of §13.4 and is always allowed; see
/// [`clear`]. Writing the value the property already holds changes nothing and
/// pushes nothing.
pub fn set(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    name: &str,
    value: Value,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, PropertyError> {
    let payload = require(conn, item_type, item_id)?;
    let mut values = read_values(payload.object(), item_type, item_id)?;
    refuse_retype(name, values.get(name), &value)?;
    if values.get(name) == Some(&value) {
        return Ok(values);
    }
    values.insert(name.to_owned(), value);
    Ok(write(
        conn, item_type, item_id, &payload, values, device_id, now_ms,
    )?)
}

/// Clears one property, leaving the key present and `null` (§13.4).
pub fn clear(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, PropertyError> {
    set(
        conn,
        item_type,
        item_id,
        name,
        Value::Null,
        device_id,
        now_ms,
    )
}

/// Drops one property from the item entirely.
pub fn remove(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    name: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, StorageError> {
    let payload = require(conn, item_type, item_id)?;
    let mut values = read_values(payload.object(), item_type, item_id)?;
    if values.remove(name).is_none() {
        return Ok(values);
    }
    write(
        conn, item_type, item_id, &payload, values, device_id, now_ms,
    )
}

/// The rule FR-048 names. See the module comment for what is exempt and why.
fn refuse_retype(
    name: &str,
    existing: Option<&Value>,
    proposed: &Value,
) -> Result<(), PropertyError> {
    if proposed.is_null() {
        return Ok(());
    }
    let Some(existing) = existing.filter(|value| !value.is_null()) else {
        return Ok(());
    };
    if std::mem::discriminant(existing) == std::mem::discriminant(proposed) {
        return Ok(());
    }
    Err(PropertyError::Retyped {
        name: name.to_owned(),
        existing: kind_of(existing),
        proposed: kind_of(proposed),
    })
}

/// What a JSON value is, for the refusal message. An integer and a fraction are
/// both a number: a value edit that changed `3` to `3.5` is not a retype.
fn kind_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Array(_) => "a list",
        Value::Object(_) => "an object",
    }
}

/// Merges the new value map into the payload and publishes the item, in one
/// transaction (FR-030, data-model §A.2).
fn write(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    payload: &StoredPayload,
    values: Map<String, Value>,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, StorageError> {
    let ticked = clock::increment(
        &document_clock(payload.object(), item_type, item_id)?,
        device_id,
    );
    let modified_at = instants::to_iso8601(now_ms).ok_or_else(|| StorageError::Failed {
        what: format!("{now_ms} is not a representable instant"),
    })?;
    let changes = [
        ("properties", Change::Set(Value::Object(values.clone()))),
        ("clock", Change::set(clock_value(&ticked))),
        ("modifiedAt", Change::set(modified_at)),
    ];

    let tx = conn.unchecked_transaction().map_err(failed)?;
    sync_items::apply_local_edit_in(&tx, item_type, item_id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(item_type, item_id), now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(values)
}

/// The stored payload of a propertied item, or `None` when there is no row.
fn stored(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<StoredPayload>, StorageError> {
    if !PROPERTIED_TYPES.contains(&item_type) {
        return Err(StorageError::Failed {
            what: format!("`{item_type}` carries no free-form property values"),
        });
    }
    let Some(row) = sync_items::load(conn, item_type, item_id)? else {
        return Ok(None);
    };
    let Some(stored) = row.payload else {
        return Ok(None);
    };
    StoredPayload::parse(&stored)
        .map(Some)
        .map_err(|error| StorageError::Failed {
            what: format!("{item_type}/{item_id} payload will not parse: {error}"),
        })
}

fn require(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<StoredPayload, StorageError> {
    stored(conn, item_type, item_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("no {item_type}/{item_id} payload to write a property to"),
    })
}

/// The payload's `properties` object. Absent and `null` are both "no values";
/// anything else is an error rather than a substituted empty map.
fn read_values(
    object: &Object,
    item_type: &str,
    item_id: &str,
) -> Result<Map<String, Value>, StorageError> {
    match object.get("properties") {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(values)) => Ok(values.clone()),
        Some(_) => Err(StorageError::Failed {
            what: format!("{item_type}/{item_id}: `properties` is not an object"),
        }),
    }
}

/// The item's document clock. A clock that will not read as ticks is a hard
/// error rather than an empty clock: an empty one lowers `clockTotal` and
/// changes who wins the next merge (chapter 06 §6.10).
fn document_clock(
    object: &Object,
    item_type: &str,
    item_id: &str,
) -> Result<VectorClock, StorageError> {
    let Some(value) = object.get("clock") else {
        return Ok(VectorClock::new());
    };
    let refuse = || StorageError::Failed {
        what: format!("{item_type}/{item_id}: `clock` is not a vector clock"),
    };
    value
        .as_object()
        .ok_or_else(refuse)?
        .iter()
        .map(|(device, tick)| Ok((device.clone(), tick.as_u64().ok_or_else(refuse)?)))
        .collect()
}

fn clock_value(clock: &VectorClock) -> Value {
    Value::Object(
        clock
            .iter()
            .map(|(device, tick)| (device.clone(), Value::from(*tick)))
            .collect(),
    )
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::repositories::InboundRecord;
    use crate::storage::{Db, open_data, test_support::temp_dir};
    use serde_json::json;

    const NOW: i64 = 1_760_000_000_000;
    const DEVICE: &str = "device-b";

    const NOTE: &str = concat!(
        r#"{"title":"A note","properties":{"area":"Work","effort":3},"#,
        r#""clock":{"device-a":2},"coverImage":{"url":"memry://cover/1"}}"#
    );

    fn seed(db: &Db, item_type: &str, item_id: &str, payload_json: &str) {
        db.call_blocking(|conn| {
            let record = InboundRecord {
                item_type: item_type.to_owned(),
                item_id: item_id.to_owned(),
                payload_json: payload_json.to_owned(),
                server_cursor: Some(7),
                signer_device_id: Some("device-a".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            };
            sync_items::apply_remote(conn, &record, NOW)?;
            Ok(())
        })
        .expect("seed");
    }

    fn open(label: &str, payload_json: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        seed(&db, "note", "note-1", payload_json);
        (db, dir)
    }

    fn pushed(conn: &Connection) -> Value {
        let raw = sync_items::push_payload(conn, "note", "note-1")
            .expect("push payload")
            .expect("a payload");
        serde_json::from_str(&raw).expect("valid JSON")
    }

    #[test]
    fn a_value_edit_keeps_the_type_and_the_unmodelled_key() {
        let (db, _dir) = open("props-set", NOTE);
        db.call_blocking(|conn| {
            let values = set(
                conn,
                "note",
                "note-1",
                "area",
                json!("Home"),
                DEVICE,
                NOW + 1,
            )
            .expect("set");
            assert_eq!(values["area"], json!("Home"));
            assert_eq!(values["effort"], json!(3));

            let payload = pushed(conn);
            assert_eq!(payload["properties"], json!({"area":"Home","effort":3}));
            assert_eq!(payload["coverImage"], json!({"url": "memry://cover/1"}));
            assert_eq!(payload["clock"], json!({"device-a": 2, "device-b": 1}));

            let projected: String = conn
                .query_row(
                    "SELECT properties FROM notes WHERE id = 'note-1'",
                    [],
                    |r| r.get(0),
                )
                .expect("projection");
            assert_eq!(projected, r#"{"area":"Home","effort":3}"#);
            Ok(())
        })
        .expect("set");
    }

    #[test]
    fn an_edit_that_would_retype_a_value_is_refused_and_writes_nothing() {
        let (db, _dir) = open("props-retype", NOTE);
        db.call_blocking(|conn| {
            let refused = set(
                conn,
                "note",
                "note-1",
                "effort",
                json!("3"),
                DEVICE,
                NOW + 1,
            );
            assert_eq!(
                refused,
                Err(PropertyError::Retyped {
                    name: "effort".to_owned(),
                    existing: "a number",
                    proposed: "text",
                })
            );

            // Nothing merged, nothing queued.
            let raw = sync_items::push_payload(conn, "note", "note-1")?.expect("a payload");
            assert_eq!(raw, NOTE);
            let queued: i64 = conn
                .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .expect("outbox");
            assert_eq!(queued, 0);
            Ok(())
        })
        .expect("retype");
    }

    #[test]
    fn a_fraction_is_not_a_retype_of_an_integer() {
        let (db, _dir) = open("props-fraction", NOTE);
        db.call_blocking(|conn| {
            let values = set(
                conn,
                "note",
                "note-1",
                "effort",
                json!(3.5),
                DEVICE,
                NOW + 1,
            )
            .expect("set");
            assert_eq!(values["effort"], json!(3.5));
            Ok(())
        })
        .expect("fraction");
    }

    #[test]
    fn a_clear_is_always_allowed_and_the_next_write_sets_the_type_afresh() {
        let (db, _dir) = open("props-clear", NOTE);
        db.call_blocking(|conn| {
            let values = clear(conn, "note", "note-1", "effort", DEVICE, NOW + 1).expect("clear");
            assert_eq!(values["effort"], Value::Null);
            assert!(
                values.contains_key("effort"),
                "§13.4: a clear leaves the key present and null"
            );

            // A cleared property claims no type, so any value may follow it.
            let values = set(
                conn,
                "note",
                "note-1",
                "effort",
                json!("large"),
                DEVICE,
                NOW + 2,
            )
            .expect("set after clear");
            assert_eq!(values["effort"], json!("large"));
            Ok(())
        })
        .expect("clear");
    }

    #[test]
    fn removing_a_property_drops_the_key_rather_than_nulling_it() {
        let (db, _dir) = open("props-remove", NOTE);
        db.call_blocking(|conn| {
            let values = remove(conn, "note", "note-1", "effort", DEVICE, NOW + 1)?;
            assert!(!values.contains_key("effort"));
            assert_eq!(pushed(conn)["properties"], json!({"area":"Work"}));

            // Removing what is not there writes nothing.
            remove(conn, "note", "note-1", "effort", DEVICE, NOW + 2)?;
            let queued: i64 = conn
                .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .expect("outbox");
            assert_eq!(queued, 1);
            Ok(())
        })
        .expect("remove");
    }

    #[test]
    fn a_value_edit_never_writes_a_property_definition() {
        let (db, _dir) = open("props-definition", NOTE);
        seed(
            &db,
            "property_definition",
            "effort",
            r#"{"name":"effort","type":"number","clock":{"device-a":1}}"#,
        );
        db.call_blocking(|conn| {
            let before = definition(conn, "effort")?.expect("the definition");
            set(conn, "note", "note-1", "effort", json!(8), DEVICE, NOW + 1).expect("set");
            assert_eq!(definition(conn, "effort")?.as_ref(), Some(&before));

            let queued: Vec<String> = {
                let mut statement = conn.prepare("SELECT item_type FROM outbox").expect("prep");
                let mapped = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .expect("query");
                mapped.map(|row| row.expect("row")).collect()
            };
            assert_eq!(queued, vec!["note".to_owned()]);
            Ok(())
        })
        .expect("definition");
    }

    #[test]
    fn a_properties_value_that_will_not_read_is_an_error_and_never_an_empty_map() {
        let (db, _dir) = open("props-unreadable", r#"{"title":"t","properties":["area"]}"#);
        db.call_blocking(|conn| {
            assert!(values(conn, "note", "note-1").is_err());
            assert!(values(conn, "template", "tpl-1").is_err());
            Ok(())
        })
        .expect("unreadable");
    }
}
