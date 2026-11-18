//! Filing suggestions for a capture (spec 006, parity rows inv04#29 and
//! inv05#65): a port of Electron's `getSuggestions`
//! (`apps/desktop/src/main/inbox/suggestions.ts:699-818`) and its pure folder
//! scorer (`folder-scoring.ts`).
//!
//! The core never runs the model or reads `index.db`. The caller passes the
//! KNN neighbours of the capture's text, already resolved to notes, plus the
//! index's note folders and the notes that carry one of the capture's tags
//! ([`SuggestIndex`]). This module reads the rest from `data.db`: the capture,
//! its tags and the filing patterns, which come from filed captures (Electron's
//! `filing_history` table is not recreated).

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::embedding_input::{EmbeddingTask, build_embedding_input};
use crate::domain::notes::failed;
use crate::domain::similarity::calibrate_similarity;
use crate::domain::tags;

use super::InboxItem;

/// Only a folder's best few hits count, so volume alone cannot win.
const SUPPORT_CAP: usize = 3;
/// A folder backed by a single note is discounted; corroboration removes it.
const LONE_HIT_PENALTY: f64 = 0.3;
/// Per-level discount when a hit rolls up to an ancestor folder.
const ANCESTOR_DECAY: f64 = 0.8;
const W_SIM: f64 = 0.6;
const W_NAME: f64 = 0.25;
const W_TAG: f64 = 0.15;

/// `MAX_DISTANCE_THRESHOLD`: cosine distance over which a neighbour is dropped.
pub const MAX_DISTANCE: f64 = 0.25;
/// `MAX_SUGGESTIONS` (folders) and `MAX_NOTE_SUGGESTIONS`.
pub const MAX_FOLDER_SUGGESTIONS: usize = 3;
pub const MAX_NOTE_SUGGESTIONS: usize = 3;
/// `MIN_CONTENT_LENGTH`, in UTF-16 code units of the similarity input.
pub const MIN_CONTENT_LENGTH: usize = 10;
/// `SIMILAR_NOTE_LIMIT`: the KNN `k` the caller asks for.
pub const SIMILAR_NOTE_LIMIT: usize = 20;
/// `FOLDER_MIN_CONFIDENCE`.
pub const FOLDER_MIN_CONFIDENCE: f64 = 0.45;
/// `snippet.slice(0, 150)`, in UTF-16 code units.
const SNIPPET_UNITS: usize = 150;

/// One matched note, reduced to its folder (`FolderHit`).
#[derive(Debug, Clone, PartialEq)]
pub struct FolderHit {
    /// Folder path, `""` for the vault root.
    pub folder: String,
    pub similarity: f64,
    pub note_title: Option<String>,
}

/// `FolderSignals`. Name and tag matches keep their insertion order, as the
/// JavaScript `Map`s do, because candidate order breaks confidence ties.
#[derive(Debug, Clone, Default)]
pub struct FolderSignals {
    pub hits: Vec<FolderHit>,
    pub name_matches: Vec<(String, f64)>,
    pub tag_matches: Vec<(String, f64)>,
    pub exclude: Vec<String>,
    pub min_confidence: f64,
    pub limit: Option<usize>,
}

/// `FolderScore`.
#[derive(Debug, Clone, PartialEq)]
pub struct FolderScore {
    pub path: String,
    pub confidence: f64,
    pub support: usize,
    pub top_note_title: Option<String>,
    pub sim: f64,
    pub name: f64,
    pub tag: f64,
}

/// `corroboratedSimilarity`: the mean of the best [`SUPPORT_CAP`]
/// similarities, discounted when only one or two notes agree.
pub fn corroborated_similarity(sims: &[f64]) -> f64 {
    if sims.is_empty() {
        return 0.0;
    }
    let mut top = sims.to_vec();
    top.sort_by(|a, b| b.total_cmp(a));
    top.truncate(SUPPORT_CAP);
    let mean = top.iter().fold(0.0, |sum, s| sum + s) / top.len() as f64;
    let corroboration = 1.0 - LONE_HIT_PENALTY / sims.len().min(SUPPORT_CAP) as f64;
    mean * corroboration
}

/// Proper ancestors of `folder`, nearest first, root excluded.
fn ancestors(folder: &str) -> Vec<String> {
    if folder.is_empty() {
        return Vec::new();
    }
    let parts: Vec<&str> = folder.split('/').collect();
    (1..parts.len())
        .rev()
        .map(|i| parts[..i].join("/"))
        .collect()
}

struct SimAggregate {
    score: f64,
    support: usize,
    top_note_title: Option<String>,
}

/// `aggregateSimilarity`, in first-seen folder order.
fn aggregate(hits: &[FolderHit]) -> Vec<(String, SimAggregate)> {
    let mut order: Vec<String> = Vec::new();
    let mut contribs: HashMap<String, Vec<(f64, Option<String>)>> = HashMap::new();
    let mut add = |folder: String, similarity: f64, title: Option<String>| {
        let list = contribs.entry(folder.clone()).or_default();
        if list.is_empty() {
            order.push(folder);
        }
        list.push((similarity, title));
    };
    for hit in hits {
        add(hit.folder.clone(), hit.similarity, hit.note_title.clone());
        for (depth, ancestor) in ancestors(&hit.folder).into_iter().enumerate() {
            let decay = ANCESTOR_DECAY.powf((depth + 1) as f64);
            add(ancestor, hit.similarity * decay, hit.note_title.clone());
        }
    }
    order
        .into_iter()
        .map(|folder| {
            let list = &contribs[&folder];
            let sims: Vec<f64> = list.iter().map(|(s, _)| *s).collect();
            // `reduce` keeps the first of equal bests.
            let top =
                list.iter()
                    .skip(1)
                    .fold(&list[0], |best, c| if c.0 > best.0 { c } else { best });
            let aggregate = SimAggregate {
                score: corroborated_similarity(&sims),
                support: list.len(),
                top_note_title: top.1.clone(),
            };
            (folder, aggregate)
        })
        .collect()
}

/// `scoreFolders`: each candidate's confidence is the weighted mean of the
/// signals present for it, highest first (stable on ties).
pub fn score_folders(input: &FolderSignals) -> Vec<FolderScore> {
    let excluded: HashSet<&str> = input.exclude.iter().map(String::as_str).collect();
    let sim_by_folder = aggregate(&input.hits);
    let names: HashMap<&str, f64> = input
        .name_matches
        .iter()
        .map(|(f, s)| (f.as_str(), *s))
        .collect();
    let tags: HashMap<&str, f64> = input
        .tag_matches
        .iter()
        .map(|(f, s)| (f.as_str(), *s))
        .collect();
    let sims: HashMap<&str, &SimAggregate> =
        sim_by_folder.iter().map(|(f, a)| (f.as_str(), a)).collect();

    let mut seen: HashSet<&str> = HashSet::new();
    let candidates = sim_by_folder
        .iter()
        .map(|(f, _)| f.as_str())
        .chain(input.name_matches.iter().map(|(f, _)| f.as_str()))
        .chain(input.tag_matches.iter().map(|(f, _)| f.as_str()))
        .filter(|f| seen.insert(f));

    let mut scores = Vec::new();
    for path in candidates {
        if excluded.contains(path) {
            continue;
        }
        let sim = sims.get(path);
        let sim_score = sim.map_or(0.0, |a| a.score);
        let name_score = names.get(path).copied().unwrap_or(0.0);
        let tag_score = tags.get(path).copied().unwrap_or(0.0);
        let (mut weighted, mut weight) = (0.0, 0.0);
        if sim.is_some() {
            weighted += sim_score * W_SIM;
            weight += W_SIM;
        }
        if name_score > 0.0 {
            weighted += name_score * W_NAME;
            weight += W_NAME;
        }
        if tag_score > 0.0 {
            weighted += tag_score * W_TAG;
            weight += W_TAG;
        }
        if weight == 0.0 {
            continue;
        }
        let confidence = weighted / weight;
        if confidence < input.min_confidence {
            continue;
        }
        scores.push(FolderScore {
            path: path.to_owned(),
            confidence,
            support: sim.map_or(0, |a| a.support),
            top_note_title: sim.and_then(|a| a.top_note_title.clone()),
            sim: sim_score,
            name: name_score,
            tag: tag_score,
        });
    }
    scores.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    if let Some(limit) = input.limit {
        scores.truncate(limit);
    }
    scores
}

/// `filingHistoryConfidence`: more prior filings, more confidence, capped.
pub fn filing_history_confidence(count: i64) -> f64 {
    0.7_f64.min(0.3 + count as f64 * 0.1)
}

/// `recentDestinationConfidence`: a weaker signal, capped lower.
pub fn recent_destination_confidence(count: i64) -> f64 {
    0.5_f64.min(0.2 + count as f64 * 0.05)
}

/// `folderReason`: the reason text from the dominant signal.
pub fn folder_reason(score: &FolderScore) -> String {
    let path = score.path.as_str();
    if let Some(title) = &score.top_note_title {
        return if path.is_empty() {
            format!("Similar to \"{title}\" in root")
        } else {
            format!("Similar to \"{title}\" in {path}")
        };
    }
    match (score.name > 0.0, score.tag > 0.0, path.is_empty()) {
        (true, _, false) => format!("Folder name matches \"{path}\""),
        (true, _, true) => "Matches the root folder".to_owned(),
        (false, true, false) => format!("Shared tags with notes in {path}"),
        (false, true, true) => "Shared tags with root notes".to_owned(),
        (false, false, false) => format!("Suggested folder {path}"),
        (false, false, true) => "Root folder".to_owned(),
    }
}

/// `tokenize`: lowercase ASCII word tokens of two or more characters.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for raw in text
        .to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
    {
        if raw.len() >= 2 && !tokens.iter().any(|t| t == raw) {
            tokens.push(raw.to_owned());
        }
    }
    tokens
}

/// `getFolderFromPath`: everything before the last `/`.
pub fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// `computeNameMatches`: the share of each folder's name tokens found in the
/// capture's text, for folders with at least one.
pub fn name_matches(folders: &[String], item_tokens: &[String]) -> Vec<(String, f64)> {
    let mut out: Vec<(String, f64)> = Vec::new();
    if item_tokens.is_empty() {
        return out;
    }
    for folder in folders {
        if folder.is_empty() || out.iter().any(|(f, _)| f == folder) {
            continue;
        }
        let folder_tokens = tokenize(&folder.replace('/', " "));
        if folder_tokens.is_empty() {
            continue;
        }
        let hit = folder_tokens
            .iter()
            .filter(|t| item_tokens.contains(t))
            .count();
        if hit > 0 {
            out.push((folder.clone(), hit as f64 / folder_tokens.len() as f64));
        }
    }
    out
}

/// `computeTagMatches`: per folder, the share of the capture's distinct
/// (folded) tags that its notes carry.
pub fn tag_matches(item_tags: &[String], tagged: &[TaggedNote]) -> Vec<(String, f64)> {
    let wanted: Vec<String> = item_tags
        .iter()
        .filter(|t| !t.is_empty())
        .map(|t| tags::fold(t))
        .fold(Vec::new(), |mut acc, t| {
            if !acc.contains(&t) {
                acc.push(t);
            }
            acc
        });
    if wanted.is_empty() {
        return Vec::new();
    }
    let mut per_folder: Vec<(String, Vec<String>)> = Vec::new();
    for note in tagged {
        let tag = tags::fold(&note.tag);
        if !wanted.contains(&tag) {
            continue;
        }
        let folder = folder_of(&note.path);
        match per_folder.iter_mut().find(|(f, _)| f == folder) {
            Some((_, set)) if set.contains(&tag) => {}
            Some((_, set)) => set.push(tag),
            None => per_folder.push((folder.to_owned(), vec![tag])),
        }
    }
    per_folder
        .into_iter()
        .map(|(folder, set)| (folder, set.len() as f64 / wanted.len() as f64))
        .collect()
}

/// A KNN neighbour of the capture's text, resolved to its note.
#[derive(Debug, Clone, PartialEq)]
pub struct SuggestHit {
    pub note_id: String,
    /// Vault-relative path of the note's file.
    pub path: String,
    pub title: String,
    pub emoji: Option<String>,
    pub snippet: Option<String>,
    /// Cosine distance, `1 - cosine`.
    pub distance: f64,
}

/// An index note carrying `tag`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaggedNote {
    pub path: String,
    pub tag: String,
}

/// What the index contributes; see the module comment.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SuggestIndex {
    /// Nearest first, at most [`SIMILAR_NOTE_LIMIT`] are read.
    pub hits: Vec<SuggestHit>,
    /// Folders that hold notes (`getDistinctFolders`).
    pub folders: Vec<String>,
    /// Notes carrying one of the capture's tags (`computeTagMatches`' join).
    pub tagged_notes: Vec<TaggedNote>,
}

/// A note a suggestion links to (`SuggestedNote`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestedNote {
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub emoji: Option<String>,
}

/// One `FilingSuggestion`. `destination_type` is `folder`, `note` or, for a
/// filing-history pattern, the recorded action verbatim.
#[derive(Debug, Clone, PartialEq)]
pub struct Suggestion {
    pub destination_type: String,
    pub path: Option<String>,
    pub note_id: Option<String>,
    pub note_title: Option<String>,
    pub confidence: f64,
    pub reason: String,
    pub suggested_tags: Vec<String>,
    pub suggested_note: Option<SuggestedNote>,
}

/// A filing-history pattern: captures of one type filed to one place.
#[derive(Debug, Clone, PartialEq)]
pub struct FilingPattern {
    pub destination: String,
    pub action: String,
    pub count: i64,
    pub tags: Vec<String>,
}

/// `getFilingPatterns`: the ten most used (`filed_to`, `filed_action`) pairs
/// of live filed captures of `item_type`, each with the tags of the latest
/// capture filed there. Ties break on the pair, ascending.
pub fn filing_patterns(
    conn: &Connection,
    item_type: &str,
) -> Result<Vec<FilingPattern>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT filed_to, filed_action, count(*),
                    (SELECT l.id FROM inbox_items l
                      WHERE l.deleted_at IS NULL AND l.type = ?1 AND l.filed_at IS NOT NULL
                        AND l.filed_to = i.filed_to AND l.filed_action = i.filed_action
                      ORDER BY l.filed_at DESC, l.id DESC LIMIT 1)
               FROM inbox_items i
              WHERE deleted_at IS NULL AND type = ?1 AND filed_at IS NOT NULL
                AND filed_to IS NOT NULL AND filed_action IS NOT NULL
              GROUP BY filed_to, filed_action
              ORDER BY count(*) DESC, filed_to, filed_action
              LIMIT 10",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map(params![item_type], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    rows.into_iter()
        .map(|(filed_to, action, count, latest)| {
            Ok(FilingPattern {
                destination: folder_of(&filed_to).to_owned(),
                action,
                count,
                tags: super::tags_of(conn, &latest)?,
            })
        })
        .collect()
}

/// `getRecentFilingDestinations(5)`: the five most used `filed_to` of live
/// folder filings, as folders, with their counts.
pub fn recent_destinations(conn: &Connection) -> Result<Vec<(String, i64)>, StorageError> {
    let mut statement = conn
        .prepare(
            "SELECT filed_to, count(*) FROM inbox_items
              WHERE deleted_at IS NULL AND filed_at IS NOT NULL
                AND filed_action = 'folder' AND filed_to IS NOT NULL
              GROUP BY filed_to
              ORDER BY count(*) DESC, filed_to
              LIMIT 5",
        )
        .map_err(failed)?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<Vec<(String, i64)>, _>>()
        .map_err(failed)?;
    Ok(rows
        .into_iter()
        .map(|(path, count)| (folder_of(&path).to_owned(), count))
        .collect())
}

/// What [`assemble`] reads from `data.db`.
#[derive(Debug, Clone, Default)]
pub struct FilingHistory {
    pub patterns: Vec<FilingPattern>,
    pub recent: Vec<(String, i64)>,
}

fn head_units(text: &str, units: usize) -> String {
    let cut: Vec<u16> = text.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&cut)
}

/// `getSuggestions` after its reads: folder suggestions from the index
/// signals, then the history and recent-destination fallbacks up to
/// [`MAX_FOLDER_SUGGESTIONS`], each list sorted by confidence; folders first,
/// then up to [`MAX_NOTE_SUGGESTIONS`] notes to link.
pub fn assemble(
    item: &InboxItem,
    index: &SuggestIndex,
    history: &FilingHistory,
) -> Vec<Suggestion> {
    let mut suggestions: Vec<Suggestion> = Vec::new();
    let mut notes: Vec<Suggestion> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let content = build_embedding_input(
        Some(&item.title),
        item.content.as_deref(),
        EmbeddingTask::Similarity,
    );
    if content.encode_utf16().count() >= MIN_CONTENT_LENGTH {
        let similar: Vec<(&SuggestHit, f64)> = index
            .hits
            .iter()
            .take(SIMILAR_NOTE_LIMIT)
            .filter(|hit| hit.distance <= MAX_DISTANCE)
            .map(|hit| (hit, calibrate_similarity(1.0 - hit.distance)))
            .collect();
        let scores = score_folders(&FolderSignals {
            hits: similar
                .iter()
                .map(|(hit, score)| FolderHit {
                    folder: folder_of(&hit.path).to_owned(),
                    similarity: *score,
                    note_title: Some(hit.title.clone()),
                })
                .collect(),
            name_matches: name_matches(&index.folders, &tokenize(&content)),
            tag_matches: tag_matches(&item.tags, &index.tagged_notes),
            exclude: Vec::new(),
            min_confidence: FOLDER_MIN_CONFIDENCE,
            limit: Some(MAX_FOLDER_SUGGESTIONS),
        });
        for score in &scores {
            let key = if score.path.is_empty() {
                "root".to_owned()
            } else {
                score.path.clone()
            };
            if !seen.insert(key) {
                continue;
            }
            suggestions.push(Suggestion {
                destination_type: "folder".to_owned(),
                path: Some(score.path.clone()),
                note_id: None,
                note_title: None,
                confidence: score.confidence,
                reason: folder_reason(score),
                suggested_tags: Vec::new(),
                suggested_note: None,
            });
        }
        for (hit, score) in similar.iter().take(MAX_NOTE_SUGGESTIONS) {
            notes.push(Suggestion {
                destination_type: "note".to_owned(),
                path: None,
                note_id: Some(hit.note_id.clone()),
                note_title: Some(hit.title.clone()),
                confidence: *score,
                // `Math.round` of a value in 0..=100.
                reason: format!("Similar content ({}% match)", (score * 100.0 + 0.5).floor()),
                suggested_tags: Vec::new(),
                suggested_note: Some(SuggestedNote {
                    id: hit.note_id.clone(),
                    title: hit.title.clone(),
                    snippet: head_units(hit.snippet.as_deref().unwrap_or(""), SNIPPET_UNITS),
                    emoji: hit.emoji.clone(),
                }),
            });
        }
    }

    let room = MAX_FOLDER_SUGGESTIONS.saturating_sub(suggestions.len());
    let mut fallbacks: Vec<Suggestion> = Vec::new();
    let patterns = history.patterns.iter().map(|p| {
        let reason = format!("You've filed {} similar {}s here", p.count, item.item_type);
        let confidence = filing_history_confidence(p.count);
        (
            &p.destination,
            p.action.clone(),
            confidence,
            reason,
            p.tags.clone(),
        )
    });
    let recent = history.recent.iter().map(|(path, count)| {
        let reason = format!("Recently used ({count} items)");
        let confidence = recent_destination_confidence(*count);
        (path, "folder".to_owned(), confidence, reason, Vec::new())
    });
    for (path, action, confidence, reason, tags) in patterns.chain(recent) {
        if fallbacks.len() >= room {
            break;
        }
        if !seen.insert(path.clone()) {
            continue;
        }
        fallbacks.push(Suggestion {
            destination_type: action,
            path: Some(path.clone()),
            note_id: None,
            note_title: None,
            confidence,
            reason,
            suggested_tags: tags,
            suggested_note: None,
        });
    }
    suggestions.extend(fallbacks);

    suggestions.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    notes.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
    suggestions.truncate(MAX_FOLDER_SUGGESTIONS);
    suggestions.extend(notes);
    suggestions
}

#[cfg(test)]
#[path = "suggest_tests.rs"]
mod tests;
