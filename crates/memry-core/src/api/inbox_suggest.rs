//! `Inbox` filing suggestions and their feedback (parity rows inv04#29,
//! inv04#30, inv05#65). See `domain::inbox::suggest` for what the caller
//! passes in and why.

use crate::api::errors::StorageError;
use crate::api::inbox::Inbox;
use crate::api::tasks_write::now_ms;
use crate::domain::inbox;
use crate::domain::inbox::feedback::{self, Feedback};
use crate::domain::inbox::suggest::{
    self, FilingHistory, SuggestHit, SuggestIndex, Suggestion, TaggedNote,
};

/// A KNN neighbour of the capture's text, resolved to its note.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InboxSuggestHit {
    pub note_id: String,
    /// Vault-relative path of the note's file.
    pub path: String,
    pub title: String,
    pub emoji: Option<String>,
    pub snippet: Option<String>,
    /// Cosine distance (`1 - cosine`), as the vector index answers it.
    pub distance: f64,
}

/// An index note carrying `tag`.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxTaggedNote {
    pub path: String,
    pub tag: String,
}

/// What the search index contributes to a capture's suggestions.
#[derive(Debug, Clone, Default, PartialEq, uniffi::Record)]
pub struct InboxSuggestIndex {
    /// The capture's similarity-input neighbours, nearest first
    /// (`SIMILAR_NOTE_LIMIT` = 20 of them).
    pub hits: Vec<InboxSuggestHit>,
    /// Folders that hold notes.
    pub folders: Vec<String>,
    /// Notes carrying one of the capture's tags; others are ignored.
    pub tagged_notes: Vec<InboxTaggedNote>,
}

/// A note a suggestion links to (`SuggestedNote`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InboxSuggestedNote {
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub emoji: Option<String>,
}

/// One `FilingSuggestion`. `destination_type` is `folder`, `note`, or the
/// action a filing-history pattern recorded; a folder carries `path`, a note
/// `note_id` and `note_title`.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct InboxSuggestion {
    pub destination_type: String,
    pub path: Option<String>,
    pub note_id: Option<String>,
    pub note_title: Option<String>,
    pub confidence: f64,
    pub reason: String,
    pub suggested_tags: Vec<String>,
    pub suggested_note: Option<InboxSuggestedNote>,
}

impl From<Suggestion> for InboxSuggestion {
    fn from(s: Suggestion) -> Self {
        Self {
            destination_type: s.destination_type,
            path: s.path,
            note_id: s.note_id,
            note_title: s.note_title,
            confidence: s.confidence,
            reason: s.reason,
            suggested_tags: s.suggested_tags,
            suggested_note: s.suggested_note.map(|n| InboxSuggestedNote {
                id: n.id,
                title: n.title,
                snippet: n.snippet,
                emoji: n.emoji,
            }),
        }
    }
}

impl From<InboxSuggestIndex> for SuggestIndex {
    fn from(index: InboxSuggestIndex) -> Self {
        Self {
            hits: index
                .hits
                .into_iter()
                .map(|h| SuggestHit {
                    note_id: h.note_id,
                    path: h.path,
                    title: h.title,
                    emoji: h.emoji,
                    snippet: h.snippet,
                    distance: h.distance,
                })
                .collect(),
            folders: index.folders,
            tagged_notes: index
                .tagged_notes
                .into_iter()
                .map(|n| TaggedNote {
                    path: n.path,
                    tag: n.tag,
                })
                .collect(),
        }
    }
}

/// `getSuggestionStats`.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct InboxSuggestionStats {
    pub total_suggestions: i64,
    pub accepted_count: i64,
    pub rejected_count: i64,
    pub acceptance_rate: f64,
}

#[uniffi::export]
impl Inbox {
    /// `getSuggestions`: up to three folders, then up to three notes to link.
    /// The caller answers an empty list itself when local AI is off.
    pub fn suggestions(
        &self,
        item_id: String,
        index: InboxSuggestIndex,
    ) -> Result<Vec<InboxSuggestion>, StorageError> {
        self.db.read_blocking(move |conn| {
            // `getSuggestions`: no capture, no suggestions.
            let Some(item) = inbox::get(conn, &item_id)? else {
                return Ok(Vec::new());
            };
            let history = FilingHistory {
                patterns: suggest::filing_patterns(conn, &item.item_type)?,
                recent: suggest::recent_destinations(conn)?,
            };
            let found = suggest::assemble(&item, &index.into(), &history);
            Ok(found.into_iter().map(InboxSuggestion::from).collect())
        })
    }

    /// `trackSuggestionFeedback`. Local only.
    #[allow(clippy::too_many_arguments)]
    pub fn track_suggestion(
        &self,
        item_id: String,
        item_type: String,
        suggested_to: String,
        actual_to: String,
        confidence: f64,
        suggested_tags: Vec<String>,
        actual_tags: Vec<String>,
    ) -> Result<(), StorageError> {
        self.db.call_blocking(move |conn| {
            let entry = Feedback {
                item_id: &item_id,
                item_type: &item_type,
                suggested_to: &suggested_to,
                actual_to: &actual_to,
                confidence,
                suggested_tags: &suggested_tags,
                actual_tags: &actual_tags,
            };
            feedback::track(conn, &entry, now_ms())
        })
    }

    /// `getSuggestionStats`.
    pub fn suggestion_stats(&self) -> Result<InboxSuggestionStats, StorageError> {
        self.db.read_blocking(|conn| {
            let stats = feedback::stats(conn)?;
            Ok(InboxSuggestionStats {
                total_suggestions: stats.total,
                accepted_count: stats.accepted,
                rejected_count: stats.rejected,
                acceptance_rate: stats.acceptance_rate,
            })
        })
    }
}
