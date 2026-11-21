//! The device-local index of Readwise highlight dates behind the journal day sections
//! (`highlights-index.ts`, #3476 D17), over `readwise_highlights` (data migration 0038). A run
//! keeps it current; a full export replaces it, so a device that takes over renders the bytes
//! the old one wrote. It never syncs: a full export refills it.

use std::collections::HashSet;

use rusqlite::{Connection, params, params_from_iter};

use crate::api::errors::StorageError;
use crate::domain::readwise::set_run_state;
use crate::storage::nested_tx;

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// SQLite builds before 3.32 bind at most 999 variables: one per looked-up id.
const LOOKUP_CHUNK: usize = 500;

/// One highlight a run saw. `highlighted_at` and `created_at` are ISO instants
/// (`highlightInstant`), `None` when the payload's value is missing or not a date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexRow {
    pub highlight_id: i64,
    pub book_id: i64,
    pub highlighted_at: Option<String>,
    pub created_at: Option<String>,
    /// The book, the highlight, or its discard flag says it is gone.
    pub deleted: bool,
}

/// A live highlight of the index (`IndexedHighlight`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexedHighlight {
    pub highlight_id: i64,
    pub book_id: i64,
    /// `highlighted_at`, or `created_at` when it is missing.
    pub at: String,
}

/// What [`record`] writes besides the rows: the run-state keys it owns in the same
/// transaction, so a crash never leaves the index ahead of the days the journal owes.
pub struct Record<'a> {
    pub rows: &'a [IndexRow],
    /// The rows come from a full export: they replace the index, and `ready_key` is set.
    pub rebuild: bool,
    /// Books deleted in Readwise: every highlight of each is deleted, listed or not.
    pub deleted_books: &'a [i64],
    pub ready_key: &'a str,
    pub pending_key: &'a str,
}

/// The ids among `ids` the index holds (`knownHighlightIds`).
fn known_ids(conn: &Connection, ids: &[i64]) -> Result<HashSet<i64>, StorageError> {
    let mut known = HashSet::new();
    for chunk in ids.chunks(LOOKUP_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql =
            format!("SELECT highlight_id FROM readwise_highlights WHERE highlight_id IN ({marks})");
        let mut statement = conn.prepare(&sql).map_err(failed)?;
        let rows = statement
            .query_map(params_from_iter(chunk), |row| row.get::<_, i64>(0))
            .map_err(failed)?;
        for id in rows {
            known.insert(id.map_err(failed)?);
        }
    }
    Ok(known)
}

/// `upsertHighlights` / `replaceIndex`, `markBooksDeleted` and the pending days, in one
/// transaction (`recordHighlights`). `pending` gets the ids among `rows` the index held before
/// this write and the stored pending text, and answers the text to store (`None` deletes it).
pub fn record(
    conn: &mut Connection,
    record: &Record<'_>,
    now_ms: i64,
    pending: impl FnOnce(&HashSet<i64>, Option<String>) -> Option<String>,
) -> Result<(), StorageError> {
    let tx = nested_tx::begin(conn).map_err(failed)?;
    let ids: Vec<i64> = record.rows.iter().map(|row| row.highlight_id).collect();
    let known = known_ids(&tx, &ids)?;
    let stored = super::readwise::run_state(&tx, record.pending_key)?;
    let next = pending(&known, stored);
    if record.rebuild {
        tx.execute("DELETE FROM readwise_highlights", [])
            .map_err(failed)?;
    }
    {
        let mut insert = tx
            .prepare(
                "INSERT INTO readwise_highlights \
                 (highlight_id, book_id, highlighted_at, created_at, deleted) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(highlight_id) DO UPDATE SET book_id = excluded.book_id, \
                 highlighted_at = excluded.highlighted_at, created_at = excluded.created_at, \
                 deleted = excluded.deleted",
            )
            .map_err(failed)?;
        for row in record.rows {
            insert
                .execute(params![
                    row.highlight_id,
                    row.book_id,
                    row.highlighted_at,
                    row.created_at,
                    row.deleted
                ])
                .map_err(failed)?;
        }
    }
    if record.rebuild {
        set_run_state(&tx, record.ready_key, Some("ready"), now_ms)?;
    }
    for chunk in record.deleted_books.chunks(LOOKUP_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!("UPDATE readwise_highlights SET deleted = 1 WHERE book_id IN ({marks})");
        tx.execute(&sql, params_from_iter(chunk)).map_err(failed)?;
    }
    set_run_state(&tx, record.pending_key, next.as_deref(), now_ms)?;
    tx.commit().map_err(failed)
}

/// `highlightsBetween`: the live highlights whose date is in `[from, to)`, ISO instants. A day
/// is a local date, so the caller widens its window and filters by day afterwards.
pub fn between(
    conn: &Connection,
    from: &str,
    to: &str,
) -> Result<Vec<IndexedHighlight>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT highlight_id, book_id, at FROM (SELECT highlight_id, book_id, deleted, \
             coalesce(highlighted_at, created_at) AS at FROM readwise_highlights) \
             WHERE at >= ?1 AND at < ?2 AND deleted = 0 ORDER BY highlight_id",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![from, to], |row| {
            Ok(IndexedHighlight {
                highlight_id: row.get(0)?,
                book_id: row.get(1)?,
                at: row.get(2)?,
            })
        })
        .map_err(failed)?;
    rows.collect::<Result<_, _>>().map_err(failed)
}
