//! Checks on the source copies that run before any core file is written. Each fails closed:
//! a source this build cannot read completely is refused, never imported in part.
//!
//! In order: the drizzle ledger ends at the frozen migration `TABLE_MAP` describes; every table
//! is mapped (shadow tables of a mapped virtual table excepted); every `sync_state` key is
//! mapped; no table or key whose importer is still pending holds rows, and no pending delete
//! is of a type a later stage imports.

use std::collections::BTreeMap;

use rusqlite::{Connection, OptionalExtension};

use super::source::{Sources, source_error};
use super::sync_state::{self, KeyRule};
use super::tables::{
    ELECTRON_DATA_LAST_MIGRATION, ELECTRON_INDEX_LAST_MIGRATION, Importer, LEDGER_TABLE, SourceDb,
    TableMapping, mapping, pending_area,
};
use super::{ImportError, VaultImportInput};

/// Shadow tables per module, as Electron's DDL creates them: fts5 always makes these five, and
/// vec0 these four for a table with a TEXT primary key and no auxiliary or metadata columns. A
/// shadow table outside this list (another sqlite-vec version) is an unmapped table.
const FTS5_SHADOWS: &[&str] = &["data", "idx", "content", "docsize", "config"];
const VEC0_SHADOWS: &[&str] = &["chunks", "rowids", "vector_chunks00", "info"];

pub(super) struct Preflight {
    /// Every mapped table in the source with its row count, in `TABLE_MAP` order.
    pub tables: Vec<(&'static TableMapping, u64)>,
    /// `sync_state` keys dropped by rule, counted under their report name.
    pub dropped_keys: BTreeMap<String, u64>,
}

pub(super) fn run(
    sources: &Sources,
    _input: &VaultImportInput<'_>,
) -> Result<Preflight, ImportError> {
    for (db, last) in [
        (SourceDb::Data, ELECTRON_DATA_LAST_MIGRATION),
        (SourceDb::Index, ELECTRON_INDEX_LAST_MIGRATION),
    ] {
        ledger_matches(sources.conn(db), db, last)?;
    }

    let mut tables = Vec::new();
    for db in [SourceDb::Data, SourceDb::Index] {
        for table in mapped_tables(sources.conn(db), db)? {
            let count = row_count(sources.conn(db), db, table.table)?;
            tables.push((table, count));
        }
    }
    let order = |m: &TableMapping| {
        super::tables::TABLE_MAP
            .iter()
            .position(|t| t.db == m.db && t.table == m.table)
    };
    tables.sort_by_key(|(m, _)| order(m));

    let dropped_keys = sync_state_keys(sources.conn(SourceDb::Data))?;

    for (table, count) in &tables {
        if let Some(Importer::Pending(stage)) = table.class.importer()
            && *count > 0
        {
            return Err(not_ready(
                stage,
                format!("{}/{} ({stage})", table.db.name(), table.table),
            ));
        }
        if table.table == "sync_pending_deletes"
            && *count > 0
            && let Some((stage, item_type)) =
                super::tables::replay::later_stage(sources.conn(SourceDb::Data))?
        {
            return Err(not_ready(
                stage,
                format!("data.db/sync_pending_deletes {item_type} rows ({stage})"),
            ));
        }
    }
    Ok(Preflight {
        tables,
        dropped_keys,
    })
}

/// [`ImportError::NotReady`] for a pending stage, in the user's words.
fn not_ready(stage: &str, detail: String) -> ImportError {
    tracing::warn!(%detail, "the vault import is not built for this data yet");
    ImportError::NotReady {
        area: pending_area(stage).unwrap_or("data"),
        detail,
    }
}

/// The newest `__drizzle_migrations.created_at` must be the frozen journal's last `when`. An
/// older source lacks columns the map reads; a newer one may hold columns it would drop.
fn ledger_matches(conn: &Connection, db: SourceDb, expected: i64) -> Result<(), ImportError> {
    let has_ledger: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [LEDGER_TABLE],
            |row| row.get(0),
        )
        .map_err(|e| source_error(db, e))?;
    let found = if has_ledger {
        conn.query_row(
            &format!("SELECT max(CAST(created_at AS INTEGER)) FROM \"{LEDGER_TABLE}\""),
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .map_err(|e| source_error(db, e))?
    } else {
        None
    };
    if found != Some(expected) {
        return Err(ImportError::SourceSchema {
            db: db.name(),
            found,
            expected,
        });
    }
    Ok(())
}

/// The `TABLE_MAP` entries of every table in `conn`; [`ImportError::UnmappedTable`] for any
/// other table.
fn mapped_tables(
    conn: &Connection,
    db: SourceDb,
) -> Result<Vec<&'static TableMapping>, ImportError> {
    let mut stmt = conn
        .prepare(
            "SELECT name, coalesce(sql, '') FROM sqlite_master WHERE type = 'table'
             AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
        )
        .map_err(|e| source_error(db, e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| source_error(db, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| source_error(db, e))?;

    let virtuals: Vec<(&str, &[&str])> = rows
        .iter()
        .filter_map(|(name, sql)| {
            let shadows = match virtual_module(sql)?.as_str() {
                "fts5" => FTS5_SHADOWS,
                "vec0" => VEC0_SHADOWS,
                _ => &[],
            };
            Some((name.as_str(), shadows))
        })
        .collect();
    let is_shadow = |name: &str| {
        virtuals.iter().any(|(parent, shadows)| {
            name.strip_prefix(parent)
                .and_then(|rest| rest.strip_prefix('_'))
                .is_some_and(|suffix| shadows.contains(&suffix))
        })
    };

    let mut found = Vec::new();
    for (name, _) in &rows {
        if name == LEDGER_TABLE {
            continue;
        }
        match mapping(db, name) {
            Some(m) => found.push(m),
            None if is_shadow(name) => {}
            None => {
                return Err(ImportError::UnmappedTable {
                    db: db.name(),
                    table: name.clone(),
                });
            }
        }
    }
    Ok(found)
}

/// `fts5` for `CREATE VIRTUAL TABLE x USING fts5(...)`, lowercased; `None` for a plain table.
pub(super) fn virtual_module(sql: &str) -> Option<String> {
    let upper = sql.to_ascii_uppercase();
    if !upper.trim_start().starts_with("CREATE VIRTUAL TABLE") {
        return None;
    }
    let after = &sql[upper.find(" USING ")? + " USING ".len()..];
    let module: String = after
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    Some(module.to_ascii_lowercase())
}

fn row_count(conn: &Connection, db: SourceDb, table: &str) -> Result<u64, ImportError> {
    // `table` is a TABLE_MAP name, never source text.
    conn.query_row(&format!("SELECT count(*) FROM \"{table}\""), [], |row| {
        row.get::<_, i64>(0)
    })
    .map(|n| n as u64)
    .map_err(|e| source_error(db, e))
}

/// Classifies every `sync_state` key: an unknown one is [`ImportError::UnmappedSyncStateKey`],
/// a pending one [`ImportError::NotReady`]. Returns the dropped keys' counts.
fn sync_state_keys(conn: &Connection) -> Result<BTreeMap<String, u64>, ImportError> {
    let db = SourceDb::Data;
    let present: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| source_error(db, e))?;
    let mut dropped = BTreeMap::new();
    if present.is_none() {
        return Ok(dropped);
    }
    let mut stmt = conn
        .prepare("SELECT key FROM sync_state ORDER BY key")
        .map_err(|e| source_error(db, e))?;
    let keys = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| source_error(db, e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| source_error(db, e))?;
    let mut pending: Option<(&str, String)> = None;
    for key in keys {
        let Some(rule) = sync_state::classify(&key) else {
            return Err(ImportError::UnmappedSyncStateKey(key));
        };
        match rule.rule {
            KeyRule::Skip { .. } => *dropped.entry(rule.report_name()).or_default() += 1,
            KeyRule::Pending { stage, .. } => {
                pending = pending.or(Some((stage, format!("sync_state key {key} ({stage})"))));
            }
            // The `sync_state` table's importer runs the handler.
            KeyRule::Convert { .. } => {}
        }
    }
    match pending {
        Some((stage, detail)) => Err(not_ready(stage, detail)),
        None => Ok(dropped),
    }
}
