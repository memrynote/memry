//! Electron's attachment sync state (stage 36f1) into the Step 18 tables of core data migration
//! 0034, which keep Electron's shapes: every column lands unchanged but the upload path, so a
//! finished upload stays
//! known (`attachment-files.ts`), a queued one keeps its place, attempts and retry window
//! (`attachment-outbox.ts`), a download failure keeps its probe count and next attempt, which
//! the reference prune reads (`attachment-download-state.ts:324-366`), and a delete keeps its
//! grace (`deleted-asset-release.ts`). File bytes, partial downloads and their resume sidecars
//! are vault files the import never touches.
//!
//! Paths are vault-relative and `/`-separated in the core (`files.rs`, and the upload queue, whose
//! rows `record_uploaded` clears by the path it records). Electron queues absolute paths, so each
//! becomes the relative path Electron's own `recordPathOf` gives (`attachment-files.ts:182-186`);
//! a row outside the vault, which Electron's drain drops as `deleted` (`uploadFileState`), and a
//! recorded file that is not a plain vault path are dropped and counted.
//!
//! A value of a type Electron never writes (a count that is no integer) fails the import with
//! the table and rowid named, as every other importer does.

use std::collections::HashSet;
use std::path::Path;

use memry_core::storage::import::{
    ImportAssetRelease, ImportAttachmentFile, ImportAttachmentUpload, ImportDownloadFailure,
};
use memry_core::sync::attachments::store::files::COUNTED_EMPTY;
use rusqlite::Row;
use rusqlite::types::FromSql;

use super::records::malformed;
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};
use crate::shell::file_open::is_plain_relative;
use crate::vault::path_key::folded_key;

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
    let read = rows.len();
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|r| r.path == COUNTED_EMPTY || is_plain_relative(&r.path))
        .collect();
    ctx.writer.put_attachment_files(&rows)?;
    let mut stats = written(rows.len());
    drop_count(&mut stats, "attachmentFilesOutsideVault", read - rows.len());
    Ok(stats)
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
    let canonical_vault = std::fs::canonicalize(ctx.vault_dir).ok();
    let (mut outside, mut duplicate) = (0, 0);
    let mut seen = HashSet::new();
    let mut kept = Vec::with_capacity(rows.len());
    for mut row in rows {
        let Some(rel) = vault_relative(ctx.vault_dir, canonical_vault.as_deref(), &row.disk_path)
        else {
            outside += 1;
            continue;
        };
        // Two spellings of one vault path (through a symlink, another case) are one file; the
        // core keys a row by (note, path), so the first row in Electron's order stands for both.
        if !seen.insert((row.note_id.clone(), rel.clone())) {
            duplicate += 1;
            continue;
        }
        row.disk_path = rel;
        kept.push(row);
    }
    ctx.writer.put_attachment_uploads(&kept)?;
    let mut stats = written(kept.len());
    drop_count(&mut stats, "uploadsOutsideVault", outside);
    drop_count(&mut stats, "uploadsDuplicatePath", duplicate);
    Ok(stats)
}

/// The vault-relative, `/`-separated spelling of Electron's absolute `disk_path`, or `None` when
/// it is no plain path inside the vault. Segments compare by [`folded_key`], since APFS and NTFS
/// fold case and normalization; a vault reached through a symlink on either side matches through
/// its canonical path. The relative part keeps the row's spelling.
fn vault_relative(vault: &Path, canonical_vault: Option<&Path>, disk_path: &str) -> Option<String> {
    if !disk_path.starts_with('/') && !is_windows_path(disk_path) {
        return None;
    }
    let under = |row: &str| {
        let row = segments(row);
        [Some(vault), canonical_vault]
            .into_iter()
            .flatten()
            .find_map(|vault| {
                let vault = vault.to_string_lossy();
                let vault = segments(&vault);
                let rest = row.get(vault.len()..)?;
                let same = row
                    .iter()
                    .zip(&vault)
                    .all(|(a, b)| folded_key(a) == folded_key(b));
                same.then(|| rest.join("/"))
            })
    };
    let rel = under(disk_path).or_else(|| under(&canonical_parent(disk_path)?))?;
    is_plain_relative(&rel).then_some(rel)
}

/// A drive (`C:`) or UNC (`\\server`) path, which Electron on Windows writes with `\`.
fn is_windows_path(path: &str) -> bool {
    let b = path.as_bytes();
    path.starts_with(r"\\") || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

/// The segments of an absolute path: split on `/`, and on `\` too for a Windows path, without
/// the empty and `.` segments a trailing or doubled separator leaves. The verbatim prefix std's
/// `canonicalize` gives on Windows (`\\?\C:\`, `\\?\UNC\server`) reads as the plain path.
fn segments(path: &str) -> Vec<&str> {
    let windows = is_windows_path(path);
    let path = path
        .strip_prefix(r"\\?\UNC\")
        .or_else(|| path.strip_prefix(r"\\?\"))
        .unwrap_or(path);
    path.split(|c| c == '/' || (windows && c == '\\'))
        .filter(|s| !s.is_empty() && *s != ".")
        .collect()
}

/// `disk_path` with its deepest existing directory canonicalised. The file itself is not resolved:
/// it may be gone, and a symlinked file is still the vault's file.
fn canonical_parent(disk_path: &str) -> Option<String> {
    let path = Path::new(disk_path);
    let mut tail = vec![path.file_name()?];
    for dir in path.ancestors().skip(1) {
        if let Ok(mut real) = std::fs::canonicalize(dir) {
            real.extend(tail.iter().rev());
            return Some(real.to_string_lossy().into_owned());
        }
        tail.push(dir.file_name()?);
    }
    None
}

fn drop_count(stats: &mut TableStats, reason: &'static str, rows: usize) {
    if rows > 0 {
        stats.dropped.push((reason, rows as u64));
    }
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::vault_relative;

    fn rel(vault: &str, row: &str) -> Option<String> {
        vault_relative(Path::new(vault), None, row)
    }

    #[test]
    fn an_upload_path_becomes_vault_relative() {
        let want = Some("attachments/n1/a.png".to_owned());
        assert_eq!(rel("/v/vault", "/v/vault/attachments/n1/a.png"), want);
        assert_eq!(rel("/v/vault/", "/v/vault/attachments/n1/a.png"), want);
        assert_eq!(rel("/v/vault", "/v//vault/./attachments/n1/a.png"), want);
        // APFS and NTFS fold case and normalization: an NFD vault name is the NFC one.
        assert_eq!(
            rel("/v/Caf\u{e9}", "/V/cafe\u{301}/attachments/n1/a.png"),
            want
        );
    }

    #[test]
    fn a_windows_upload_path_splits_on_backslash() {
        let want = Some("attachments/n1/a.png".to_owned());
        let row = r"C:\Users\k\Vault\attachments\n1\a.png";
        assert_eq!(rel(r"C:\Users\k\Vault", row), want);
        assert_eq!(rel(r"c:\users\k\vault\", row), want);
        assert_eq!(rel(r"\\?\C:\Users\k\Vault", row), want);
        assert_eq!(rel("C:/Users/k/Vault", row), want);
        let unc = r"\\server\share\Vault\attachments\n1\a.png";
        assert_eq!(rel(r"\\?\UNC\server\share\Vault", unc), want);
        assert_eq!(rel(r"C:\Users\k\Other", row), None);
        // A `\` is a name character in a Unix path.
        assert_eq!(
            rel("/v/vault", r"/v/vault/attachments\n1\a.png"),
            Some(r"attachments\n1\a.png".to_owned())
        );
    }

    #[test]
    fn an_upload_path_outside_the_vault_has_none() {
        for row in [
            "/v/other/attachments/n1/a.png",
            "/v/vault2/attachments/n1/a.png",
            "/v/vault",
            "/v/vault/",
            "/v/vault/attachments/../../etc/passwd",
            "/v/vault/../vault/attachments/n1/a.png",
            "v/vault/attachments/n1/a.png",
            "",
        ] {
            assert_eq!(rel("/v/vault", row), None, "{row}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_upload_path_through_a_symlinked_vault_matches_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir_all(real.join("attachments/n1")).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let canonical = std::fs::canonicalize(&real).unwrap();
        let want = Some("attachments/n1/a.png".to_owned());
        let via_link = format!("{}/attachments/n1/a.png", link.display());
        assert_eq!(vault_relative(&real, Some(&canonical), &via_link), want);
        let via_real = format!("{}/attachments/n1/a.png", real.display());
        assert_eq!(
            vault_relative(
                &link,
                std::fs::canonicalize(&link).ok().as_deref(),
                &via_real
            ),
            want
        );
    }
}
