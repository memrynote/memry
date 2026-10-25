//! Copying the rows of one table from the quarantined file into the fresh
//! database, and sorting what goes wrong into damage (permanent) and trouble that
//! retrying can cure (transient). The state machine around it is in `recovery`.

use std::collections::HashSet;

use rusqlite::types::Value;
use rusqlite::{Connection, ErrorCode, params_from_iter};

use crate::api::errors::StorageError;
use crate::storage::guard::is_damage;

/// The salvage of one table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableSalvage {
    pub table: String,
    /// Rows inserted into the fresh database.
    pub copied: u64,
    /// Rows the fresh database already held (a unique key matched): kept as they
    /// were, not overwritten.
    pub already_present: u64,
    /// Rows the fresh schema refused (a constraint the damaged file had slipped).
    pub rejected: u64,
    /// Set when reading stopped early: every row before it was copied, the rest
    /// of the table lay behind damage.
    pub read_error: Option<String>,
}

/// A failure that retrying later can cure, as opposed to damage in the file.
pub(crate) fn is_transient(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                ErrorCode::DiskFull
                    | ErrorCode::DatabaseBusy
                    | ErrorCode::DatabaseLocked
                    | ErrorCode::CannotOpen
                    | ErrorCode::ReadOnly
                    | ErrorCode::OutOfMemory
                    | ErrorCode::PermissionDenied
                    | ErrorCode::OperationInterrupted
            )
    )
}

/// A transient failure on the fresh database. An I/O error there is the disk
/// misbehaving now; the same error reading the quarantine is a bad sector in
/// the damaged file and repeats on every launch, so only the former retries.
fn is_fresh_transient(err: &rusqlite::Error) -> bool {
    is_transient(err)
        || matches!(
            err,
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == ErrorCode::SystemIoFailure
        )
}

pub(crate) fn transient(what: &str, err: &rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: format!("recovery could not finish and will be retried: {what}: {err}"),
    }
}

/// Ordinary tables only: virtual tables and their shadow tables are derived.
pub(crate) fn plain_tables(conn: &Connection) -> rusqlite::Result<Vec<String>> {
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
pub(crate) fn copy_table(
    old: &Connection,
    fresh: &Connection,
    table: &str,
) -> Result<Option<TableSalvage>, StorageError> {
    let mut report = TableSalvage {
        table: table.to_owned(),
        copied: 0,
        already_present: 0,
        rejected: 0,
        read_error: None,
    };
    let fresh_columns: HashSet<String> = match columns(fresh, table) {
        Ok(found) => found.into_iter().collect(),
        Err(err) if is_fresh_transient(&err) => {
            return Err(transient("read the fresh schema", &err));
        }
        Err(err) => {
            // Skipped, and said so: a silent skip would read as "nothing there".
            report.read_error = Some(format!("could not read the fresh schema: {err}"));
            return Ok(Some(report));
        }
    };
    if fresh_columns.is_empty() {
        return Ok(None);
    }
    let shared: Vec<String> = match columns(old, table) {
        Ok(old_columns) => old_columns
            .into_iter()
            .filter(|column| fresh_columns.contains(column))
            .collect(),
        Err(err) if !is_damage(&err) && is_transient(&err) => {
            return Err(transient("read the quarantined schema", &err));
        }
        Err(err) => {
            report.read_error = Some(err.to_string());
            return Ok(Some(report));
        }
    };
    if shared.is_empty() {
        return Ok(Some(report));
    }

    let list = shared
        .iter()
        .map(|column| format!("\"{}\"", quote(column)))
        .collect::<Vec<_>>()
        .join(", ");
    let marks = vec!["?"; shared.len()].join(", ");
    // A unique-key conflict keeps the fresh row; a NOT NULL or CHECK violation
    // still errors and is counted as refused (`OR IGNORE` would drop it silently).
    let insert = format!(
        "INSERT INTO \"{}\" ({list}) VALUES ({marks}) ON CONFLICT DO NOTHING",
        quote(table)
    );
    let mut put = fresh
        .prepare(&insert)
        .map_err(|err| transient("prepare the salvage insert", &err))?;
    let mut stmt = match old.prepare(&format!("SELECT {list} FROM \"{}\"", quote(table))) {
        Ok(stmt) => stmt,
        Err(err) if !is_damage(&err) && is_transient(&err) => {
            return Err(transient("read the quarantined table", &err));
        }
        Err(err) => {
            report.read_error = Some(err.to_string());
            return Ok(Some(report));
        }
    };
    let mut rows = match stmt.query([]) {
        Ok(rows) => rows,
        Err(err) if !is_damage(&err) && is_transient(&err) => {
            return Err(transient("read the quarantined table", &err));
        }
        Err(err) => {
            report.read_error = Some(err.to_string());
            return Ok(Some(report));
        }
    };
    loop {
        // A step error that is damage is the bad page: stop, keep what came before.
        let row = match rows.next() {
            Ok(Some(row)) => row,
            Ok(None) => break,
            Err(err) if !is_damage(&err) && is_transient(&err) => {
                return Err(transient("read the quarantined table", &err));
            }
            Err(err) => {
                report.read_error = Some(err.to_string());
                break;
            }
        };
        let values: rusqlite::Result<Vec<Value>> =
            (0..shared.len()).map(|i| row.get::<_, Value>(i)).collect();
        match values.and_then(|values| put.execute(params_from_iter(values))) {
            Ok(0) => report.already_present += 1,
            Ok(_) => report.copied += 1,
            Err(err) if is_fresh_transient(&err) => {
                return Err(transient("write a salvaged row", &err));
            }
            Err(_) => report.rejected += 1,
        }
    }
    Ok(Some(report))
}

fn quote(identifier: &str) -> String {
    identifier.replace('"', "\"\"").replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copied_counts_inserted_rows_and_leaves_a_live_row_alone() {
        let old = Connection::open_in_memory().expect("old");
        let fresh = Connection::open_in_memory().expect("fresh");
        for conn in [&old, &fresh] {
            conn.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                .expect("schema");
        }
        old.execute_batch("INSERT INTO meta VALUES ('a', 'old'), ('b', 'old'), ('c', 'old')")
            .expect("old rows");
        fresh
            .execute_batch("INSERT INTO meta VALUES ('a', 'live')")
            .expect("live row");

        let report = copy_table(&old, &fresh, "meta")
            .expect("no transient failure")
            .expect("table exists");

        assert_eq!(
            (report.copied, report.already_present, report.rejected),
            (2, 1, 0)
        );
        let live: String = fresh
            .query_row("SELECT value FROM meta WHERE key = 'a'", [], |row| {
                row.get(0)
            })
            .expect("row");
        assert_eq!(live, "live", "a live row is never overwritten");
    }
}
