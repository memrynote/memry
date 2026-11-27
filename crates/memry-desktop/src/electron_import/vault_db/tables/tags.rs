//! `tag_categories` and `tag_definitions`, as their handlers build the push payload.

use memry_core::storage::import::ImportRecord;
use serde_json::{Map, Value};

use super::js_json::{self, JsonError};
use super::records::{malformed, records};
use super::row_dumps::{column, json_column};
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};
use crate::web::extract::utils::js::to_number;

/// `tag-category-handler.ts:117-134`.
pub fn tag_categories(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "tag_categories";
    records(
        ctx,
        "SELECT rowid, id, name, sort_order, deleted_at, clock, created_at, updated_at \
         FROM tag_categories",
        |row, rowid| {
            let mut payload = Map::new();
            payload.insert("name".into(), column(row, "name", TABLE, rowid)?);
            payload.insert("sortOrder".into(), column(row, "sort_order", TABLE, rowid)?);
            payload.insert("deletedAt".into(), column(row, "deleted_at", TABLE, rowid)?);
            insert_clock(&mut payload, json_column(row, "clock", TABLE, rowid)?);
            payload.insert("createdAt".into(), column(row, "created_at", TABLE, rowid)?);
            payload.insert("updatedAt".into(), column(row, "updated_at", TABLE, rowid)?);
            Ok(ImportRecord {
                item_type: "tag_category",
                item_id: read_source_id(row, SourceDb::Data, TABLE, "id")?,
                payload: js_json::stringify(&Value::Object(payload)),
                synced_at: None,
            })
        },
    )
}

/// `tag-definition-handler.ts:201-228`; the id is the name.
pub fn tag_definitions(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "tag_definitions";
    records(
        ctx,
        "SELECT rowid, name, color, color_authored, icon, category_id, sort_order, views, \
         schema, clock, created_at FROM tag_definitions",
        |row, rowid| {
            let name = read_source_id(row, SourceDb::Data, TABLE, "name")?;
            let unreadable = |error| match error {
                JsonError::NotJson => Ok(None),
                JsonError::Unsupported => Err(malformed(
                    TABLE,
                    rowid,
                    "views or schema this import cannot re-serialise",
                )),
            };
            let mut payload = Map::new();
            payload.insert("name".into(), Value::from(name.clone()));
            payload.insert("color".into(), column(row, "color", TABLE, rowid)?);
            payload.insert(
                "colorAuthored".into(),
                drizzle_bool(column(row, "color_authored", TABLE, rowid)?),
            );
            payload.insert("icon".into(), column(row, "icon", TABLE, rowid)?);
            payload.insert(
                "categoryId".into(),
                column(row, "category_id", TABLE, rowid)?,
            );
            payload.insert("sortOrder".into(), column(row, "sort_order", TABLE, rowid)?);
            // `readTagViews`: an empty or unparsable column, or one that is no array, is
            // `null`, and the key is left out.
            if let Value::String(text) = column(row, "views", TABLE, rowid)?
                && !text.is_empty()
                && let Some(views @ Value::Array(_)) =
                    js_json::parse(&text).map(Some).or_else(unreadable)?
            {
                payload.insert("views".into(), views);
            }
            // `readSchemaColumn` and `readVersionedObject`: only a plain object is sent.
            if let Value::String(text) = column(row, "schema", TABLE, rowid)?
                && let Some(schema @ Value::Object(_)) =
                    js_json::parse(&text).map(Some).or_else(unreadable)?
            {
                payload.insert("schema".into(), schema);
            }
            insert_clock(&mut payload, json_column(row, "clock", TABLE, rowid)?);
            payload.insert("createdAt".into(), column(row, "created_at", TABLE, rowid)?);
            Ok(ImportRecord {
                item_type: "tag_definition",
                item_id: name,
                payload: js_json::stringify(&Value::Object(payload)),
                synced_at: None,
            })
        },
    )
}

/// `clock ?? undefined`: `JSON.stringify` leaves a null clock out.
fn insert_clock(payload: &mut Map<String, Value>, clock: Value) {
    if !clock.is_null() {
        payload.insert("clock".into(), clock);
    }
}

/// drizzle's boolean integer: `Number(value) === 1`; SQL `NULL` stays `null`.
pub(super) fn drizzle_bool(value: Value) -> Value {
    Value::Bool(match value {
        Value::Null => return Value::Null,
        Value::Number(n) => n.as_f64() == Some(1.0),
        Value::String(s) => to_number(&s) == 1.0,
        _ => false,
    })
}
