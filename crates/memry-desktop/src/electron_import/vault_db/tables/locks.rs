//! `vault_locks`, `vault_lock_baselines` and `vault_lock_file_modes` (Electron
//! `vault-locks/store.ts`, core `domain::vault_locks`). A lock is a `vault_lock` record built as
//! `vault-lock-handler.ts:119-136` pushes it, so a locked note or folder stays locked. Its
//! baseline (the text an outside edit is reverted to) and the file modes the lock replaced are
//! device-local and land through the core owner's writers, so the first open's lock reconcile
//! (`locks::reconcile`) finds the baseline Electron kept instead of taking the file as found.
//! A file mode lands without Electron's identity ([`ImportFileMode`] says why).

use memry_core::storage::import::{ImportFileMode, ImportLockBaseline, ImportRecord};
use memry_core::storage::repositories::instants::to_epoch_ms;
use serde_json::{Map, Value};

use super::records::{insert_clock, malformed, records, text};
use super::row_dumps::{column, synced_at};
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

pub fn vault_locks(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "vault_locks";
    records(
        ctx,
        "SELECT rowid, id, target_kind, target, locked, created_at, updated_at, clock, synced_at \
         FROM vault_locks",
        |row, rowid| {
            let mut payload = Map::new();
            payload.insert("targetKind".into(), Value::from(text(row, "target_kind")?));
            payload.insert("target".into(), Value::from(text(row, "target")?));
            let locked = match column(row, "locked", TABLE, rowid)? {
                Value::Number(n) => n.as_f64() != Some(0.0),
                _ => return Err(malformed(TABLE, rowid, "locked is not a number")),
            };
            payload.insert("locked".into(), Value::Bool(locked));
            insert_clock(&mut payload, row, TABLE, rowid)?;
            payload.insert("createdAt".into(), Value::from(text(row, "created_at")?));
            payload.insert("updatedAt".into(), Value::from(text(row, "updated_at")?));
            Ok(ImportRecord {
                item_type: "vault_lock",
                item_id: read_source_id(row, SourceDb::Data, TABLE, "id")?,
                payload: Value::Object(payload).to_string(),
                synced_at: synced_at(row, TABLE, rowid)?,
            })
        },
    )
}

pub fn vault_lock_baselines(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "vault_lock_baselines";
    let rows = read_rows(
        ctx,
        "SELECT rowid, note_id, content_hash, content, updated_at FROM vault_lock_baselines",
        |row, rowid| {
            let updated_at = text(row, "updated_at")?
                .and_then(|iso| to_epoch_ms(&iso))
                .ok_or_else(|| malformed(TABLE, rowid, "updated_at is not an ISO instant"))?;
            Ok(ImportLockBaseline {
                note_id: read_source_id(row, SourceDb::Data, TABLE, "note_id")?,
                content: required(text(row, "content")?, TABLE, rowid)?,
                content_hash: required(text(row, "content_hash")?, TABLE, rowid)?,
                updated_at,
            })
        },
    )?;
    ctx.writer.put_lock_state(&rows, &[])?;
    Ok(written(rows.len()))
}

pub fn vault_lock_file_modes(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "vault_lock_file_modes";
    let rows = read_rows(
        ctx,
        "SELECT rowid, path, mode FROM vault_lock_file_modes",
        |row, rowid| {
            let mode = match column(row, "mode", TABLE, rowid)? {
                Value::Number(n) => n.as_u64().and_then(|n| u32::try_from(n).ok()),
                _ => None,
            }
            .ok_or_else(|| malformed(TABLE, rowid, "mode is not a permission mask"))?;
            Ok(ImportFileMode {
                path: read_source_id(row, SourceDb::Data, TABLE, "path")?,
                mode,
            })
        },
    )?;
    ctx.writer.put_lock_state(&[], &rows)?;
    Ok(written(rows.len()))
}

fn required(value: Option<String>, table: &'static str, rowid: i64) -> Result<String, ImportError> {
    value.ok_or_else(|| malformed(table, rowid, "a NOT NULL column is NULL"))
}

fn written(rows: usize) -> TableStats {
    TableStats {
        written: rows as u64,
        ..TableStats::default()
    }
}

pub(super) fn read_rows<T>(
    ctx: &TableCtx<'_>,
    sql: &str,
    mut build: impl FnMut(&rusqlite::Row<'_>, i64) -> Result<T, ImportError>,
) -> Result<Vec<T>, ImportError> {
    let mut stmt = ctx
        .source
        .prepare(sql)
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let rowid: i64 = row
            .get("rowid")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        out.push(build(row, rowid)?);
    }
    Ok(out)
}
