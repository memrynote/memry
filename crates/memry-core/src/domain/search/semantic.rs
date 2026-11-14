//! The semantic leg of search (#4505) and its fusion with the FTS groups, as
//! desktop does it in `search/semantic.ts` and `search-semantic-merge.ts`.
//!
//! A note is as near as its nearest window. Desktop reads the 30 nearest head
//! vectors (`vec_notes`) and the 30 nearest later chunks (`vec_note_chunks`)
//! before collapsing to one hit per note, so a note with many near chunks
//! cannot crowd the others out; window 0 here is desktop's head vector.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension as _, params};

use super::{Groups, MatchKind, SearchFilter, SearchHit, SearchType, failed, hit_kind, query};
use crate::api::errors::StorageError;
use crate::domain::journal_rules::js_trim;
use crate::semantic::Vector;
use crate::storage::vector_db::VectorBytes;

/// UTF-16 units of the query, trimmed as JavaScript's `trim` does.
pub const MIN_QUERY_LENGTH: usize = 3;
/// Per window class, before collapsing to one hit per note.
pub const NEIGHBOURS: usize = 30;
/// Desktop's `EMBEDDING_QUERY_SIMILARITY_FLOOR`.
pub const QUERY_FLOOR: f32 = 0.65;
/// Cormack et al. 2009: ranks are fused, never scores.
const RRF_K: f64 = 60.0;

/// Whether `query` takes the semantic leg at all: three units or more, a
/// searchable term, and no operator. `AND`, `OR`, `NOT` and a quoted phrase
/// ask for literal matches, not meaning.
pub fn wants_semantic(query: &str) -> bool {
    let trimmed = js_trim(query);
    trimmed.encode_utf16().count() >= MIN_QUERY_LENGTH
        && query::parse(trimmed).is_some()
        && !has_operators(trimmed)
}

/// Desktop's `/\b(AND|OR|NOT)\b/` and `/"[^"]+"/`.
fn has_operators(query: &str) -> bool {
    let operator = query
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|word| matches!(word, "AND" | "OR" | "NOT"));
    let segments: Vec<&str> = query.split('"').collect();
    let phrase = segments.len() > 2
        && segments[1..segments.len() - 1]
            .iter()
            .any(|inside| !inside.is_empty());
    operator || phrase
}

#[derive(Debug, Clone, PartialEq)]
pub struct SemanticHit {
    pub note_id: String,
    pub cosine: f32,
}

/// The notes nearest `query`, best first, at most [`NEIGHBOURS`], each at or
/// above [`QUERY_FLOOR`] by its best window. `rows` is every stored window as
/// `(note_id, window, embedding)`. A row that does not decode fails the leg,
/// and search answers from FTS alone.
pub fn nearest(
    query: &Vector,
    rows: Vec<(String, u32, VectorBytes)>,
) -> Result<Vec<SemanticHit>, StorageError> {
    let (mut heads, mut chunks) = (Vec::new(), Vec::new());
    for (note_id, window, bytes) in rows {
        let vector = Vector::from_le_bytes(&bytes).ok_or_else(|| StorageError::Failed {
            what: format!("vectors.db holds an unreadable vector for {note_id}"),
        })?;
        let class = if window == 0 { &mut heads } else { &mut chunks };
        class.push(SemanticHit {
            note_id,
            cosine: query.dot(&vector),
        });
    }
    let mut best: HashMap<String, f32> = HashMap::new();
    for class in [&mut heads, &mut chunks] {
        class.sort_unstable_by(|a, b| b.cosine.total_cmp(&a.cosine));
        for hit in class.drain(..).take(NEIGHBOURS) {
            let cosine = best.entry(hit.note_id).or_insert(hit.cosine);
            *cosine = cosine.max(hit.cosine);
        }
    }
    let mut hits: Vec<SemanticHit> = best
        .into_iter()
        .filter(|(_, cosine)| *cosine >= QUERY_FLOOR)
        .map(|(note_id, cosine)| SemanticHit { note_id, cosine })
        .collect();
    hits.sort_by(|a, b| {
        b.cosine
            .total_cmp(&a.cosine)
            .then_with(|| a.note_id.cmp(&b.note_id))
    });
    hits.truncate(NEIGHBOURS);
    Ok(hits)
}

/// Fuses `hits` into the notes and journals groups by Reciprocal Rank Fusion.
/// An item both legs found keeps its FTS row and sums both terms. An item only
/// the vectors found joins as [`MatchKind::Semantic`] with an empty snippet and
/// its cosine as the score, if `data.db` holds it live and the filter keeps it.
/// Ties keep FTS order, then semantic order. Tasks and inbox pass through.
pub fn fuse(
    data: &Connection,
    index: &Connection,
    groups: &mut Groups,
    hits: &[SemanticHit],
    filter: &SearchFilter,
    limit: usize,
) -> Result<(), StorageError> {
    if hits.is_empty() {
        return Ok(());
    }
    for kind in [SearchType::Note, SearchType::Journal] {
        if !filter.wants(kind) {
            continue;
        }
        let group = match kind {
            SearchType::Journal => &mut groups.journals,
            _ => &mut groups.notes,
        };
        let kept = filter.kept(data, kind)?;
        let mut ranked = Vec::new();
        for hit in hits {
            if kept
                .as_ref()
                .is_some_and(|kept| !kept.contains(&hit.note_id))
            {
                continue;
            }
            if group.iter().any(|listed| listed.id == hit.note_id) {
                ranked.push(Ranked::Listed(&hit.note_id));
            } else if let Some(row) = semantic_row(data, index, kind, hit)? {
                ranked.push(Ranked::New(row));
            }
        }
        *group = rrf(std::mem::take(group), ranked, limit);
    }
    Ok(())
}

enum Ranked<'a> {
    Listed(&'a str),
    New(SearchHit),
}

fn rrf(fts: Vec<SearchHit>, semantic: Vec<Ranked<'_>>, limit: usize) -> Vec<SearchHit> {
    if semantic.is_empty() {
        return fts;
    }
    let term = |rank: usize| 1.0 / (RRF_K + rank as f64 + 1.0);
    let mut fused: Vec<(SearchHit, f64)> = fts
        .into_iter()
        .enumerate()
        .map(|(rank, hit)| (hit, term(rank)))
        .collect();
    for (rank, ranked) in semantic.into_iter().enumerate() {
        match ranked {
            Ranked::Listed(id) => {
                if let Some((_, score)) = fused.iter_mut().find(|(hit, _)| hit.id == id) {
                    *score += term(rank);
                }
            }
            Ranked::New(hit) => fused.push((hit, term(rank))),
        }
    }
    fused.sort_by(|a, b| b.1.total_cmp(&a.1));
    fused.truncate(limit);
    fused.into_iter().map(|(hit, _)| hit).collect()
}

/// The row for a hit FTS did not list, titled from the index like an alias
/// hit. `None` when `data.db` no longer holds it live as a `kind`, or the index
/// has not caught up with it yet.
fn semantic_row(
    data: &Connection,
    index: &Connection,
    kind: SearchType,
    hit: &SemanticHit,
) -> Result<Option<SearchHit>, StorageError> {
    let Some(kind) = hit_kind(data, kind, &hit.note_id)? else {
        return Ok(None);
    };
    let title: Option<Option<String>> = index
        .query_row(
            "SELECT title FROM fts_notes WHERE id = ?1",
            params![&hit.note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(failed)?;
    Ok(title.map(|title| SearchHit {
        id: hit.note_id.clone(),
        title: title.unwrap_or_default(),
        kind,
        score: f64::from(hit.cosine),
        snippet: Vec::new(),
        match_kind: MatchKind::Semantic,
        matched_name: None,
    }))
}

#[cfg(test)]
#[path = "semantic_tests.rs"]
mod tests;
