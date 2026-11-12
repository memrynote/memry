//! Full-text search and the incremental index that feeds it (T131, FR-053,
//! data-model §A.5).
//!
//! Two databases, one direction. `data.db` is the source of record; `index.db`
//! holds `fts_notes`, `fts_tasks` and `fts_inbox` ([`inbox`]) and is **rebuildable by definition**
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
//! ## The query grammar
//!
//! [`query::parse`] turns the search box text into the `MATCH` expression:
//! prefix words, `"exact phrases"` and uppercase `AND` / `OR` / `NOT`, as
//! desktop does. It builds the expression from parsed tokens and never passes
//! user text through, so no input raises an FTS5 syntax error. A string with no
//! searchable term returns no hits without touching SQL. A plain multi-word
//! query on notes and journals also sorts the rows holding its words side by
//! side first, then by bm25.
//!
//! ## Typos and other names
//!
//! A type (notes, journals, tasks, inbox) with fewer than three hits also gets the
//! titles [`fuzzy`] matches, after its body hits and without a snippet, as
//! desktop's fallback adds them. Notes and journals then take their alias
//! matches ([`names`]). Each hit says which of the three found it.
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
//! core's only document-to-text operation; this module writes no second
//! extractor.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension as _, ToSql, params};

use crate::api::errors::StorageError;

mod body_cache;
mod fuzzy;
mod inbox;
mod links;
mod literal_links;
mod maintenance;
mod names;
mod query;
pub mod recents;
mod snippet;

pub(crate) use body_cache::body_version;
pub use inbox::{INBOX_RANK, INBOX_WATERMARK_KEY, search_inbox};
pub use maintenance::{
    DATA_VERSION_KEY, NOTES_WATERMARK_KEY, Reindexed, STAMPS_KEY, TASKS_WATERMARK_KEY, reindex,
};
pub use snippet::SnippetSegment;

/// The `fts_notes` ranking expression. Part of the contract (§A.5).
pub const NOTES_RANK: &str = "bm25(fts_notes, 0.0, 2.0, 1.0, 1.0)";
/// The `fts_tasks` ranking expression. Part of the contract (§A.5).
pub const TASKS_RANK: &str = "bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0)";

/// Desktop's `FUZZY_FALLBACK_THRESHOLD`: a type with fewer body hits than
/// this also gets fuzzy title matches.
const FUZZY_FALLBACK_BELOW: usize = 3;

/// What found a hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum MatchKind {
    /// The full-text index: the title, body or tags hold the query.
    Body,
    /// The fuzzy title fallback: the title holds the query's characters in
    /// order, as a typo does.
    Fuzzy,
    /// One of the note's or journal day's aliases is or starts with the query.
    Alias,
}

/// What a hit is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HitKind {
    /// The row metadata comes from the note's `notes` row in `data.db`, read
    /// in the same per-hit lookup that drops tombstones (#4323). An empty
    /// string reads as `None`.
    Note {
        emoji: Option<String>,
        folder_path: Option<String>,
    },
    /// Journals live in `fts_notes` beside notes and are told apart by the
    /// `date` on their `journal_entries` row (§A.5), which is the only place
    /// that date exists — `journal_entries` has no `title` column.
    Journal {
        date: String,
    },
    Task,
    /// An inbox capture in any state (#4320).
    Inbox,
}

/// One result, already ranked.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub kind: HitKind,
    /// The bm25 score. Negative; more negative is a better match. Zero for a
    /// fuzzy or alias hit, which bm25 did not rank.
    pub score: f64,
    /// The body window around the match (`content` for notes, journals and
    /// inbox captures, `description` for tasks), empty when that column is, and for a fuzzy
    /// or alias hit.
    pub snippet: Vec<SnippetSegment>,
    pub match_kind: MatchKind,
    /// The alias the query matched, when the hit's title does not hold it.
    pub matched_name: Option<String>,
}

/// Searches notes and journals.
///
/// `data` is consulted for every hit, so a tombstone applied since the last
/// [`reindex`] cannot surface: the index is allowed to be stale, the answer is
/// not. That can return fewer than `limit` hits, which is the correct trade.
/// `limit` holds per type, as desktop's groups hold it, so the list can carry
/// up to `limit` notes and `limit` journals.
pub fn search_notes(
    data: &Connection,
    index: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, StorageError> {
    let raw = query;
    let Some(query) = query::parse(raw) else {
        return Ok(Vec::new());
    };
    // Rows holding the words side by side first. This only reorders the
    // matching rows; which rows match is the expression's alone.
    let phrase_first = if query.phrase.is_some() {
        "id NOT IN (SELECT id FROM fts_notes WHERE fts_notes MATCH ?3),"
    } else {
        ""
    };
    let sql = format!(
        "SELECT id, title, {NOTES_RANK} AS score, {}
         FROM fts_notes WHERE fts_notes MATCH ?1 ORDER BY {phrase_first} score LIMIT ?2",
        snippet::snippet_sql("fts_notes", 2)
    );
    let mut hits = Vec::new();
    for (id, title, score, snippet) in scored(
        index,
        &sql,
        &query.expression,
        query.phrase.as_deref(),
        limit,
    )? {
        let Some(kind) = note_kind(data, &id)? else {
            continue;
        };
        hits.push(SearchHit {
            id,
            title,
            kind,
            score,
            snippet,
            match_kind: MatchKind::Body,
            matched_name: None,
        });
    }
    let is_note = |kind: &HitKind| matches!(kind, HitKind::Note { .. });
    let is_journal = |kind: &HitKind| matches!(kind, HitKind::Journal { .. });
    let short = |is_type: &dyn Fn(&HitKind) -> bool| {
        hits.iter().filter(|hit| is_type(&hit.kind)).count() < FUZZY_FALLBACK_BELOW
    };
    let (notes_short, journals_short) = (short(&is_note), short(&is_journal));
    if notes_short || journals_short {
        let journals = live_ids(data, "journal")?;
        let notes = live_ids(data, "note")?;
        let (journal_titles, note_titles): (Vec<_>, Vec<_>) = titles(index, "fts_notes")?
            .into_iter()
            .partition(|(id, _)| journals.contains(id));
        let note_titles: Vec<_> = note_titles
            .into_iter()
            .filter(|(id, _)| notes.contains(id))
            .collect();
        let kind = |id: &str| note_kind(data, id);
        if notes_short {
            append_fuzzy(&mut hits, raw, limit, &note_titles, &is_note, &kind)?;
        }
        if journals_short {
            append_fuzzy(&mut hits, raw, limit, &journal_titles, &is_journal, &kind)?;
        }
    }
    names::merge_aliases(data, index, raw, hits, limit)
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
    let raw = query;
    let Some(query) = query::parse(raw) else {
        return Ok(Vec::new());
    };
    let sql = format!(
        "SELECT id, title, {TASKS_RANK} AS score, {}
         FROM fts_tasks WHERE fts_tasks MATCH ?1 ORDER BY score LIMIT ?2",
        snippet::snippet_sql("fts_tasks", 2)
    );
    let mut hits = Vec::new();
    for (id, title, score, snippet) in scored(index, &sql, &query.expression, None, limit)? {
        if !is_live(data, "task", &id)? {
            continue;
        }
        hits.push(SearchHit {
            id,
            title,
            kind: HitKind::Task,
            score,
            snippet,
            match_kind: MatchKind::Body,
            matched_name: None,
        });
    }
    if hits.len() < FUZZY_FALLBACK_BELOW {
        let tasks = live_ids(data, "task")?;
        let candidates: Vec<_> = titles(index, "fts_tasks")?
            .into_iter()
            .filter(|(id, _)| tasks.contains(id))
            .collect();
        append_fuzzy(&mut hits, raw, limit, &candidates, &|_| true, &|_| {
            Ok(Some(HitKind::Task))
        })?;
    }
    Ok(hits)
}

/// Desktop's fuzzy fallback for one type: the best `limit` title matches over
/// `candidates`, less the hits already listed, appended until the type holds
/// `limit`.
fn append_fuzzy(
    hits: &mut Vec<SearchHit>,
    query: &str,
    limit: usize,
    candidates: &[(String, String)],
    is_type: &dyn Fn(&HitKind) -> bool,
    kind: &dyn Fn(&str) -> Result<Option<HitKind>, StorageError>,
) -> Result<(), StorageError> {
    let mut room = limit.saturating_sub(hits.iter().filter(|hit| is_type(&hit.kind)).count());
    let ranked = fuzzy::rank(
        query,
        candidates.iter().map(|(_, title)| title.as_str()),
        limit,
    );
    for (at, _) in ranked {
        let (id, title) = &candidates[at];
        if room == 0 {
            break;
        }
        if hits.iter().any(|hit| &hit.id == id) {
            continue;
        }
        let Some(kind) = kind(id)? else {
            continue;
        };
        hits.push(SearchHit {
            id: id.clone(),
            title: title.clone(),
            kind,
            score: 0.0,
            snippet: Vec::new(),
            match_kind: MatchKind::Fuzzy,
            matched_name: None,
        });
        room -= 1;
    }
    Ok(())
}

/// Every id and title in one FTS table.
fn titles(index: &Connection, table: &str) -> Result<Vec<(String, String)>, StorageError> {
    let mut statement = index
        .prepare(&format!("SELECT id, title FROM {table}"))
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })
        .map_err(failed)?;
    rows.map(|row| row.map_err(failed)).collect()
}

/// The ids of one type `data.db` holds live.
fn live_ids(data: &Connection, item_type: &str) -> Result<HashSet<String>, StorageError> {
    let mut statement = data
        .prepare("SELECT item_id FROM sync_items WHERE item_type = ?1 AND deleted_at IS NULL")
        .map_err(failed)?;
    let rows = statement
        .query_map(params![item_type], |row| row.get::<_, String>(0))
        .map_err(failed)?;
    rows.map(|row| row.map_err(failed)).collect()
}

/// `Note` with its emoji and folder, or `Journal` with its date, or `None`
/// when `data.db` says the item is gone and the index has not caught up.
fn note_kind(data: &Connection, id: &str) -> Result<Option<HitKind>, StorageError> {
    if !is_live(data, "journal", id)? {
        if !is_live(data, "note", id)? {
            return Ok(None);
        }
        let (emoji, folder_path) = data
            .query_row(
                "SELECT emoji, folder_path FROM notes WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(failed)?
            .unwrap_or_default();
        let present = |value: Option<String>| value.filter(|value| !value.is_empty());
        return Ok(Some(HitKind::Note {
            emoji: present(emoji),
            folder_path: present(folder_path),
        }));
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

/// One ranked row: id, title, bm25 score, snippet.
type Scored = (String, String, f64, Vec<SnippetSegment>);

/// One ranked page. `?1` is the expression, `?2` the limit and `?3`, when
/// given, the phrase. Every row is collected through `?`: a row that
/// will not read stops the search rather than vanishing from the results.
fn scored(
    index: &Connection,
    sql: &str,
    expression: &str,
    phrase: Option<&str>,
    limit: usize,
) -> Result<Vec<Scored>, StorageError> {
    let mut statement = index.prepare(sql).map_err(failed)?;
    let limit = limit as i64;
    let mut parameters: Vec<&dyn ToSql> = vec![&expression, &limit];
    if let Some(phrase) = &phrase {
        parameters.push(phrase);
    }
    let rows = statement
        .query_map(parameters.as_slice(), |row| {
            // The title is read null-tolerantly. Nothing this module inserts
            // writes a NULL there, but an index written by another build might,
            // and a NULL title is a hit with no label rather than a lost note.
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, f64>(2)?,
                snippet::segments(&row.get::<_, Option<String>>(3)?.unwrap_or_default()),
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
    fn the_weights_are_the_ones_the_chapter_names() {
        assert_eq!(NOTES_RANK, "bm25(fts_notes, 0.0, 2.0, 1.0, 1.0)");
        assert_eq!(TASKS_RANK, "bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0)");
        assert_eq!(INBOX_RANK, "bm25(fts_inbox, 0.0, 3.0, 1.0, 1.0, 0.5)");
    }
}
