//! Turning [`super::super::search`]'s hits and the semantic leg's ids into desktop's
//! result items: metadata from `data.db` and `index.db`, and the scores.

use rusqlite::{Connection, OptionalExtension as _, params};

use crate::api::errors::StorageError;
use crate::domain::notes::names::name_key;

use super::super::maintenance::journal_title;
use super::super::{HitKind, MatchKind, SearchHit, SearchType, failed, fuzzy, is_live, note_kind};
use super::scope::scope;
use super::semantic::{QUERY_SIMILARITY_FLOOR, SemanticHit};
use super::{GroupedItem, GroupedQuery, ItemMeta, MatchType};

/// `search-note-names.ts:24-25`: an alias equal to the query, and one it starts.
const ALIAS_EXACT_SCORE: f64 = 1.0;
const ALIAS_PREFIX_SCORE: f64 = 0.9;
/// `lib/fuzzysort-search.ts:37`.
const FUZZY_WEIGHT: f64 = 0.8;
/// `search-semantic-merge.ts:30`: semantic-only items stay in the lower half.
const SEMANTIC_ONLY_MAX_SCORE: f64 = 0.5;

/// What the metadata lookup reads for one item.
struct Loaded {
    /// From `data.db`; `None` for a journal day, whose title only its payload holds.
    title: Option<String>,
    modified_at: Option<i64>,
    meta: ItemMeta,
}

/// An item and what found it.
pub(super) type Found = (MatchKind, GroupedItem);

/// `kind`'s hits as items, in their order. Index hits get `normalized_score` 0;
/// [`normalize`] sets it once the group is cut.
pub(super) fn from_hits(
    data: &Connection,
    index: &Connection,
    text: &str,
    kind: SearchType,
    hits: &[SearchHit],
) -> Result<Vec<Found>, StorageError> {
    let mut items = Vec::with_capacity(hits.len());
    for hit in hits {
        let journal_date = match &hit.kind {
            HitKind::Journal { date } => Some(date.as_str()),
            _ => None,
        };
        let mut loaded = load(data, index, kind, &hit.id, journal_date)?;
        if let ItemMeta::Note { matched_name, .. } | ItemMeta::Journal { matched_name, .. } =
            &mut loaded.meta
        {
            matched_name.clone_from(&hit.matched_name);
        }
        let (score, normalized_score, match_type) = match hit.match_kind {
            MatchKind::Body => (-hit.score, 0.0, MatchType::Exact),
            MatchKind::Fuzzy => {
                let score = fuzzy::rank(text, [hit.title.as_str()], 1)
                    .first()
                    .map_or(0.0, |(_, score)| *score);
                (score, score * FUZZY_WEIGHT, MatchType::Fuzzy)
            }
            MatchKind::Alias => {
                let name = hit.matched_name.as_deref().unwrap_or(&hit.title);
                let exact = name_key(name).is_some() && name_key(name) == name_key(text);
                let score = if exact {
                    ALIAS_EXACT_SCORE
                } else {
                    ALIAS_PREFIX_SCORE
                };
                (score, score, MatchType::Exact)
            }
            // main's fused leg (#4505); the grouped search runs its own semantic leg below, so
            // a hit of this kind ranks as that leg's semantic-only items do.
            MatchKind::Semantic => (
                hit.score,
                closeness(hit.score) * SEMANTIC_ONLY_MAX_SCORE,
                MatchType::Fuzzy,
            ),
        };
        let item = GroupedItem {
            id: hit.id.clone(),
            kind,
            title: hit.title.clone(),
            snippet: hit.snippet.clone(),
            score,
            normalized_score,
            match_type,
            modified_at: loaded.modified_at,
            meta: loaded.meta,
        };
        items.push((hit.match_kind, item));
    }
    Ok(items)
}

/// Markdown notes ahead of filed files among the index hits, each side in bm25
/// order (`search.ts:129-131`). Fuzzy and alias hits keep their places.
pub(super) fn markdown_first(items: &mut [Found]) {
    let slots: Vec<usize> = (0..items.len())
        .filter(|at| items[*at].0 == MatchKind::Body)
        .collect();
    let mut ordered: Vec<Found> = slots.iter().map(|at| items[*at].clone()).collect();
    ordered.sort_by_key(|(_, item)| !is_markdown(item));
    for (at, item) in slots.into_iter().zip(ordered) {
        items[at] = item;
    }
}

/// How many index hits are sure to lead the group: all of them, or the markdown
/// ones only while `markdown_leads`.
pub(super) fn leading(found: &[Found], markdown_leads: bool) -> usize {
    found
        .iter()
        .filter(|(from, item)| *from == MatchKind::Body && (!markdown_leads || is_markdown(item)))
        .count()
}

fn is_markdown(item: &GroupedItem) -> bool {
    matches!(&item.meta, ItemMeta::Note { file_type, .. } if file_type == "markdown")
}

/// `normalizeScores` over the index hits (`lib/search-utils.ts:11-27`): min-max to
/// 0..1, all 1 when they tie.
pub(super) fn normalize(items: &mut [Found]) {
    let scores = items
        .iter()
        .filter(|(from, _)| *from == MatchKind::Body)
        .map(|(_, item)| item.score);
    let (min, max) = scores.fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), score| {
        (min.min(score), max.max(score))
    });
    let range = max - min;
    for (_, item) in items
        .iter_mut()
        .filter(|(from, _)| *from == MatchKind::Body)
    {
        item.normalized_score = if range == 0.0 {
            1.0
        } else {
            (item.score - min) / range
        };
    }
}

/// The items `hits` name that `data.db` holds live and the query keeps, per type,
/// best first (`loadSemanticItems` and `loadInboxItems`,
/// `search-semantic-merge.ts:56-147`). Every filter applies
/// (`search.ts:648-654`). Tasks have no vectors. Titles come from `data.db`.
pub(super) fn semantic_items(
    data: &Connection,
    index: &Connection,
    query: &GroupedQuery,
    hits: &[SemanticHit],
) -> Result<Vec<(SearchType, Vec<GroupedItem>)>, StorageError> {
    let mut by_type: Vec<(SearchType, Vec<GroupedItem>)> = Vec::new();
    for kind in [SearchType::Note, SearchType::Journal, SearchType::Inbox] {
        let kept = query.filter.kept(data, kind)?;
        let scope = scope(data, query, kind)?;
        let mut items = Vec::new();
        for hit in hits {
            if kept.as_ref().is_some_and(|kept| !kept.contains(&hit.id)) || !scope.keeps(&hit.id) {
                continue;
            }
            let journal_date = match kind {
                SearchType::Note | SearchType::Journal => match note_kind(data, &hit.id)? {
                    Some(HitKind::Journal { date }) if kind == SearchType::Journal => Some(date),
                    Some(HitKind::Note { .. }) if kind == SearchType::Note => None,
                    _ => continue,
                },
                SearchType::Inbox if is_live(data, "inbox", &hit.id)? => None,
                _ => continue,
            };
            let loaded = load(data, index, kind, &hit.id, journal_date.as_deref())?;
            let title = match &loaded.meta {
                ItemMeta::Journal { date, .. } => {
                    journal_title(data, &hit.id)?.unwrap_or_else(|| date.clone())
                }
                _ => loaded.title.unwrap_or_default(),
            };
            items.push(GroupedItem {
                id: hit.id.clone(),
                kind,
                title,
                snippet: Vec::new(),
                score: hit.cosine,
                normalized_score: closeness(hit.cosine) * SEMANTIC_ONLY_MAX_SCORE,
                match_type: MatchType::Fuzzy,
                modified_at: loaded.modified_at,
                meta: loaded.meta,
            });
        }
        items.sort_by(|a, b| b.score.total_cmp(&a.score));
        by_type.push((kind, items));
    }
    Ok(by_type)
}

/// How far above the query floor a cosine sits, 0..1 (`search-semantic-merge.ts:94-98`).
fn closeness(cosine: f64) -> f64 {
    ((cosine - QUERY_SIMILARITY_FLOOR) / (1.0 - QUERY_SIMILARITY_FLOOR)).clamp(0.0, 1.0)
}

/// One item's `data.db` title, modified time and metadata. A row the projection
/// lacks reads as empty fields, never as a lost result. An index hit keeps the
/// index's title and drops this one.
fn load(
    data: &Connection,
    index: &Connection,
    kind: SearchType,
    id: &str,
    journal_date: Option<&str>,
) -> Result<Loaded, StorageError> {
    match kind {
        SearchType::Note => {
            let row = data
                .query_row(
                    "SELECT n.title, n.emoji, n.file_type, n.created_at, n.modified_at, f.path
                     FROM notes n LEFT JOIN note_files f ON f.note_id = n.id WHERE n.id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<i64>>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                            row.get::<_, Option<String>>(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(failed)?
                .unwrap_or_default();
            let (title, emoji, file_type, created_at, modified_at, path) = row;
            Ok(Loaded {
                title,
                modified_at,
                meta: ItemMeta::Note {
                    path,
                    emoji: emoji.filter(|emoji| !emoji.is_empty()),
                    file_type: file_type.unwrap_or_else(|| "markdown".to_owned()),
                    word_count: word_count(index, id)?,
                    created_at,
                    matched_name: None,
                },
            })
        }
        SearchType::Journal => {
            let (modified_at, path) = data
                .query_row(
                    "SELECT j.modified_at, f.path
                     FROM journal_entries j LEFT JOIN note_files f ON f.note_id = j.id
                     WHERE j.id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get::<_, Option<i64>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()
                .map_err(failed)?
                .unwrap_or_default();
            Ok(Loaded {
                title: None,
                modified_at,
                meta: ItemMeta::Journal {
                    date: journal_date.unwrap_or_default().to_owned(),
                    path,
                    word_count: word_count(index, id)?,
                    matched_name: None,
                },
            })
        }
        SearchType::Task => task(data, id),
        SearchType::Inbox => {
            let row = data
                .query_row(
                    "SELECT title, type, source_url, source_title, filed_at, modified_at
                     FROM inbox_items WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<i64>>(4)?,
                            row.get::<_, Option<i64>>(5)?,
                        ))
                    },
                )
                .optional()
                .map_err(failed)?
                .unwrap_or_default();
            let (title, item_type, source_url, source_title, filed_at, modified_at) = row;
            Ok(Loaded {
                title,
                modified_at,
                meta: ItemMeta::Inbox {
                    item_type: item_type.unwrap_or_else(|| "note".to_owned()),
                    source_url,
                    source_title,
                    filed_at,
                },
            })
        }
    }
}

fn task(data: &Connection, id: &str) -> Result<Loaded, StorageError> {
    data.query_row(
        "SELECT t.title, t.modified_at, t.project_id, p.name, p.color, t.status_id, s.name,
                t.due_date, t.priority, t.completed_at, t.created_at
         FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id
         LEFT JOIN project_statuses s ON s.id = t.status_id
         WHERE t.id = ?1",
        params![id],
        |row| {
            Ok(Loaded {
                title: row.get(0)?,
                modified_at: row.get(1)?,
                meta: ItemMeta::Task {
                    project_id: row.get(2)?,
                    project_name: row.get(3)?,
                    project_color: row.get(4)?,
                    status_id: row.get(5)?,
                    status_name: row.get(6)?,
                    due_date: row.get(7)?,
                    priority: row.get(8)?,
                    completed_at: row.get(9)?,
                    created_at: row.get(10)?,
                },
            })
        },
    )
    .optional()
    .map_err(failed)
    .map(|loaded| {
        loaded.unwrap_or(Loaded {
            title: None,
            modified_at: None,
            meta: ItemMeta::Task {
                project_id: String::new(),
                project_name: None,
                project_color: None,
                status_id: None,
                status_name: None,
                due_date: None,
                priority: 0,
                completed_at: None,
                created_at: None,
            },
        })
    })
}

fn word_count(index: &Connection, id: &str) -> Result<Option<i64>, StorageError> {
    index
        .query_row(
            "SELECT word_count FROM note_stats WHERE note_id = ?1",
            params![id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(failed)
}
