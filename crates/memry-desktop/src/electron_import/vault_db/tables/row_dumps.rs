//! `templates` and `custom_icons`, whose handlers push the drizzle row itself
//! (`template-handler.ts:150-159`, `custom-icon-handler.ts:156-165`: `JSON.stringify(row)`):
//! every column in schema order under its drizzle key, `mode: 'json'` columns parsed, `clock`
//! present even when null, and the device-local `id` and `syncedAt` included. Also the column
//! reads the other importers of this stage share.

use memry_core::storage::import::ImportRecord;
use memry_core::storage::repositories::instants::to_epoch_ms;
use rusqlite::Row;
use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

use super::js_json::{self, JsonError};
use super::records::{malformed, records};
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

/// A column as better-sqlite3 hands it to drizzle: integers and reals as numbers, text as
/// strings. A blob (a Buffer in JS) or text that is not UTF-8 is no value Electron's writers
/// store there and fails the row.
pub(super) fn column(
    row: &Row<'_>,
    name: &str,
    table: &'static str,
    rowid: i64,
) -> Result<Value, ImportError> {
    Ok(
        match row
            .get_ref(name)
            .map_err(|e| source_error(SourceDb::Data, e))?
        {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(n) => Value::from(n),
            ValueRef::Real(n) => Value::from(n),
            ValueRef::Text(bytes) => Value::String(
                String::from_utf8(bytes.to_vec())
                    .map_err(|_| malformed(table, rowid, "a text column is not UTF-8"))?,
            ),
            ValueRef::Blob(_) => return Err(malformed(table, rowid, "a column holds a blob")),
        },
    )
}

/// A drizzle `mode: 'json'` column: `JSON.parse` of the stored text, SQL `NULL` as `null`.
/// Text that does not parse makes `buildPushPayload` throw, so the row fails here.
pub(super) fn json_column(
    row: &Row<'_>,
    name: &str,
    table: &'static str,
    rowid: i64,
) -> Result<Value, ImportError> {
    match column(row, name, table, rowid)? {
        Value::String(text) => js_json::parse(&text).map_err(|error| {
            malformed(
                table,
                rowid,
                match error {
                    JsonError::NotJson => "a JSON column is not JSON",
                    JsonError::Unsupported => "a JSON column this import cannot re-serialise",
                },
            )
        }),
        other => Ok(other),
    }
}

/// `synced_at` (ISO text) as epoch ms for the projection.
pub(super) fn synced_at(
    row: &Row<'_>,
    table: &'static str,
    rowid: i64,
) -> Result<Option<i64>, ImportError> {
    match column(row, "synced_at", table, rowid)? {
        Value::Null => Ok(None),
        Value::String(iso) => to_epoch_ms(&iso)
            .map(Some)
            .ok_or_else(|| malformed(table, rowid, "synced_at is not an ISO instant")),
        _ => Err(malformed(table, rowid, "synced_at is not an ISO instant")),
    }
}

/// `(drizzle key, column, mode: 'json')` in schema order.
type Columns = &'static [(&'static str, &'static str, bool)];

const TEMPLATE_COLUMNS: Columns = &[
    ("id", "id", false),
    ("name", "name", false),
    ("description", "description", false),
    ("icon", "icon", false),
    ("tags", "tags", true),
    ("properties", "properties", true),
    ("content", "content", false),
    ("clock", "clock", true),
    ("syncedAt", "synced_at", false),
    ("createdAt", "created_at", false),
    ("modifiedAt", "modified_at", false),
];

const CUSTOM_ICON_COLUMNS: Columns = &[
    ("id", "id", false),
    ("name", "name", false),
    ("ext", "ext", false),
    ("data", "data", false),
    ("createdAt", "created_at", false),
    ("updatedAt", "updated_at", false),
    ("clock", "clock", true),
    ("syncedAt", "synced_at", false),
];

fn row_dump(
    ctx: &mut TableCtx<'_>,
    table: &'static str,
    item_type: &'static str,
    columns: Columns,
) -> Result<TableStats, ImportError> {
    let names: Vec<&str> = columns.iter().map(|(_, column, _)| *column).collect();
    let sql = format!("SELECT rowid, {} FROM {table}", names.join(", "));
    records(ctx, &sql, |row, rowid| {
        let mut payload = Map::new();
        for (key, name, json) in columns {
            let value = if *json {
                json_column(row, name, table, rowid)?
            } else {
                column(row, name, table, rowid)?
            };
            payload.insert((*key).into(), value);
        }
        Ok(ImportRecord {
            item_type,
            item_id: read_source_id(row, SourceDb::Data, table, "id")?,
            payload: js_json::stringify(&Value::Object(payload)),
            synced_at: synced_at(row, table, rowid)?,
        })
    })
}

pub fn templates(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    row_dump(ctx, "templates", "template", TEMPLATE_COLUMNS)
}

/// The base64 icon travels in the payload; the core keeps it there only (payload-only record),
/// and the `.memry/icons/` files stay as they are.
pub fn custom_icons(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    row_dump(ctx, "custom_icons", "custom_icon", CUSTOM_ICON_COLUMNS)
}
