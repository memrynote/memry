//! Full-text search and the incremental index that feeds it (T131, FR-053,
//! data-model §A.5).
//!
//! Two databases, one direction. `data.db` is the source of record; `index.db`
//! holds `fts_notes` and `fts_tasks` and is **rebuildable by definition**
//! (§A.1). Nothing here is the only copy of anything: delete `index.db` and
//! [`reindex`] rebuilds every row of it from `data.db`, which is what
//! [`crate::storage::index_db`] already assumes when it throws the file away.
//!
//! ## The ranking weights are the contract
//!
//! `bm25(fts_notes, 0.0, 2.0, 1.0, 1.0)` and
//! `bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0)`, with the column order the migration
//! writes, are what FR-053 means by "the same ranking function desktop uses".
//! They are not a tuning knob and they are deliberately not configurable: a
//! different weight vector produces a different order for the same corpus and
//! fails the requirement. bm25 returns a **negative** score, more negative for
//! a better match, so every query here orders ascending.
//!
//! FR-053 claims the ranking *function*, not identical ordering: desktop
//! indexes markdown and this core indexes `extract_text` output (§A.5), and
//! those are not the same bytes.
//!
//! ## A user string is not an FTS5 query
//!
//! A raw string handed to `MATCH` is parsed as an FTS5 expression, so a lone
//! `"`, a bare `*`, a `-`, a `:`, `NEAR`, `OR` or a `(` either changes the
//! query the user meant or raises a SQL error that reaches the caller as a
//! failed search. [`match_expression`] therefore **never** passes user text
//! through. It splits the string on every non-alphanumeric character — which
//! is what the `unicode61` tokenizer does to the indexed side anyway, so no
//! term is lost that the index could have matched — wraps each surviving run
//! in double quotes, and joins them with an explicit `AND`.
//!
//! That is safe by construction rather than by escaping: an FTS5 string
//! literal ends at its closing quote, every syntax character FTS5 recognises is
//! ASCII punctuation, and a run of alphanumerics contains none of them. So no
//! input can close the quote, and `OR` arrives as the word "or" rather than as
//! an operator. A string with no alphanumeric run at all yields `None` and the
//! search returns no hits without touching SQL.
//!
//! Prefix (`*`), `NEAR`, `OR` and column filters are deliberately not exposed.
//! Nothing in FR-053 asks for them and each one is a second syntax to keep
//! parity on.
//!
//! ## Nothing is dropped quietly
//!
//! A row whose payload will not parse is a **hard error**, never a skipped
//! row, and no query here uses `filter_map`: a search that silently omits a
//! note it could not read tells the user the note does not exist, which is
//! indistinguishable from having lost it. The one exception is a row the apply
//! path already recorded as corrupt (`sync_items.corrupt_reason`) — that
//! failure was reported loudly once already, so it is counted in
//! [`Reindexed::corrupt_skipped`] and not raised twice.
//!
//! The core owns no markdown here either. `content` comes from
//! `extract_text` over the body document (chapter 12 §12.1), which is the
//! core's only text operation; this module writes no second extractor.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;

mod maintenance;

pub use maintenance::{
    DATA_VERSION_KEY, NOTES_WATERMARK_KEY, Reindexed, TASKS_WATERMARK_KEY, reindex,
};

/// The `fts_notes` ranking expression. Part of the contract (§A.5).
pub const NOTES_RANK: &str = "bm25(fts_notes, 0.0, 2.0, 1.0, 1.0)";
/// The `fts_tasks` ranking expression. Part of the contract (§A.5).
pub const TASKS_RANK: &str = "bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0)";

/// What a hit is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitKind {
    Note,
    /// Journals live in `fts_notes` beside notes and are told apart by the
    /// `date` on their `journal_entries` row (§A.5), which is the only place
    /// that date exists — `journal_entries` has no `title` column.
    Journal {
        date: String,
    },
    Task,
}

/// One result, already ranked.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub kind: HitKind,
    /// The bm25 score. Negative; more negative is a better match.
    pub score: f64,
}

/// Searches notes and journals.
///
/// `data` is consulted for every hit, so a tombstone applied since the last
/// [`reindex`] cannot surface: the index is allowed to be stale, the answer is
/// not. That can return fewer than `limit` hits, which is the correct trade.
pub fn search_notes(
    data: &Connection,
    index: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, StorageError> {
    let Some(expression) = match_expression(query) else {
        return Ok(Vec::new());
    };
    let sql = format!(
        "SELECT id, title, {NOTES_RANK} AS score
         FROM fts_notes WHERE fts_notes MATCH ?1 ORDER BY score LIMIT ?2"
    );
    let mut hits = Vec::new();
    for (id, title, score) in scored(index, &sql, &expression, limit)? {
        let Some(kind) = note_kind(data, &id)? else {
            continue;
        };
        hits.push(SearchHit {
            id,
            title,
            kind,
            score,
        });
    }
    Ok(hits)
}

/// Searches tasks.
///
/// Two corpora cannot share one ranking: a bm25 score is relative to the table
/// it was computed over, so a note score and a task score are not comparable
/// and this returns its own ranked list rather than inventing an interleaving.
pub fn search_tasks(
    data: &Connection,
    index: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, StorageError> {
    let Some(expression) = match_expression(query) else {
        return Ok(Vec::new());
    };
    let sql = format!(
        "SELECT id, title, {TASKS_RANK} AS score
         FROM fts_tasks WHERE fts_tasks MATCH ?1 ORDER BY score LIMIT ?2"
    );
    let mut hits = Vec::new();
    for (id, title, score) in scored(index, &sql, &expression, limit)? {
        if !is_live(data, "task", &id)? {
            continue;
        }
        hits.push(SearchHit {
            id,
            title,
            kind: HitKind::Task,
            score,
        });
    }
    Ok(hits)
}

/// Turns a user string into an FTS5 `MATCH` expression, or `None` when it
/// carries no searchable term. See the module documentation for why this is a
/// rewrite and not an escape.
pub fn match_expression(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{term}\""))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" AND "))
}

/// `Note`, or `Journal` with its date, or `None` when `data.db` says the item
/// is gone and the index has not caught up.
fn note_kind(data: &Connection, id: &str) -> Result<Option<HitKind>, StorageError> {
    if !is_live(data, "journal", id)? {
        return Ok(is_live(data, "note", id)?.then_some(HitKind::Note));
    }
    let date = data
        .query_row(
            "SELECT date FROM journal_entries WHERE id = ?1",
            params![id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(failed)?
        .flatten()
        .unwrap_or_default();
    Ok(Some(HitKind::Journal { date }))
}

fn is_live(data: &Connection, item_type: &str, item_id: &str) -> Result<bool, StorageError> {
    data.query_row(
        "SELECT 1 FROM sync_items
         WHERE item_type = ?1 AND item_id = ?2 AND deleted_at IS NULL",
        params![item_type, item_id],
        |_| Ok(()),
    )
    .optional()
    .map_err(failed)
    .map(|row| row.is_some())
}

/// One ranked page. Every row is collected through `?`: a row that will not
/// read stops the search rather than vanishing from the results.
fn scored(
    index: &Connection,
    sql: &str,
    expression: &str,
    limit: usize,
) -> Result<Vec<(String, String, f64)>, StorageError> {
    let mut statement = index.prepare(sql).map_err(failed)?;
    let rows = statement
        .query_map(params![expression, limit as i64], |row| {
            // The title is read null-tolerantly. Nothing this module inserts
            // writes a NULL there, but an index written by another build might,
            // and a NULL title is a hit with no label rather than a lost note.
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, f64>(2)?,
            ))
        })
        .map_err(failed)?;
    rows.map(|row| row.map_err(failed)).collect()
}

/// The one `rusqlite::Error` conversion both halves of this module use.
pub(super) fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_query_becomes_quoted_terms_joined_by_and() {
        assert_eq!(
            match_expression("protocol chapter").as_deref(),
            Some("\"protocol\" AND \"chapter\"")
        );
    }

    #[test]
    fn every_fts5_metacharacter_leaves_as_a_separator_or_not_at_all() {
        // An unbalanced quote, a bare star, a column filter, a negation, a
        // parenthesis and a caret: none of them can reach the parser.
        for hostile in [
            "he said \"hello",
            "*",
            "title:foo",
            "-bar",
            "(a OR b)",
            "^start",
            "a AND NOT b",
            "NEAR(a b, 2)",
            "\"\"\"",
        ] {
            let Some(expression) = match_expression(hostile) else {
                continue;
            };
            let terms = expression.split(" AND ").count();
            assert_eq!(
                expression.matches('"').count(),
                terms * 2,
                "{hostile} produced unbalanced quotes: {expression}"
            );
            for term in expression.split(" AND ") {
                let inner = term.trim_matches('"');
                assert!(
                    inner.chars().all(char::is_alphanumeric),
                    "{hostile} produced a term with syntax in it: {term}"
                );
            }
        }
    }

    #[test]
    fn an_operator_typed_as_a_word_is_searched_for_as_a_word() {
        assert_eq!(
            match_expression("a OR b").as_deref(),
            Some("\"a\" AND \"OR\" AND \"b\"")
        );
    }

    #[test]
    fn a_query_with_no_searchable_term_never_reaches_sql() {
        for empty in ["", "   ", "***", "--", "\"", "()"] {
            assert_eq!(match_expression(empty), None);
        }
    }

    #[test]
    fn the_weights_are_the_ones_the_chapter_names() {
        assert_eq!(NOTES_RANK, "bm25(fts_notes, 0.0, 2.0, 1.0, 1.0)");
        assert_eq!(TASKS_RANK, "bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0)");
    }
}
