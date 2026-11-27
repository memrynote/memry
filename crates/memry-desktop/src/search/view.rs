//! The search answers in the shapes of `packages/contracts/src/search-api.ts`, built from the
//! core's grouped search ([`grouped`]) and recents ([`recents`]).
//!
//! [`grouped`]: memry_core::domain::search::grouped
//! [`recents`]: memry_core::api::search_recents

use std::collections::HashMap;

use memry_core::api::search::SearchResult;
use memry_core::api::search_recents::SearchRecent;
use memry_core::domain::search::grouped::{
    Group, GroupedItem, GroupedStats, ItemMeta, MatchType as CoreMatchType,
};
use memry_core::domain::search::{SearchType, SnippetSegment};
use memry_core::storage::repositories::instants::to_iso8601;
use serde::{Deserialize, Serialize};

/// `ContentType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ContentType {
    Note,
    Journal,
    Task,
    Inbox,
}

impl From<SearchType> for ContentType {
    fn from(kind: SearchType) -> Self {
        match kind {
            SearchType::Note => Self::Note,
            SearchType::Journal => Self::Journal,
            SearchType::Task => Self::Task,
            SearchType::Inbox => Self::Inbox,
        }
    }
}

impl From<ContentType> for SearchType {
    fn from(kind: ContentType) -> Self {
        match kind {
            ContentType::Note => Self::Note,
            ContentType::Journal => Self::Journal,
            ContentType::Task => Self::Task,
            ContentType::Inbox => Self::Inbox,
        }
    }
}

impl ContentType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Note => "note",
            Self::Journal => "journal",
            Self::Task => "task",
            Self::Inbox => "inbox",
        }
    }
}

/// `MatchType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum MatchType {
    Exact,
    Prefix,
    Fuzzy,
}

impl From<CoreMatchType> for MatchType {
    fn from(kind: CoreMatchType) -> Self {
        match kind {
            CoreMatchType::Exact => Self::Exact,
            CoreMatchType::Prefix => Self::Prefix,
            CoreMatchType::Fuzzy => Self::Fuzzy,
        }
    }
}

/// `NoteResultMetadata`. `fileType` is the stored text (`markdown`, `pdf`, `image`, `audio`,
/// `video`); the renderer narrows it.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteResultMetadata {
    pub path: String,
    pub tags: Vec<String>,
    pub emoji: Option<String>,
    pub word_count: Option<i64>,
    pub created_at: Option<String>,
    pub file_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub matched_name: Option<String>,
}

/// `JournalResultMetadata`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JournalResultMetadata {
    pub date: String,
    pub path: String,
    pub tags: Vec<String>,
    pub word_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub matched_name: Option<String>,
}

/// `TaskResultMetadata`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskResultMetadata {
    pub project_id: String,
    pub project_name: String,
    pub project_color: String,
    pub status_id: Option<String>,
    pub status_name: Option<String>,
    pub due_date: Option<String>,
    pub priority: i64,
    pub completed_at: Option<String>,
    pub created_at: Option<String>,
}

/// `InboxResultMetadata`. `itemType` is the stored text; the renderer narrows it.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InboxResultMetadata {
    pub item_type: String,
    pub source_url: Option<String>,
    pub source_title: Option<String>,
    pub filed_at: Option<String>,
}

/// `SearchResultMetadata`, told apart by `type`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SearchResultMetadata {
    Note(NoteResultMetadata),
    Journal(JournalResultMetadata),
    Task(TaskResultMetadata),
    Inbox(InboxResultMetadata),
}

/// `SearchResultItem`. `snippet` marks each match `<mark>…</mark>`, as FTS5's `snippet()` does
/// for Electron.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultItem {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ContentType,
    pub title: String,
    pub snippet: String,
    pub score: f64,
    pub normalized_score: f64,
    pub match_type: MatchType,
    pub modified_at: String,
    pub metadata: SearchResultMetadata,
}

/// `SearchResultGroup`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResultGroup {
    #[serde(rename = "type")]
    pub kind: ContentType,
    pub results: Vec<SearchResultItem>,
    pub total_in_group: u32,
}

/// `SearchResponse`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub groups: Vec<SearchResultGroup>,
    pub total_count: u32,
    pub query_time_ms: f64,
}

/// `QuickSearchResponse`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QuickSearchResponse {
    pub results: Vec<SearchResultItem>,
    pub query_time_ms: f64,
}

/// `SearchStats`. `lastIndexedAt` is always null, as in Electron (`search.ts:735`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchStats {
    pub total_notes: u32,
    pub total_journals: u32,
    pub total_tasks: u32,
    pub total_inbox_items: u32,
    pub total_indexed: u32,
    pub last_indexed_at: Option<String>,
}

/// `SearchReason`: a result opened from the palette. `id` is `<itemType>:<itemId>`, one row per
/// item as the store keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchReason {
    pub id: String,
    pub item_id: String,
    pub item_type: ContentType,
    pub item_title: String,
    pub item_icon: Option<String>,
    pub search_query: String,
    pub visited_at: String,
}

fn count(n: impl TryInto<u32>) -> u32 {
    n.try_into().unwrap_or(u32::MAX)
}

fn iso(ms: Option<i64>) -> Option<String> {
    ms.and_then(to_iso8601)
}

/// The snippet as Electron's FTS5 `snippet(..., '<mark>', '</mark>', ...)` writes it.
fn marked(segments: &[SnippetSegment]) -> String {
    segments
        .iter()
        .map(|segment| {
            if segment.highlighted {
                format!("<mark>{}</mark>", segment.text)
            } else {
                segment.text.clone()
            }
        })
        .collect()
}

/// A note or journal day's tags, by id; the rest have none here.
pub type Tags = HashMap<String, Vec<String>>;

pub fn item(found: GroupedItem, tags: &Tags) -> SearchResultItem {
    let tags_of = |id: &str| tags.get(id).cloned().unwrap_or_default();
    let metadata = match found.meta {
        ItemMeta::Note {
            path,
            emoji,
            file_type,
            word_count,
            created_at,
            matched_name,
        } => SearchResultMetadata::Note(NoteResultMetadata {
            path: path.unwrap_or_default(),
            tags: tags_of(&found.id),
            emoji,
            word_count,
            created_at: iso(created_at),
            file_type,
            matched_name,
        }),
        ItemMeta::Journal {
            date,
            path,
            word_count,
            matched_name,
        } => SearchResultMetadata::Journal(JournalResultMetadata {
            date,
            path: path.unwrap_or_default(),
            tags: tags_of(&found.id),
            word_count,
            matched_name,
        }),
        ItemMeta::Task {
            project_id,
            project_name,
            project_color,
            status_id,
            status_name,
            due_date,
            priority,
            completed_at,
            created_at,
        } => SearchResultMetadata::Task(TaskResultMetadata {
            project_id,
            project_name: project_name.unwrap_or_default(),
            project_color: project_color.unwrap_or_default(),
            status_id,
            status_name,
            due_date,
            priority,
            completed_at,
            created_at: iso(created_at),
        }),
        ItemMeta::Inbox {
            item_type,
            source_url,
            source_title,
            filed_at,
        } => SearchResultMetadata::Inbox(InboxResultMetadata {
            item_type,
            source_url,
            source_title,
            filed_at: iso(filed_at),
        }),
    };
    SearchResultItem {
        kind: found.kind.into(),
        snippet: marked(&found.snippet),
        title: found.title,
        score: found.score,
        normalized_score: found.normalized_score,
        match_type: found.match_type.into(),
        modified_at: iso(found.modified_at).unwrap_or_default(),
        metadata,
        id: found.id,
    }
}

pub fn group(group: Group, tags: &Tags) -> SearchResultGroup {
    let results: Vec<SearchResultItem> = group
        .results
        .into_iter()
        .map(|found| item(found, tags))
        .collect();
    SearchResultGroup {
        kind: group.kind.into(),
        total_in_group: count(results.len()),
        results,
    }
}

pub fn stats(stats: GroupedStats) -> SearchStats {
    SearchStats {
        total_notes: count(stats.notes),
        total_journals: count(stats.journals),
        total_tasks: count(stats.tasks),
        total_inbox_items: count(stats.inbox_items),
        total_indexed: count(stats.total()),
        last_indexed_at: None,
    }
}

/// A stored recent, or `None` for a kind this build does not know.
pub fn reason(recent: SearchRecent) -> Option<SearchReason> {
    let SearchRecent {
        result,
        query,
        visited_at,
    } = recent;
    let item_type = match result.kind.as_str() {
        "note" => ContentType::Note,
        "journal" => ContentType::Journal,
        "task" => ContentType::Task,
        "inbox" => ContentType::Inbox,
        _ => return None,
    };
    Some(reason_of(&result, item_type, query, visited_at))
}

fn reason_of(
    result: &SearchResult,
    item_type: ContentType,
    query: String,
    visited_at: i64,
) -> SearchReason {
    SearchReason {
        id: format!("{}:{}", item_type.as_str(), result.id),
        item_id: result.id.clone(),
        item_type,
        item_title: result.title.clone(),
        item_icon: result.emoji.clone(),
        search_query: query,
        visited_at: iso(Some(visited_at)).unwrap_or_default(),
    }
}

/// `AddReasonInput`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AddReasonInput {
    pub item_id: String,
    pub item_type: ContentType,
    pub item_title: String,
    #[serde(default)]
    #[specta(optional)]
    pub item_icon: Option<String>,
    pub search_query: String,
}

/// The input as the recents store records it: a hit of `item_type` whose `emoji` is the stored
/// icon, for every kind (Electron's `itemIcon`).
pub fn recorded(input: &AddReasonInput) -> SearchResult {
    use memry_core::domain::search::MatchKind;
    SearchResult {
        id: input.item_id.clone(),
        title: input.item_title.clone(),
        kind: input.item_type.as_str().to_owned(),
        journal_date: None,
        emoji: input.item_icon.clone(),
        folder_path: None,
        score: 0.0,
        snippet: Vec::new(),
        match_kind: MatchKind::Body,
        matched_name: None,
    }
}

/// The reason Electron answers for an add whose row cannot be read back.
pub fn reason_from(input: &AddReasonInput, visited_at: i64) -> SearchReason {
    reason_of(
        &recorded(input),
        input.item_type,
        input.search_query.clone(),
        visited_at,
    )
}
