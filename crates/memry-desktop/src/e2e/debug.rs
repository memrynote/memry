//! Read-only SQL for agent-driven sessions and specs (`e2e_debug_query`,
//! `e2e_debug_index_query`), the port of `apps/desktop/src/main/agent-debug.ts`.
//!
//! A raw write would bypass vector clocks, the sync outbox and renderer broadcasts, leaving
//! the database and the UI disagreeing, so writes are refused twice: the statement must start
//! like a read and SQLite must call it read-only, and the connection is a pooled reader,
//! which is `query_only`. Mutations go through the UI or a named `e2e_*` command.

use memry_core::api::errors::StorageError;
use memry_core::storage::Db;
use rusqlite::types::ValueRef;
use serde_json::Value;

/// Rows returned at most.
pub const MAX_ROWS: usize = 1000;

#[derive(Debug, thiserror::Error)]
pub enum DebugQueryError {
    /// The statement is not one read. The message is what the caller sees.
    #[error("read-only: {0}")]
    ReadOnly(&'static str),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// The statement kinds that can be a plain read.
fn starts_like_a_read(sql: &str) -> bool {
    let lower = sql.trim_start().to_ascii_lowercase();
    let word = |prefix: &str| {
        lower.strip_prefix(prefix).is_some_and(|rest| {
            rest.chars()
                .next()
                .is_none_or(|c| c.is_whitespace() || c == '(' || c == '*')
        })
    };
    word("select") || word("with") || word("explain") || lower.starts_with("pragma table_info")
}

/// Runs one read statement on a reader of `db`: at most [`MAX_ROWS`] rows, each a JSON object
/// keyed by column name. Blobs come back as lowercase hex.
pub fn run(db: &Db, sql: &str) -> Result<Vec<Value>, DebugQueryError> {
    if !starts_like_a_read(sql) {
        return Err(DebugQueryError::ReadOnly(
            "only SELECT, WITH, PRAGMA table_info and EXPLAIN run here",
        ));
    }
    let sql = sql.to_owned();
    let outcome = db.read_blocking(move |conn| {
        let failed = |error: rusqlite::Error| StorageError::Failed {
            what: error.to_string(),
        };
        let mut statement = match conn.prepare(&sql) {
            Ok(statement) => statement,
            Err(rusqlite::Error::MultipleStatement) => {
                return Ok(Err("one statement at a time"));
            }
            Err(error) => return Err(failed(error)),
        };
        if !statement.readonly() {
            return Ok(Err("this statement would write"));
        }
        let names: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut rows = statement.query([]).map_err(failed)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(failed)? {
            if out.len() == MAX_ROWS {
                break;
            }
            let mut object = serde_json::Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index).map_err(failed)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => Value::from(n),
                    ValueRef::Real(n) => Value::from(n),
                    ValueRef::Text(bytes) => Value::from(String::from_utf8_lossy(bytes)),
                    ValueRef::Blob(bytes) => Value::from(hex::encode(bytes)),
                };
                object.insert(name.clone(), value);
            }
            out.push(Value::Object(object));
        }
        Ok(Ok(out))
    })?;
    outcome.map_err(DebugQueryError::ReadOnly)
}

/// [`run`] on a reader of the open vault's `data.db`.
pub fn run_on_data(
    open: &crate::session::OpenVault,
    sql: &str,
) -> Result<Vec<Value>, DebugQueryError> {
    run(&open.vault.db_handle(), sql)
}

/// [`run`] on a reader of the open vault's `index.db`.
pub fn run_on_index(
    open: &crate::session::OpenVault,
    sql: &str,
) -> Result<Vec<Value>, DebugQueryError> {
    run(&open.search.index_handle(), sql)
}
