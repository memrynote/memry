//! Importers of the record tables whose push payload Electron builds from the row alone:
//! `vault_metadata`, `folder_configs` and `property_definitions`. Each payload is the JSON
//! Electron's handler sends (`buildPushPayload`), key for key and in its order, stored verbatim
//! in `sync_items` and projected by the core.

use memry_core::storage::import::ImportRecord;
use memry_core::storage::repositories::instants::to_epoch_ms;
use rusqlite::Row;
use serde_json::{Map, Value};

use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

/// Clocks hold one counter per device; a clock past this is no clock Electron wrote.
pub const MAX_CLOCK_BYTES: usize = 64 * 1024;

/// The `vault_metadata` row Electron reads (`agent/storage/vault-id.ts:7`).
const SINGLETON_ID: &str = "singleton";

pub(super) fn malformed(table: &'static str, rowid: i64, what: &'static str) -> ImportError {
    ImportError::MalformedRow { table, rowid, what }
}

/// Electron's read of a drizzle `mode: 'json'` clock column (`JSON.parse`), where SQL `NULL`
/// and JSON `null` both mean no clock. The text is source data: it is capped before the parse,
/// and serde_json's recursion limit (128) bounds the depth. The core reader checks the shape.
pub fn parse_clock(
    text: Option<&str>,
    table: &'static str,
    rowid: i64,
) -> Result<Option<Value>, ImportError> {
    let Some(text) = text else {
        return Ok(None);
    };
    if text.len() > MAX_CLOCK_BYTES {
        return Err(malformed(table, rowid, "clock is over 64 KiB"));
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Null) => Ok(None),
        Ok(clock) => Ok(Some(clock)),
        Err(_) => Err(malformed(table, rowid, "clock is not JSON")),
    }
}

fn text(row: &Row<'_>, column: &str) -> Result<Option<String>, ImportError> {
    row.get(column).map_err(|e| source_error(SourceDb::Data, e))
}

/// Reads every row of `sql` (which selects `rowid`) through `build` and writes the records,
/// each with its `sync_unknown_fields` remainder merged in as Electron's push does.
pub(super) fn records(
    ctx: &mut TableCtx<'_>,
    sql: &str,
    build: impl Fn(&Row<'_>, i64) -> Result<ImportRecord, ImportError>,
) -> Result<TableStats, ImportError> {
    let records = {
        let mut stmt = ctx
            .source
            .prepare(sql)
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let mut records = Vec::new();
        while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
            let rowid: i64 = row
                .get("rowid")
                .map_err(|e| source_error(SourceDb::Data, e))?;
            let mut record = build(row, rowid)?;
            super::unknown_fields::merge_into(ctx.source, &mut record)?;
            records.push(record);
        }
        records
    };
    ctx.writer.put_records(&records, ctx.now_ms)?;
    Ok(TableStats {
        written: records.len() as u64,
        dropped: Vec::new(),
    })
}

fn insert_clock(
    payload: &mut Map<String, Value>,
    row: &Row<'_>,
    table: &'static str,
    rowid: i64,
) -> Result<(), ImportError> {
    // `clock ?? undefined`: JSON.stringify leaves the key out.
    if let Some(clock) = parse_clock(text(row, "clock")?.as_deref(), table, rowid)? {
        payload.insert("clock".into(), clock);
    }
    Ok(())
}

/// `vault_metadata`: the singleton's uuid becomes the core vault id, byte for byte. It must be
/// the id the import runs under (Step 37 reads it from the same row); other rows are never
/// read by Electron and are dropped.
pub fn vault_metadata(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "vault_metadata";
    let uuids = {
        let mut stmt = ctx
            .source
            .prepare("SELECT rowid, id, vault_uuid FROM vault_metadata")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let mut rows = stmt
            .query([])
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let mut uuids = Vec::new();
        while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
            let id = read_source_id(row, SourceDb::Data, TABLE, "id")?;
            uuids.push(
                (id == SINGLETON_ID)
                    .then(|| read_source_id(row, SourceDb::Data, TABLE, "vault_uuid"))
                    .transpose()?,
            );
        }
        uuids
    };
    let mut stats = TableStats::default();
    let others = uuids.iter().filter(|uuid| uuid.is_none()).count() as u64;
    if others > 0 {
        stats.dropped.push(("vaultMetadataNotSingleton", others));
    }
    if let Some(uuid) = uuids.into_iter().flatten().next() {
        if uuid != ctx.vault_id {
            return Err(ImportError::CheckFailed {
                check: 5,
                detail: "vault_metadata holds another vault uuid than the import runs under".into(),
            });
        }
        ctx.writer.put_vault_id(&uuid)?;
        stats.written = 1;
    }
    Ok(stats)
}

/// `folder_configs` as `folder-config-handler.ts:176-192` pushes it; the id is the path.
pub fn folder_configs(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "folder_configs";
    records(
        ctx,
        "SELECT rowid, path, icon, clock, created_at, modified_at FROM folder_configs",
        |row, rowid| {
            let mut payload = Map::new();
            payload.insert("icon".into(), Value::from(text(row, "icon")?));
            insert_clock(&mut payload, row, TABLE, rowid)?;
            payload.insert("createdAt".into(), Value::from(text(row, "created_at")?));
            payload.insert("modifiedAt".into(), Value::from(text(row, "modified_at")?));
            Ok(ImportRecord {
                item_type: "folder_config",
                item_id: read_source_id(row, SourceDb::Data, TABLE, "path")?,
                payload: Value::Object(payload).to_string(),
                synced_at: None,
            })
        },
    )
}

/// `property_definitions` as `property-definition-handler.ts:134-156` pushes it; the id is the
/// name. `synced_at` (ISO text) projects as epoch ms.
pub fn property_definitions(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "property_definitions";
    records(
        ctx,
        "SELECT rowid, name, type, options, default_value, color, clock, created_at, synced_at \
         FROM property_definitions",
        |row, rowid| {
            let name = read_source_id(row, SourceDb::Data, TABLE, "name")?;
            let mut payload = Map::new();
            payload.insert("name".into(), Value::from(name.clone()));
            payload.insert("type".into(), Value::from(text(row, "type")?));
            payload.insert("options".into(), Value::from(text(row, "options")?));
            payload.insert(
                "defaultValue".into(),
                Value::from(text(row, "default_value")?),
            );
            payload.insert("color".into(), Value::from(text(row, "color")?));
            insert_clock(&mut payload, row, TABLE, rowid)?;
            payload.insert("createdAt".into(), Value::from(text(row, "created_at")?));
            let synced_at = text(row, "synced_at")?
                .map(|iso| {
                    to_epoch_ms(&iso)
                        .ok_or_else(|| malformed(TABLE, rowid, "synced_at is not an ISO instant"))
                })
                .transpose()?;
            Ok(ImportRecord {
                item_type: "property_definition",
                item_id: name,
                payload: Value::Object(payload).to_string(),
                synced_at,
            })
        },
    )
}
