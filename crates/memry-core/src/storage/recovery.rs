//! Recovery of a corrupt `data.db`: quarantine the file, build a fresh one, and
//! salvage every row that can still be read.
//!
//! Nothing is deleted. The damaged file keeps its name plus `.corrupt-<unix ms>`
//! (and its `-wal` and `-shm` with the same suffixes), because it may be the only
//! copy of anything that has not synced yet.
//!
//! Unlike the Electron recovery, which carries four tables and lets the rest
//! refill from vault files, **every** core table is salvaged. Core rows (tasks,
//! projects, the outbox, Yjs updates) have no other copy until they sync. The
//! `meta` table travels with them, so `device.id` survives and the vault does not
//! turn into a stranger to the server.
//!
//! Salvage never fails recovery. A table that cannot be read to the end, and a
//! row the fresh schema refuses, are counted in the [`RecoveryReport`] for the
//! shell to log.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, params_from_iter};

use crate::api::errors::StorageError;
use crate::storage::quarantine::{move_aside, now_ms};
use crate::storage::{guard, open_data};

/// What recovery did, for the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryReport {
    /// Where the damaged database now lives.
    pub quarantined: PathBuf,
    pub tables: Vec<TableSalvage>,
    /// Set when salvage could not even start or finish (the damaged file would
    /// not open, its table list was unreadable, a pragma was refused). The fresh
    /// database is empty in that case and the quarantined file still holds every
    /// row: nothing is lost, but nothing was carried over either.
    pub salvage_error: Option<String>,
}

/// The salvage of one table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableSalvage {
    pub table: String,
    pub copied: u64,
    /// Rows the fresh schema refused (a constraint the damaged file had slipped).
    pub rejected: u64,
    /// Set when reading stopped early: every row before it was copied, the rest
    /// of the table lay behind damage.
    pub read_error: Option<String>,
}

/// Moves the database at `path` aside, creates a fresh migrated one in its
/// place, and copies the salvageable rows into it. The fresh database is closed
/// again on return; open it with [`open_data`].
///
/// The caller closes every handle on `path` first: an open connection would
/// keep writing to the file that was just renamed.
pub fn quarantine_and_rebuild(path: &Path) -> Result<RecoveryReport, StorageError> {
    guard::refuse_foreign_schema(path)?;
    let quarantined = move_aside(path, "corrupt", now_ms())?;
    let fresh = open_data(path)?;
    let (tables, salvage_error) = fresh.call_blocking(|conn| Ok(salvage(&quarantined, conn)))?;
    Ok(RecoveryReport {
        quarantined,
        tables,
        salvage_error,
    })
}

/// Copies every table present in both files, over the columns both have.
/// Returns what was copied and, when salvage could not run to the end, why.
fn salvage(backup: &Path, fresh: &mut Connection) -> (Vec<TableSalvage>, Option<String>) {
    let old = match Connection::open_with_flags(
        backup,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(old) => old,
        Err(err) => {
            return (
                Vec::new(),
                Some(format!("could not open the damaged file: {err}")),
            );
        }
    };
    let tables = match plain_tables(&old) {
        Ok(tables) => tables,
        Err(err) => {
            return (
                Vec::new(),
                Some(format!("could not list the damaged file's tables: {err}")),
            );
        }
    };

    // Insertion order is the damaged file's, not the foreign-key order of the
    // fresh schema. If the pragma is refused, salvage would reject rows for
    // ordering reasons alone, so it does not run.
    if let Err(err) = fresh.execute_batch("PRAGMA foreign_keys = OFF") {
        return (
            Vec::new(),
            Some(format!("could not suspend foreign keys: {err}")),
        );
    }
    let report = tables
        .iter()
        .filter_map(|table| copy_table(&old, fresh, table))
        .collect();
    let restored = fresh
        .execute_batch("PRAGMA foreign_keys = ON")
        .err()
        .map(|err| format!("could not restore foreign keys: {err}"));
    (report, restored)
}

/// Ordinary tables only: virtual tables and their shadow tables are derived.
fn plain_tables(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;

    let virtual_names: Vec<&String> = rows
        .iter()
        .filter(|(_, sql)| {
            sql.as_deref()
                .is_some_and(|sql| sql.to_ascii_uppercase().starts_with("CREATE VIRTUAL"))
        })
        .map(|(name, _)| name)
        .collect();
    // The shadow tables an FTS5 table keeps: exactly these suffixes, not any
    // table that merely starts with the virtual table's name.
    const FTS5_SHADOWS: [&str; 5] = ["data", "idx", "content", "docsize", "config"];
    let derived = |name: &str| {
        virtual_names.iter().any(|virtual_name| {
            name == virtual_name.as_str()
                || FTS5_SHADOWS
                    .iter()
                    .any(|suffix| name == format!("{virtual_name}_{suffix}"))
        })
    };
    Ok(rows
        .iter()
        .map(|(name, _)| name)
        .filter(|name| !derived(name))
        .cloned()
        .collect())
}

fn columns(conn: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT name FROM pragma_table_info('{}')",
        quote(table)
    ))?;
    stmt.query_map([], |row| row.get(0))?.collect()
}

/// `None` when the table does not exist in the fresh schema (a concept a later
/// build removed, or a table this build never had).
fn copy_table(old: &Connection, fresh: &mut Connection, table: &str) -> Option<TableSalvage> {
    let fresh_columns: HashSet<String> = columns(fresh, table).ok()?.into_iter().collect();
    if fresh_columns.is_empty() {
        return None;
    }
    let mut report = TableSalvage {
        table: table.to_owned(),
        copied: 0,
        rejected: 0,
        read_error: None,
    };
    let shared: Vec<String> = match columns(old, table) {
        Ok(old_columns) => old_columns
            .into_iter()
            .filter(|column| fresh_columns.contains(column))
            .collect(),
        Err(err) => {
            report.read_error = Some(err.to_string());
            return Some(report);
        }
    };
    if shared.is_empty() {
        return Some(report);
    }

    let list = shared
        .iter()
        .map(|column| format!("\"{}\"", quote(column)))
        .collect::<Vec<_>>()
        .join(", ");
    let marks = vec!["?"; shared.len()].join(", ");
    let insert = format!(
        "INSERT OR REPLACE INTO \"{}\" ({list}) VALUES ({marks})",
        quote(table)
    );

    let outcome = (|| -> rusqlite::Result<()> {
        let tx = fresh.transaction()?;
        {
            let mut put = tx.prepare(&insert)?;
            let mut stmt = old.prepare(&format!("SELECT {list} FROM \"{}\"", quote(table)))?;
            let mut rows = stmt.query([])?;
            loop {
                // A step error is the damaged page: stop, keep what came before.
                let row = match rows.next() {
                    Ok(Some(row)) => row,
                    Ok(None) => break,
                    Err(err) => {
                        report.read_error = Some(err.to_string());
                        break;
                    }
                };
                let values: rusqlite::Result<Vec<Value>> =
                    (0..shared.len()).map(|i| row.get::<_, Value>(i)).collect();
                match values.and_then(|values| put.execute(params_from_iter(values))) {
                    Ok(_) => report.copied += 1,
                    Err(_) => report.rejected += 1,
                }
            }
        }
        tx.commit()
    })();
    if let Err(err) = outcome {
        report.read_error.get_or_insert(err.to_string());
    }
    Some(report)
}

fn quote(identifier: &str) -> String {
    identifier.replace('"', "\"\"").replace('\'', "''")
}
