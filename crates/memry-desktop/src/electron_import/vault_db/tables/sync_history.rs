//! `sync_history` (Step 36c3): the rows Electron's `recordHistory` writes
//! (`sync/engine/sync-state-manager.ts`) into the core's `sync_history` (data 0031). `type`
//! becomes `kind`, `created_at` (drizzle `mode: 'timestamp'`, epoch seconds) becomes ms, and
//! the newest [`history::KEEP`] rows are kept, as the core keeps them.

use memry_core::storage::import::ImportHistory;
use memry_core::sync::hardening::history;
use rusqlite::Row;
use rusqlite::types::ValueRef;

use super::super::source::source_error;
use super::super::{ImportError, TableCtx, read_source_id};
use super::{SourceDb, TableStats};

const TABLE: &str = "sync_history";

pub fn import(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    let db = SourceDb::Data;
    let mut stmt = ctx
        .source
        .prepare(
            "SELECT rowid, id, type, item_count, direction, details, duration_ms, created_at
             FROM sync_history ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(|e| source_error(db, e))?;
    let mut rows = stmt.query([]).map_err(|e| source_error(db, e))?;
    let mut kept = Vec::new();
    let (mut unreadable, mut beyond) = (0, 0);
    while let Some(row) = rows.next().map_err(|e| source_error(db, e))? {
        match entry(row)? {
            None => unreadable += 1,
            Some(_) if kept.len() as i64 == history::KEEP => beyond += 1,
            Some(entry) => kept.push(entry),
        }
    }
    kept.reverse();
    ctx.writer.put_history(&kept)?;
    let mut stats = TableStats {
        written: kept.len() as u64,
        ..TableStats::default()
    };
    for (reason, count) in [
        ("unreadableSyncHistoryRows", unreadable),
        ("syncHistoryBeyond500", beyond),
    ] {
        if count > 0 {
            stats.dropped.push((reason, count));
        }
    }
    Ok(stats)
}

/// One row as the core stores it; `None` for a row whose values Electron's schema would not
/// hold (a non-integer time or count, a non-text kind).
fn entry(row: &Row<'_>) -> Result<Option<ImportHistory>, ImportError> {
    let db = SourceDb::Data;
    let id = read_source_id(row, db, TABLE, "id")?;
    let value = |column: &str| row.get_ref(column).map_err(|e| source_error(db, e));
    let text = |value: ValueRef<'_>| match value {
        ValueRef::Text(bytes) => std::str::from_utf8(bytes).ok().map(str::to_owned),
        _ => None,
    };
    let optional_text = |value: ValueRef<'_>| match value {
        ValueRef::Null => Some(None),
        other => text(other).map(Some),
    };
    let optional_int = |value: ValueRef<'_>| match value {
        ValueRef::Null => Some(None),
        ValueRef::Integer(n) => Some(Some(n)),
        _ => None,
    };
    let (
        Some(kind),
        ValueRef::Integer(item_count),
        Some(direction),
        Some(details),
        Some(duration_ms),
        Some(created_at),
    ) = (
        text(value("type")?),
        value("item_count")?,
        optional_text(value("direction")?),
        optional_text(value("details")?),
        optional_int(value("duration_ms")?),
        match value("created_at")? {
            ValueRef::Integer(seconds) => seconds.checked_mul(1000),
            _ => None,
        },
    )
    else {
        return Ok(None);
    };
    Ok(Some(ImportHistory {
        id,
        kind,
        item_count,
        direction,
        details,
        duration_ms,
        created_at,
    }))
}
