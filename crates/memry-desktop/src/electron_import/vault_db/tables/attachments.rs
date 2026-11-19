//! Electron's attachment sync state (stage 36f1) into the Step 18 tables of core data migration
//! 0034, which keep Electron's shapes: every column lands unchanged, so a finished upload stays
//! known (`attachment-files.ts`), a queued one keeps its place, attempts and retry window
//! (`attachment-outbox.ts`), a download failure keeps its probe count and next attempt, which
//! the reference prune reads (`attachment-download-state.ts:324-366`), and a delete keeps its
//! grace (`deleted-asset-release.ts`). File bytes, partial downloads and their resume sidecars
//! are vault files the import never touches.
//!
//! A value of a type Electron never writes (a count that is no integer) fails the import with
//! the table and rowid named, as every other importer does.

use memry_core::storage::import::{
    ImportAssetRelease, ImportAttachmentFile, ImportAttachmentUpload, ImportDownloadFailure,
};
use rusqlite::Row;
use rusqlite::types::FromSql;

use super::records::malformed;
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

pub fn attachment_files(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "attachment_files";
    let rows = read(
        ctx,
        "SELECT rowid, note_id, path, attachment_id, recorded_at FROM attachment_files \
         ORDER BY rowid",
        |row, rowid| {
            Ok(ImportAttachmentFile {
                note_id: read_source_id(row, SourceDb::Data, TABLE, "note_id")?,
                path: get(row, TABLE, rowid, "path")?,
                attachment_id: get(row, TABLE, rowid, "attachment_id")?,
                recorded_at: get(row, TABLE, rowid, "recorded_at")?,
            })
        },
    )?;
    ctx.writer.put_attachment_files(&rows)?;
    Ok(written(rows.len()))
}

pub fn attachment_upload_queue(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "attachment_upload_queue";
    let rows = read(
        ctx,
        "SELECT rowid, id, note_id, disk_path, attempts, last_error, created_at, updated_at \
         FROM attachment_upload_queue ORDER BY rowid",
        |row, rowid| {
            Ok(ImportAttachmentUpload {
                id: read_source_id(row, SourceDb::Data, TABLE, "id")?,
                note_id: read_source_id(row, SourceDb::Data, TABLE, "note_id")?,
                disk_path: get(row, TABLE, rowid, "disk_path")?,
                attempts: get(row, TABLE, rowid, "attempts")?,
                last_error: get(row, TABLE, rowid, "last_error")?,
                created_at: get(row, TABLE, rowid, "created_at")?,
                updated_at: get(row, TABLE, rowid, "updated_at")?,
            })
        },
    )?;
    ctx.writer.put_attachment_uploads(&rows)?;
    Ok(written(rows.len()))
}

pub fn attachment_download_failures(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "attachment_download_failures";
    let rows = read(
        ctx,
        "SELECT rowid, id, owner_id, attachment_id, reason, attempts, last_error, \
         next_attempt_at, updated_at FROM attachment_download_failures ORDER BY rowid",
        |row, rowid| {
            Ok(ImportDownloadFailure {
                id: read_source_id(row, SourceDb::Data, TABLE, "id")?,
                owner_id: read_source_id(row, SourceDb::Data, TABLE, "owner_id")?,
                attachment_id: read_source_id(row, SourceDb::Data, TABLE, "attachment_id")?,
                reason: get(row, TABLE, rowid, "reason")?,
                attempts: get(row, TABLE, rowid, "attempts")?,
                last_error: get(row, TABLE, rowid, "last_error")?,
                next_attempt_at: get(row, TABLE, rowid, "next_attempt_at")?,
                updated_at: get(row, TABLE, rowid, "updated_at")?,
            })
        },
    )?;
    ctx.writer.put_download_failures(&rows)?;
    Ok(written(rows.len()))
}

pub fn deleted_asset_releases(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "deleted_asset_releases";
    let rows = read(
        ctx,
        "SELECT rowid, item_type, item_id, deleted_at, attachment_ids \
         FROM deleted_asset_releases ORDER BY rowid",
        |row, rowid| {
            Ok(ImportAssetRelease {
                item_type: get(row, TABLE, rowid, "item_type")?,
                item_id: read_source_id(row, SourceDb::Data, TABLE, "item_id")?,
                deleted_at: get(row, TABLE, rowid, "deleted_at")?,
                attachment_ids: get(row, TABLE, rowid, "attachment_ids")?,
            })
        },
    )?;
    ctx.writer.put_asset_releases(&rows)?;
    Ok(written(rows.len()))
}

/// Every row of `sql` (which selects `rowid` first) through `build`.
fn read<T>(
    ctx: &TableCtx<'_>,
    sql: &str,
    build: impl Fn(&Row<'_>, i64) -> Result<T, ImportError>,
) -> Result<Vec<T>, ImportError> {
    let source_err = |e| source_error(SourceDb::Data, e);
    let mut stmt = ctx.source.prepare(sql).map_err(source_err)?;
    let mut rows = stmt.query([]).map_err(source_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(source_err)? {
        let rowid = row.get("rowid").map_err(source_err)?;
        out.push(build(row, rowid)?);
    }
    Ok(out)
}

/// A column read as the type Electron writes; any other type or non-UTF-8 text is a malformed
/// row.
fn get<T: FromSql>(
    row: &Row<'_>,
    table: &'static str,
    rowid: i64,
    column: &str,
) -> Result<T, ImportError> {
    row.get(column).map_err(|error| match error {
        rusqlite::Error::InvalidColumnType(..)
        | rusqlite::Error::FromSqlConversionFailure(..)
        | rusqlite::Error::IntegralValueOutOfRange(..) => malformed(
            table,
            rowid,
            "a column holds a type Electron does not write",
        ),
        other => source_error(SourceDb::Data, other),
    })
}

fn written(rows: usize) -> TableStats {
    TableStats {
        written: rows as u64,
        ..TableStats::default()
    }
}
