//! Similar notes, tag suggestions and note groups (Electron's `notes:get-similar`,
//! `notes:get-tag-suggestions` and `notes:cluster`, `ipc/notes-handlers.ts:512-530`), answered by
//! [`memry_core::domain::similarity`] over the open vault's stored vectors. Step 23 (#3540).
//!
//! Electron's `similarity/index.ts` answers a failed read of the similar list or the tag
//! suggestions with an empty `ready` answer after logging it, and lets a failed grouping reject;
//! these do the same. With no vault open the answer is `disabled`, as Electron's
//! `isEmbeddingEnabled` reads it when its database getter throws.

use std::collections::{HashMap, HashSet};

use memry_core::api::errors::StorageError;
use memry_core::domain::similarity::{
    self, AI_ENABLED_KEY, DEFAULT_SIMILAR_LIMIT, MAX_CLUSTER_NOTES, NoteInfo, SimilarityStatus,
    SimilarityStore,
};
use serde::Serialize;

use crate::session::OpenVault;
use crate::settings::SettingsService;

/// `NoteSimilarRequestSchema`'s `limit` range.
const LIMITS: std::ops::RangeInclusive<u32> = 1..=20;

/// An input `NoteSimilarRequestSchema` or `NoteClusterRequestSchema` refuses, by field name.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid {0}")]
pub struct Invalid(pub &'static str);

/// `NoteSimilarityStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NoteSimilarityStatus {
    Disabled,
    NoEmbedding,
    Ready,
}

impl From<SimilarityStatus> for NoteSimilarityStatus {
    fn from(status: SimilarityStatus) -> Self {
        match status {
            SimilarityStatus::Disabled => Self::Disabled,
            SimilarityStatus::NoEmbedding => Self::NoEmbedding,
            SimilarityStatus::Ready => Self::Ready,
        }
    }
}

/// `SimilarNoteItem`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SimilarNoteItem {
    pub id: String,
    pub title: String,
    pub path: String,
    pub emoji: Option<String>,
    pub snippet: Option<String>,
    pub similarity: f64,
}

/// `SimilarNotesResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SimilarNotesResponse {
    pub status: NoteSimilarityStatus,
    pub notes: Vec<SimilarNoteItem>,
}

/// `NoteTagSuggestion`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagSuggestion {
    pub tag: String,
    pub confidence: f64,
    pub support: u32,
}

/// `NoteTagSuggestionsResponse`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteTagSuggestionsResponse {
    pub status: NoteSimilarityStatus,
    pub tags: Vec<NoteTagSuggestion>,
}

/// `NoteClusterGroup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteClusterGroup {
    pub note_ids: Vec<String>,
    pub titles: Vec<String>,
    pub suggested_name: Option<String>,
}

/// `NoteClustersResponse`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteClustersResponse {
    pub status: NoteSimilarityStatus,
    pub groups: Vec<NoteClusterGroup>,
    pub ungrouped: Vec<String>,
    pub missing: Vec<String>,
}

/// The open vault's similarity reads, with the AI switch from its settings.
struct Store<'a> {
    vault: &'a OpenVault,
    settings: &'a SettingsService,
}

impl SimilarityStore for Store<'_> {
    fn ai_enabled_setting(&self) -> Result<Option<String>, StorageError> {
        self.settings
            .get_local_text(Some(self.vault), AI_ENABLED_KEY)
            .map_err(|error| StorageError::Failed {
                what: error.to_string(),
            })
    }

    fn vector(&self, note_id: &str) -> Result<Option<Vec<f32>>, StorageError> {
        self.vault.search.similarity_vector(note_id)
    }

    fn nearest(&self, vector: &[f32], k: usize) -> Result<Vec<(String, f64)>, StorageError> {
        self.vault.search.similarity_nearest(vector, k)
    }

    fn linked_note_ids(&self, note_id: &str) -> Result<HashSet<String>, StorageError> {
        self.vault.search.similarity_linked_note_ids(note_id)
    }

    fn tags_by_note(
        &self,
        note_ids: &[String],
    ) -> Result<HashMap<String, Vec<String>>, StorageError> {
        self.vault.search.tags_of_notes(note_ids.to_vec())
    }

    fn notes(&self, note_ids: &[String]) -> Result<HashMap<String, NoteInfo>, StorageError> {
        self.vault.search.similarity_notes(note_ids)
    }
}

/// `getSimilarNotes`: the notes nearest `note_id` that it is not linked with, `limit` of them
/// (5 when absent).
pub fn similar(
    vault: Option<&OpenVault>,
    settings: &SettingsService,
    note_id: &str,
    limit: Option<u32>,
) -> Result<SimilarNotesResponse, Invalid> {
    if note_id.is_empty() {
        return Err(Invalid("noteId"));
    }
    if limit.is_some_and(|limit| !LIMITS.contains(&limit)) {
        return Err(Invalid("limit"));
    }
    let Some(vault) = vault else {
        return Ok(SimilarNotesResponse {
            status: NoteSimilarityStatus::Disabled,
            notes: Vec::new(),
        });
    };
    let limit = limit.map_or(DEFAULT_SIMILAR_LIMIT, |limit| limit as usize);
    let answer = similarity::similar_notes(&Store { vault, settings }, note_id, limit).inspect_err(
        |error| tracing::error!(scope = "Similarity", "similar notes failed: {error}"),
    );
    Ok(match answer {
        Ok(answer) => SimilarNotesResponse {
            status: answer.status.into(),
            notes: answer
                .notes
                .into_iter()
                .map(|note| SimilarNoteItem {
                    id: note.id,
                    title: note.info.title,
                    path: note.info.path,
                    emoji: note.info.emoji,
                    snippet: note.info.snippet,
                    similarity: note.similarity,
                })
                .collect(),
        },
        Err(_) => SimilarNotesResponse {
            status: NoteSimilarityStatus::Ready,
            notes: Vec::new(),
        },
    })
}

/// `getTagSuggestions`: tags the nearest notes share and `note_id` lacks.
pub fn tag_suggestions(
    vault: Option<&OpenVault>,
    settings: &SettingsService,
    note_id: &str,
) -> NoteTagSuggestionsResponse {
    let Some(vault) = vault else {
        return NoteTagSuggestionsResponse {
            status: NoteSimilarityStatus::Disabled,
            tags: Vec::new(),
        };
    };
    match similarity::tag_suggestions(&Store { vault, settings }, note_id) {
        Ok(answer) => NoteTagSuggestionsResponse {
            status: answer.status.into(),
            tags: answer
                .tags
                .into_iter()
                .map(|tag| NoteTagSuggestion {
                    tag: tag.tag,
                    confidence: tag.confidence,
                    support: u32::try_from(tag.support).unwrap_or(u32::MAX),
                })
                .collect(),
        },
        Err(error) => {
            tracing::error!(scope = "Similarity", "tag suggestions failed: {error}");
            NoteTagSuggestionsResponse {
                status: NoteSimilarityStatus::Ready,
                tags: Vec::new(),
            }
        }
    }
}

/// A grouping that could not be answered.
#[derive(Debug, thiserror::Error)]
pub enum ClusterError {
    #[error(transparent)]
    Invalid(#[from] Invalid),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

/// `clusterNotes`: proposed groups for at most [`MAX_CLUSTER_NOTES`] notes.
pub fn cluster(
    vault: Option<&OpenVault>,
    settings: &SettingsService,
    note_ids: &[String],
) -> Result<NoteClustersResponse, ClusterError> {
    if note_ids.len() > MAX_CLUSTER_NOTES || note_ids.iter().any(String::is_empty) {
        return Err(Invalid("noteIds").into());
    }
    let Some(vault) = vault else {
        return Ok(NoteClustersResponse {
            status: NoteSimilarityStatus::Disabled,
            groups: Vec::new(),
            ungrouped: Vec::new(),
            missing: Vec::new(),
        });
    };
    let answer = similarity::group_notes(&Store { vault, settings }, note_ids)?;
    Ok(NoteClustersResponse {
        status: answer.status.into(),
        groups: answer
            .groups
            .into_iter()
            .map(|group| NoteClusterGroup {
                note_ids: group.note_ids,
                titles: group.titles,
                suggested_name: group.suggested_name,
            })
            .collect(),
        ungrouped: answer.ungrouped,
        missing: answer.missing,
    })
}
