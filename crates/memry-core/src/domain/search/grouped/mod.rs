//! Desktop's grouped search answer (`searchAll`, `quickSearch` and
//! `getSearchStats` in `apps/desktop/src/main/database/queries/search.ts:553-737`),
//! built on [`super::search`]: the same groups, each item carrying the
//! metadata, normalised score and match type `packages/contracts/src/search-api.ts`
//! names, then the semantic hits fused in by Reciprocal Rank Fusion ([`fuse`]).
//!
//! [`super::search`] owns which items match and their order. This adds what the
//! desktop result list needs on top: the project, folder and note file type
//! filters (`applyPostFilters`, `search.ts:477-507`, and `noteFileTypeFilter`,
//! `search.ts:93-101`), markdown notes ahead of filed files (`search.ts:131`), the
//! scores (`normalizeScores`, `lib/search-utils.ts:11-27`; fuzzy `score * 0.8`,
//! `lib/fuzzysort-search.ts:37`; alias 1 or 0.9, `search-note-names.ts:24-25`), and
//! the semantic leg.
//!
//! Three choices differ from desktop on purpose. The project and folder filters
//! apply whenever they are set: desktop runs them only beside a tag or date filter
//! (`search.ts:614`), so a lone folder filter narrows nothing there. Every filter
//! applies before the group is cut to the limit, over a fetch five times the limit,
//! as desktop does for tags and dates (`search.ts:584`); the file type filter
//! therefore runs after the index query, not inside it (`search.ts:124`), and the
//! over-fetch keeps markdown notes from being starved. A fuzzy hit carries no
//! snippet, as [`super::search`] decides; desktop shows the highlighted title.

use std::collections::HashSet;

use rusqlite::Connection;

use crate::api::errors::StorageError;

use super::{SearchFilter, SearchType, SnippetSegment, failed};

mod fuse;
mod items;
pub mod semantic;

pub use semantic::SemanticHit;

/// Desktop's `quickSearch` per-group limit (`search.ts:672`).
const QUICK_GROUP_LIMIT: usize = 5;
/// Desktop's `quickSearch` result cap (`search.ts:681`).
const QUICK_LIMIT: usize = 20;

/// One search, as desktop's `SearchQuery` (`search-api.ts:116-133`). The date
/// range and tags ride in `filter`, in core's terms ([`SearchFilter`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GroupedQuery {
    pub text: String,
    /// Types, modified range and tags. Empty types search every type.
    pub filter: SearchFilter,
    /// Keeps only tasks of this project.
    pub project_id: Option<String>,
    /// Keeps only notes and journal days whose vault path starts with this.
    pub folder_path: Option<String>,
    /// Keeps only notes of these file types (`markdown`, `pdf`, `image`, `audio`,
    /// `video`); empty keeps every type. Journal days are always markdown.
    pub note_file_types: Vec<String>,
    /// At most this many items per group.
    pub limit: usize,
}

/// How an item was found (`MatchType`, `search-api.ts:23`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchType {
    /// The full-text index or an alias.
    Exact,
    Prefix,
    /// The fuzzy title fallback, or the semantic leg alone.
    Fuzzy,
}

/// Per-type metadata (`search-api.ts:37-85`). Instants are epoch milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub enum ItemMeta {
    Note {
        /// The vault-relative path, `None` for a note this device holds no file of.
        path: Option<String>,
        emoji: Option<String>,
        /// `markdown` when the row has none.
        file_type: String,
        word_count: Option<i64>,
        created_at: Option<i64>,
        matched_name: Option<String>,
    },
    Journal {
        date: String,
        path: Option<String>,
        word_count: Option<i64>,
        matched_name: Option<String>,
    },
    Task {
        project_id: String,
        project_name: Option<String>,
        project_color: Option<String>,
        status_id: Option<String>,
        status_name: Option<String>,
        due_date: Option<String>,
        priority: i64,
        completed_at: Option<String>,
        created_at: Option<i64>,
    },
    Inbox {
        item_type: String,
        source_url: Option<String>,
        source_title: Option<String>,
        filed_at: Option<i64>,
    },
}

/// One result (`SearchResultItem`, `search-api.ts:97-107`).
#[derive(Debug, Clone, PartialEq)]
pub struct GroupedItem {
    pub id: String,
    pub kind: SearchType,
    pub title: String,
    /// Empty for a fuzzy, alias or semantic-only hit.
    pub snippet: Vec<SnippetSegment>,
    /// Higher is better: `|bm25|` for an index hit, the fuzzy score, the alias
    /// score, or the cosine of a semantic-only hit. Comparable within a group only.
    pub score: f64,
    /// 0..1, comparable across groups (quick search sorts on it).
    pub normalized_score: f64,
    pub match_type: MatchType,
    pub modified_at: Option<i64>,
    pub meta: ItemMeta,
}

/// One group (`SearchResultGroup`); `totalInGroup` is `results.len()`.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub kind: SearchType,
    pub results: Vec<GroupedItem>,
}

/// `SearchResponse` without the timing, which the shell measures.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GroupedResponse {
    /// Non-empty groups, in the order of the query's types (every type: notes,
    /// journals, tasks, inbox).
    pub groups: Vec<Group>,
    pub total_count: usize,
}

/// `SearchStats` without `lastIndexedAt`, which desktop always reports as null.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GroupedStats {
    pub notes: u64,
    pub journals: u64,
    pub tasks: u64,
    pub inbox_items: u64,
}

impl GroupedStats {
    pub fn total(&self) -> u64 {
        self.notes + self.journals + self.tasks + self.inbox_items
    }
}

/// Desktop's `searchAll`: the four groups, filtered and scored, with `semantic`
/// (best first, from [`semantic::note_hits`]) fused into notes, journals and inbox.
/// Empty `semantic` answers from the index alone.
pub fn search_all(
    data: &Connection,
    index: &Connection,
    query: &GroupedQuery,
    semantic: &[SemanticHit],
) -> Result<GroupedResponse, StorageError> {
    let active = active_types(&query.filter);
    let mut groups = Vec::new();
    for kind in &active {
        let results = group(data, index, query, *kind)?;
        if !results.is_empty() {
            groups.push(Group {
                kind: *kind,
                results,
            });
        }
    }
    if !semantic.is_empty() {
        let candidates = items::semantic_items(data, index, query, semantic)?;
        fuse::fuse(&mut groups, candidates, &active, query.limit);
    }
    let total_count = groups.iter().map(|group| group.results.len()).sum();
    Ok(GroupedResponse {
        groups,
        total_count,
    })
}

/// One group, filtered, ordered and cut to the limit.
///
/// Desktop filters note file types and puts markdown first inside its query, so
/// its limit counts the notes it keeps (`search.ts:120-133`). [`super::search`]
/// does neither, so this asks it for more until the group is settled: the index
/// ran out of hits, or enough kept hits lead (for notes, enough kept markdown hits,
/// since a later markdown hit would go ahead of a filed file). The first ask is the
/// limit, five times it when a filter is on (`search.ts:584`), and each next ask is
/// twice the last; a vault whose notes are all markdown settles on the first.
fn group(
    data: &Connection,
    index: &Connection,
    query: &GroupedQuery,
    kind: SearchType,
) -> Result<Vec<GroupedItem>, StorageError> {
    let narrowed = query.project_id.is_some()
        || query.folder_path.is_some()
        || !query.note_file_types.is_empty();
    let filter = SearchFilter {
        types: vec![kind],
        ..query.filter.clone()
    };
    let mut fetch = if narrowed {
        query.limit * 5
    } else {
        query.limit
    };
    loop {
        let found = super::search(data, index, &query.text, &filter, fetch)?;
        let hits = match kind {
            SearchType::Note => found.notes,
            SearchType::Journal => found.journals,
            SearchType::Task => found.tasks,
            SearchType::Inbox => found.inbox,
        };
        let exhausted = hits
            .iter()
            .filter(|hit| hit.match_kind == super::MatchKind::Body)
            .count()
            < fetch;
        let mut found = items::from_hits(data, index, &query.text, kind, &hits)?;
        found.retain(|(_, item)| items::passes(query, item));
        if exhausted || items::leading(&found, kind) >= query.limit {
            if kind == SearchType::Note {
                items::markdown_first(&mut found);
            }
            found.truncate(query.limit);
            items::normalize(&mut found);
            return Ok(found.into_iter().map(|(_, item)| item).collect());
        }
        fetch = fetch.max(1) * 2;
    }
}

/// Desktop's `quickSearch`: five per group, every group, then the best twenty by
/// normalised score (`search.ts:661-685`).
pub fn quick_search(
    data: &Connection,
    index: &Connection,
    text: &str,
    note_file_types: &[String],
    semantic: &[SemanticHit],
) -> Result<Vec<GroupedItem>, StorageError> {
    let query = GroupedQuery {
        text: text.to_owned(),
        note_file_types: note_file_types.to_vec(),
        limit: QUICK_GROUP_LIMIT,
        ..GroupedQuery::default()
    };
    let mut results: Vec<GroupedItem> = search_all(data, index, &query, semantic)?
        .groups
        .into_iter()
        .flat_map(|group| group.results)
        .collect();
    results.sort_by(|a, b| b.normalized_score.total_cmp(&a.normalized_score));
    results.truncate(QUICK_LIMIT);
    Ok(results)
}

/// Desktop's `getSearchStats` (`search.ts:687-737`) over the live rows of `data.db`.
pub fn stats(data: &Connection) -> Result<GroupedStats, StorageError> {
    let count = |table: &str| -> Result<u64, StorageError> {
        data.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE deleted_at IS NULL"),
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as u64)
        .map_err(failed)
    };
    Ok(GroupedStats {
        notes: count("notes")?,
        journals: count("journal_entries")?,
        tasks: count("tasks")?,
        inbox_items: count("inbox_items")?,
    })
}

/// The query's types in desktop's order, every type when it names none
/// (`search.ts:580-581`).
fn active_types(filter: &SearchFilter) -> Vec<SearchType> {
    if filter.types.is_empty() {
        return SearchType::ALL.to_vec();
    }
    let mut seen = HashSet::new();
    filter
        .types
        .iter()
        .copied()
        .filter(|kind| seen.insert(*kind))
        .collect()
}

#[cfg(test)]
mod tests;
