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

mod store;

pub use store::read_values;
use store::{failed, require, stored, write};

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
    // `shift_remove`, not `remove`: the map keeps desktop's key order, which
    // is the property order (§13.7.1), and `remove` swaps the last key in.
    if values.shift_remove(name).is_none() {
        return Ok(values);
    }
    write(
        conn, item_type, item_id, &payload, values, device_id, now_ms,
    )
}

/// Renames one property on one item, keeping its value, as desktop's
/// `properties:rename` does (`ipc/properties-handlers.ts`): the old key is
/// dropped rather than left `null`, a missing `from` is
/// [`StorageError::NotFound`], an existing `to` is [`StorageError::Invalid`],
/// and `from == to` writes nothing. Only this item changes; the vault-wide
/// definition is not renamed.
pub fn rename(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    from: &str,
    to: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, StorageError> {
    let to = to.trim();
    if to.is_empty() {
        return Err(StorageError::Invalid {
            what: "a property needs a name".to_owned(),
        });
    }
    let payload = require(conn, item_type, item_id)?;
    let values = read_values(payload.object(), item_type, item_id)?;
    if !values.contains_key(from) {
        return Err(StorageError::NotFound {
            what: format!("{item_type}/{item_id} has no property `{from}`"),
        });
    }
    if from == to {
        return Ok(values);
    }
    if values.contains_key(to) {
        return Err(StorageError::Invalid {
            what: format!("{item_type}/{item_id} already has a property `{to}`"),
        });
    }
    let values = renamed_in_place(values, from, to);
    write(
        conn, item_type, item_id, &payload, values, device_id, now_ms,
    )
}

/// `values` with `from` renamed to `to` at the same position, as desktop's
/// rename rebuilds the record in order.
pub fn renamed_in_place(values: Map<String, Value>, from: &str, to: &str) -> Map<String, Value> {
    values
        .into_iter()
        .map(|(name, value)| {
            if name == from {
                (to.to_owned(), value)
            } else {
                (name, value)
            }
        })
        .collect()
}

/// Reorders one item's properties, desktop's `reorderProperties`
/// (`use-properties.ts`): the named properties first, in the order given, then
/// every property not named, in its current order. A name the item does not
/// carry is skipped. An unchanged order writes nothing.
///
/// The order travels as the key order of the `properties` object, which is
/// how desktop stores it (frontmatter and index rows follow the payload's key
/// order). `note` merges document-level, so the reordered object wins or loses
/// as a whole like any other property edit.
pub fn reorder(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    ordered: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, StorageError> {
    let payload = require(conn, item_type, item_id)?;
    let values = read_values(payload.object(), item_type, item_id)?;
    let next = reordered(&values, ordered);
    if next.keys().eq(values.keys()) {
        return Ok(values);
    }
    write(conn, item_type, item_id, &payload, next, device_id, now_ms)
}

fn reordered(values: &Map<String, Value>, ordered: &[String]) -> Map<String, Value> {
    let mut next = Map::new();
    for name in ordered {
        if let Some(value) = values.get(name) {
            next.entry(name.clone()).or_insert_with(|| value.clone());
        }
    }
    for (name, value) in values {
        if !next.contains_key(name) {
            next.insert(name.clone(), value.clone());
        }
    }
    next
}

/// The rule FR-048 names. See the module comment for what is exempt and why.
pub fn refuse_retype(
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

#[cfg(test)]
mod tests;
