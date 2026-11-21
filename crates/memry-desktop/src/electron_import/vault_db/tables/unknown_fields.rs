//! `sync_unknown_fields`: the payload keys an Electron build stripped on apply, which its push
//! puts back under the freshly built payload (`unknown-fields.ts:150-179`, called by
//! `push-coordinator.ts:901` for every type). The record path ([`merge_into`]) merges them
//! into each record's payload before it is stored, so the projection reads the merged payload.
//! [`import`] runs after every record table (it is the last `TABLE_MAP` entry): it counts each
//! row as merged or dropped and fails when a record importer skipped the merge.

use memry_core::storage::import::ImportRecord;
use rusqlite::{Connection, OptionalExtension, Row};
use serde_json::{Map, Value};

use super::js_json::{self, JsonError};
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

const TABLE: &str = "sync_unknown_fields";

/// The own properties of `Object.prototype` in V8. `key in object` is true for each of them,
/// so `mergeNestedUnknownField` never writes one, and a path through one never reaches a plain
/// object the payload holds.
const OBJECT_PROTOTYPE_KEYS: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

#[derive(Debug, PartialEq, Eq)]
pub enum Merge {
    Merged(String),
    /// Electron's merge gives up (`try`/`catch`, or a remainder that is no object) and pushes
    /// the payload without the stored keys.
    Ignored,
}

/// `mergeUnknownPayloadFields(db, type, itemId, payload)` with the row's two columns.
pub fn merge(payload: &str, fields: &str, nested: Option<&str>) -> Result<Merge, JsonError> {
    let parsed = |text: &str| match js_json::parse(text) {
        Err(JsonError::NotJson) => Ok(None),
        other => other.map(Some),
    };
    let Some(extra) = parsed(fields)? else {
        return Ok(Merge::Ignored);
    };
    let nested = match nested {
        Some(text) => match parsed(text)? {
            Some(nested) => nested,
            None => return Ok(Merge::Ignored),
        },
        None => Value::Array(Vec::new()),
    };
    let (Value::Object(extra), Value::Object(body)) = (extra, js_json::parse(payload)?) else {
        return Ok(Merge::Ignored);
    };
    // `{ ...extra, ...body }`: a body key already in `extra` keeps its position.
    let mut merged = extra;
    merged.extend(body);
    if let Value::Array(fields) = nested {
        for field in &fields {
            if let Some((path, value)) = nested_field(field) {
                merge_nested(&mut merged, &path, value);
            }
        }
    }
    Ok(Merge::Merged(js_json::stringify(&Value::Object(merged))))
}

/// `isNestedUnknownField`: `{ path: string[] (non-empty), value }`.
fn nested_field(field: &Value) -> Option<(Vec<&str>, &Value)> {
    let Value::Object(field) = field else {
        return None;
    };
    let Some(Value::Array(path)) = field.get("path") else {
        return None;
    };
    let path: Vec<&str> = path.iter().map(Value::as_str).collect::<Option<_>>()?;
    (!path.is_empty()).then_some((path, field.get("value")?))
}

/// `mergeNestedUnknownField`: every parent on the path is a plain object the payload holds,
/// and the leaf is absent (a locally built value, `null` included, wins).
fn merge_nested(body: &mut Map<String, Value>, path: &[&str], value: &Value) {
    let Some((leaf, parents)) = path.split_last() else {
        return;
    };
    let mut parent = body;
    for key in parents {
        match parent.get_mut(*key) {
            Some(Value::Object(child)) => parent = child,
            _ => return,
        }
    }
    if !parent.contains_key(*leaf) && !OBJECT_PROTOTYPE_KEYS.contains(leaf) {
        parent.insert((*leaf).to_owned(), value.clone());
    }
}

fn unsupported(rowid: i64) -> ImportError {
    ImportError::MalformedRow {
        table: TABLE,
        rowid,
        what: "kept payload keys this import cannot re-serialise",
    }
}

fn remainder(row: &Row<'_>) -> rusqlite::Result<(i64, String, Option<String>)> {
    Ok((
        row.get("rowid")?,
        row.get("fields")?,
        row.get("nested_fields")?,
    ))
}

/// Merges the stored remainder of `record`, as Electron's push does.
pub fn merge_into(source: &Connection, record: &mut ImportRecord) -> Result<(), ImportError> {
    let row = source
        .prepare_cached(
            "SELECT rowid, fields, nested_fields FROM sync_unknown_fields \
             WHERE type = ?1 AND item_id = ?2",
        )
        .and_then(|mut stmt| {
            stmt.query_row([record.item_type, record.item_id.as_str()], remainder)
                .optional()
        })
        .map_err(|e| source_error(SourceDb::Data, e))?;
    if let Some((rowid, fields, nested)) = row {
        match merge(&record.payload, &fields, nested.as_deref()) {
            Ok(Merge::Merged(payload)) => record.payload = payload,
            Ok(Merge::Ignored) => {}
            Err(_) => return Err(unsupported(rowid)),
        }
    }
    Ok(())
}

/// Counts every row: merged into its record, or dropped because no record carries it
/// (`buildPushPayload` returns null, so Electron never pushes it) or because Electron's merge
/// ignores it. A record whose stored payload still changes under the merge was written by an
/// importer that skipped [`merge_into`], and the import fails.
pub fn import(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let mut stmt = ctx
        .source
        .prepare("SELECT rowid, type, item_id, fields, nested_fields FROM sync_unknown_fields")
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let (mut stats, mut without_record, mut ignored, mut not_merged) =
        (TableStats::default(), 0, 0, 0);
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let item_type = read_source_id(row, SourceDb::Data, TABLE, "type")?;
        let item_id = read_source_id(row, SourceDb::Data, TABLE, "item_id")?;
        let (rowid, fields, nested) =
            remainder(row).map_err(|e| source_error(SourceDb::Data, e))?;
        let Some(payload) = ctx.writer.record_payload(&item_type, &item_id)? else {
            without_record += 1;
            continue;
        };
        match merge(&payload, &fields, nested.as_deref()) {
            Ok(Merge::Merged(merged)) if merged == payload => stats.written += 1,
            Ok(Merge::Merged(_)) => not_merged += 1,
            Ok(Merge::Ignored) => ignored += 1,
            Err(_) => return Err(unsupported(rowid)),
        }
    }
    if not_merged > 0 {
        return Err(ImportError::CheckFailed {
            check: 1,
            detail: format!("{TABLE}: {not_merged} rows were not merged into their record"),
        });
    }
    for (reason, count) in [
        ("unknownFieldsWithoutRecord", without_record),
        ("unknownFieldsIgnored", ignored),
    ] {
        if count > 0 {
            stats.dropped.push((reason, count));
        }
    }
    Ok(stats)
}

#[cfg(test)]
#[path = "unknown_fields_tests.rs"]
mod tests;
