//! Note similarity from the stored `similarity`-task vectors (`vec_note_similar`):
//! the notes nearest to a note, the tags those neighbours carry, and a grouping of
//! a set of notes. A port of Electron's `apps/desktop/src/main/similarity/index.ts`.
//!
//! Nothing here embeds text: the query vector is the note's own stored vector, so
//! no model load and no inference sit on the request path, and no note text is
//! read. The reads go through [`SimilarityStore`], which the desktop implements
//! over its databases; the decisions (thresholds, exclusions, over-fetch, order,
//! the answer when AI is off or a note has no vector) live here.

pub mod scoring;

use std::collections::{HashMap, HashSet};

use crate::api::errors::StorageError;
use scoring::{
    Clusters, GroupMember, ScoredTag, TagNeighbour, TagScoringOptions, cluster_by_similarity,
    score_neighbour_tags, suggest_group_name,
};

/// The setting that turns local AI off when it reads `"false"`.
pub const AI_ENABLED_KEY: &str = "ai.enabled";
/// Electron's `MAX_CLUSTER_NOTES` (`packages/contracts/src/notes-api.ts`): grouping is
/// O(n³), so one request groups at most this many notes.
pub const MAX_CLUSTER_NOTES: usize = 300;
/// Notes [`similar_notes`] answers when the caller names no limit.
pub const DEFAULT_SIMILAR_LIMIT: usize = 5;
/// Raw cosine EmbeddingGemma 2 gives unrelated notes; [`calibrate_similarity`] maps
/// it to 0.
pub const EMBEDDING_SIMILARITY_FLOOR: f64 = 0.6;

/// Calibrated similarity under which a neighbour is not shown as "similar" (raw 0.80,
/// above the strongest unrelated pair measured).
const MIN_SIMILAR: f64 = 0.5;
/// Neighbours read for tag suggestions.
const TAG_NEIGHBOURS: usize = 20;
/// Calibrated, raw 0.76; looser than [`MIN_SIMILAR`] because a tag also needs
/// [`TAG_MIN_SUPPORT`] neighbours agreeing.
const TAG_MIN_SIMILARITY: f64 = 0.4;
const TAG_MIN_SUPPORT: usize = 2;
const TAG_MIN_CONFIDENCE: f64 = 0.3;
const TAG_LIMIT: usize = 3;
/// Average-linkage floor for grouping, in raw cosine (clustering compares stored
/// vectors directly): between the weakest related pair (0.75) and the strongest
/// unrelated one (0.79).
const CLUSTER_THRESHOLD: f64 = 0.77;

/// Map a raw cosine onto 0..1 so that "unrelated" sits near the bottom instead of
/// at 0.7: median unrelated (0.71) is 0.28, a cross-language duplicate (0.95) 0.87.
pub fn calibrate_similarity(cosine: f64) -> f64 {
    ((cosine - EMBEDDING_SIMILARITY_FLOOR) / (1.0 - EMBEDDING_SIMILARITY_FLOOR)).clamp(0.0, 1.0)
}

/// What the similarity answers read. Every method is a read.
pub trait SimilarityStore {
    /// The stored value of [`AI_ENABLED_KEY`], `None` when unset.
    fn ai_enabled_setting(&self) -> Result<Option<String>, StorageError>;
    /// The note's stored similarity vector, `None` when it has none yet.
    fn vector(&self, note_id: &str) -> Result<Option<Vec<f32>>, StorageError>;
    /// The `k` stored vectors nearest `vector`, closest first, with their cosine
    /// distance (`1 - cosine`).
    fn nearest(&self, vector: &[f32], k: usize) -> Result<Vec<(String, f64)>, StorageError>;
    /// Notes `note_id` links to or is linked from, by body link or note property.
    fn linked_note_ids(&self, note_id: &str) -> Result<HashSet<String>, StorageError>;
    /// The tags of each note that has any, in stored order.
    fn tags_by_note(
        &self,
        note_ids: &[String],
    ) -> Result<HashMap<String, Vec<String>>, StorageError>;
    /// The listed notes that still exist.
    fn notes(&self, note_ids: &[String]) -> Result<HashMap<String, NoteInfo>, StorageError>;
}

/// A note as a similarity answer shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteInfo {
    pub title: String,
    /// Vault-relative path of the note's file.
    pub path: String,
    pub emoji: Option<String>,
    pub snippet: Option<String>,
}

/// Why an answer is empty, or `Ready`. Electron's `NoteSimilarityStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimilarityStatus {
    /// Local AI is off.
    Disabled,
    /// The note has no stored vector yet.
    NoEmbedding,
    Ready,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimilarNote {
    pub id: String,
    pub info: NoteInfo,
    /// Calibrated similarity to the source note, 0..1.
    pub similarity: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimilarNotes {
    pub status: SimilarityStatus,
    pub notes: Vec<SimilarNote>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TagSuggestions {
    pub status: SimilarityStatus,
    pub tags: Vec<ScoredTag>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteGroup {
    pub note_ids: Vec<String>,
    /// Titles in `note_ids` order, `""` for a note that is gone.
    pub titles: Vec<String>,
    /// A tag or folder most members share.
    pub suggested_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteGroups {
    /// `Disabled` or `Ready`; a missing vector lands the note in `missing`.
    pub status: SimilarityStatus,
    /// Groups of two or more notes, largest first.
    pub groups: Vec<NoteGroup>,
    /// Notes with a vector that joined no group.
    pub ungrouped: Vec<String>,
    /// Notes with no vector.
    pub missing: Vec<String>,
}

/// Local AI is on unless the setting reads `"false"`; an unreadable setting counts
/// as off, as in Electron.
fn embedding_enabled(store: &impl SimilarityStore) -> bool {
    matches!(store.ai_enabled_setting(), Ok(value) if value.as_deref() != Some("false"))
}

/// Nearest stored vectors, closest first, as calibrated similarity.
fn nearest(
    store: &impl SimilarityStore,
    vector: &[f32],
    k: usize,
) -> Result<Vec<(String, f64)>, StorageError> {
    Ok(store
        .nearest(vector, k)?
        .into_iter()
        .map(|(id, distance)| (id, calibrate_similarity(1.0 - distance)))
        .collect())
}

/// The notes most similar to `note_id`, closest first, excluding itself, every
/// note it links to or is linked from, and neighbours under [`MIN_SIMILAR`].
/// Electron answers a read error with an empty `Ready` list after logging it; the
/// caller does that with the `Err` here.
pub fn similar_notes(
    store: &impl SimilarityStore,
    note_id: &str,
    limit: usize,
) -> Result<SimilarNotes, StorageError> {
    let answer = |status, notes| Ok(SimilarNotes { status, notes });
    if !embedding_enabled(store) {
        return answer(SimilarityStatus::Disabled, Vec::new());
    }
    let Some(vector) = store.vector(note_id)? else {
        return answer(SimilarityStatus::NoEmbedding, Vec::new());
    };
    let mut exclude = store.linked_note_ids(note_id)?;
    exclude.insert(note_id.to_owned());
    // Over-fetch by the excluded count so filtering cannot starve the list.
    let hits: Vec<(String, f64)> = nearest(store, &vector, limit + exclude.len())?
        .into_iter()
        .filter(|(id, similarity)| !exclude.contains(id) && *similarity >= MIN_SIMILAR)
        .collect();
    if hits.is_empty() {
        return answer(SimilarityStatus::Ready, Vec::new());
    }
    let ids: Vec<String> = hits.iter().map(|(id, _)| id.clone()).collect();
    let mut info = store.notes(&ids)?;
    let notes = hits
        .into_iter()
        // A vector can briefly outlive its note (the prune runs on reconcile).
        .filter_map(|(id, similarity)| {
            let info = info.remove(&id)?;
            Some(SimilarNote {
                id,
                info,
                similarity: similarity.min(1.0),
            })
        })
        .take(limit)
        .collect();
    answer(SimilarityStatus::Ready, notes)
}

/// Tags that a note's nearest neighbours share and the note lacks: at most
/// [`TAG_LIMIT`], each carried by [`TAG_MIN_SUPPORT`] neighbours. Only suggested;
/// accepting one goes through the ordinary tag edit. A read error is the caller's
/// to log and answer with an empty `Ready` list, as in [`similar_notes`].
pub fn tag_suggestions(
    store: &impl SimilarityStore,
    note_id: &str,
) -> Result<TagSuggestions, StorageError> {
    let answer = |status, tags| Ok(TagSuggestions { status, tags });
    if !embedding_enabled(store) {
        return answer(SimilarityStatus::Disabled, Vec::new());
    }
    let Some(vector) = store.vector(note_id)? else {
        return answer(SimilarityStatus::NoEmbedding, Vec::new());
    };
    let hits: Vec<(String, f64)> = nearest(store, &vector, TAG_NEIGHBOURS + 1)?
        .into_iter()
        .filter(|(id, _)| id != note_id)
        .collect();
    let ids: Vec<String> = std::iter::once(note_id.to_owned())
        .chain(hits.iter().map(|(id, _)| id.clone()))
        .collect();
    let mut tags = store.tags_by_note(&ids)?;
    let neighbours: Vec<TagNeighbour> = hits
        .iter()
        .map(|(id, similarity)| TagNeighbour {
            similarity: *similarity,
            tags: tags.get(id).cloned().unwrap_or_default(),
        })
        .collect();
    let options = TagScoringOptions {
        exclude: tags.remove(note_id).unwrap_or_default(),
        min_similarity: TAG_MIN_SIMILARITY,
        min_support: TAG_MIN_SUPPORT,
        min_confidence: TAG_MIN_CONFIDENCE,
        limit: Some(TAG_LIMIT),
    };
    answer(
        SimilarityStatus::Ready,
        score_neighbour_tags(&neighbours, &options),
    )
}

/// Proposed groups for a set of notes (a canvas selection or board), over the first
/// [`MAX_CLUSTER_NOTES`] distinct ids. Nothing is created; the shell turns an
/// accepted group into a frame.
pub fn group_notes(
    store: &impl SimilarityStore,
    note_ids: &[String],
) -> Result<NoteGroups, StorageError> {
    let mut groups = NoteGroups {
        status: SimilarityStatus::Disabled,
        groups: Vec::new(),
        ungrouped: Vec::new(),
        missing: Vec::new(),
    };
    if !embedding_enabled(store) {
        return Ok(groups);
    }
    let mut seen = HashSet::new();
    let mut items: Vec<(String, Vec<f32>)> = Vec::new();
    for id in note_ids
        .iter()
        .filter(|id| seen.insert(*id))
        .take(MAX_CLUSTER_NOTES)
    {
        match store.vector(id)? {
            Some(vector) => items.push((id.clone(), vector)),
            None => groups.missing.push(id.clone()),
        }
    }
    let Clusters {
        groups: clusters,
        ungrouped,
    } = cluster_by_similarity(&items, CLUSTER_THRESHOLD);

    let grouped: Vec<String> = clusters.iter().flatten().cloned().collect();
    let (tags, info) = if grouped.is_empty() {
        (HashMap::new(), HashMap::new())
    } else {
        (store.tags_by_note(&grouped)?, store.notes(&grouped)?)
    };
    groups.status = SimilarityStatus::Ready;
    groups.ungrouped = ungrouped;
    groups.groups = clusters
        .into_iter()
        .map(|note_ids| {
            let members: Vec<GroupMember> = note_ids
                .iter()
                .map(|id| GroupMember {
                    tags: tags.get(id).cloned().unwrap_or_default(),
                    folder: info.get(id).map(|n| folder_of(&n.path)).unwrap_or_default(),
                })
                .collect();
            NoteGroup {
                titles: note_ids
                    .iter()
                    .map(|id| info.get(id).map(|n| n.title.clone()).unwrap_or_default())
                    .collect(),
                suggested_name: suggest_group_name(&members),
                note_ids,
            }
        })
        .collect();
    Ok(groups)
}

/// The folder part of a vault path, `""` at the root.
fn folder_of(path: &str) -> String {
    path.rsplit_once('/')
        .map_or_else(String::new, |(folder, _)| folder.to_owned())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
