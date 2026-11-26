//! The search palette's reads (Electron's `ipc/search-handlers.ts` and `search/semantic.ts`) over
//! the open vault: the grouped and quick searches of the core
//! ([`grouped`](memry_core::domain::search::grouped)), with the query's semantic leg when AI is
//! on and the text model is loaded, the counts, and the recently opened results
//! ([`recents`](memry_core::api::search_recents)). Step 23 (#3540).
//!
//! A search never fails the palette: a read that fails is logged and answers empty, as
//! Electron's handlers do (`search-handlers.ts:93-101,136-144`). The semantic leg degrades to the
//! index alone when AI is off, the model is absent or not loaded yet (the first search starts the
//! load), or the embedding or vector read fails.

pub mod view;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use memry_core::api::errors::StorageError;
use memry_core::domain::embedding_input::build_query_embedding_input;
use memry_core::domain::search::grouped::{self, GroupedQuery, GroupedResponse, SemanticHit};
use memry_core::domain::search::{ModifiedRange, SearchFilter};
use memry_core::storage::repositories::instants::to_epoch_ms;
use serde::Deserialize;

use crate::ai::features;
use crate::embedding::service::EmbeddingService;
use crate::session::OpenVault;
use crate::settings::SettingsService;
use crate::telemetry::Service;
use crate::telemetry::events::Metrics;

use self::view::{
    AddReasonInput, ContentType, QuickSearchResponse, SearchReason, SearchResponse, SearchStats,
    Tags,
};

/// `SearchQuerySchema`'s `text.max(500)`.
const MAX_TEXT_CHARS: usize = 500;
/// `SearchQuerySchema`'s `limit` range.
const LIMITS: std::ops::RangeInclusive<u32> = 1..=100;
/// `NoteFileTypeEnum`.
const NOTE_FILE_TYPES: [&str; 5] = ["markdown", "pdf", "image", "audio", "video"];

/// `DateRange`: ISO instants, both ends inclusive.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
pub struct DateRange {
    pub from: String,
    pub to: String,
}

fn default_limit() -> u32 {
    10
}

/// `SearchQueryInput`, with `SearchQuerySchema`'s defaults.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryInput {
    pub text: String,
    #[serde(default)]
    #[specta(optional)]
    pub types: Vec<ContentType>,
    #[serde(default)]
    #[specta(optional)]
    pub tags: Vec<String>,
    #[serde(default)]
    #[specta(optional)]
    pub date_range: Option<DateRange>,
    #[serde(default)]
    #[specta(optional)]
    pub project_id: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub folder_path: Option<String>,
    #[serde(default = "default_limit")]
    #[specta(optional)]
    pub limit: u32,
    /// Accepted and unused, as in Electron (`searchAll` reads no offset).
    #[serde(default)]
    #[specta(optional)]
    pub offset: u32,
    #[serde(default)]
    #[specta(optional)]
    pub note_file_types: Option<Vec<String>>,
}

/// An input `SearchQuerySchema`, `QuickSearchInputSchema` or `AddReasonSchema` refuses. The text
/// names the field, never its value: a query is the user's.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid {0}")]
pub struct Invalid(pub &'static str);

fn note_file_types(types: Option<Vec<String>>) -> Result<Vec<String>, Invalid> {
    match types {
        None => Ok(Vec::new()),
        Some(types)
            if !types.is_empty()
                && types
                    .iter()
                    .all(|kind| NOTE_FILE_TYPES.contains(&kind.as_str())) =>
        {
            Ok(types)
        }
        Some(_) => Err(Invalid("noteFileTypes")),
    }
}

impl SearchQueryInput {
    fn grouped(self) -> Result<GroupedQuery, Invalid> {
        if self.text.chars().count() > MAX_TEXT_CHARS {
            return Err(Invalid("text"));
        }
        if !LIMITS.contains(&self.limit) {
            return Err(Invalid("limit"));
        }
        let modified = match self.date_range {
            None => None,
            Some(range) => {
                let from = to_epoch_ms(&range.from).ok_or(Invalid("dateRange"))?;
                let to = to_epoch_ms(&range.to).ok_or(Invalid("dateRange"))?;
                Some(ModifiedRange {
                    from_ms: from,
                    to_ms: to,
                })
            }
        };
        Ok(GroupedQuery {
            text: self.text,
            filter: SearchFilter {
                types: self.types.into_iter().map(Into::into).collect(),
                modified,
                tags: self.tags,
            },
            project_id: self.project_id,
            folder_path: self.folder_path,
            note_file_types: note_file_types(self.note_file_types)?,
            limit: self.limit as usize,
        })
    }
}

/// What a search reads beside the vault: the AI switch and the text model, when the app has one;
/// and where it reports `search_performed`.
pub struct Searcher<'a> {
    pub vault: &'a OpenVault,
    pub settings: &'a SettingsService,
    pub model: Option<Arc<EmbeddingService>>,
    pub telemetry: Option<Arc<Service>>,
}

fn elapsed_ms(start: Instant) -> f64 {
    (start.elapsed().as_secs_f64() * 1000.0).round()
}

impl Searcher<'_> {
    /// `search:query`: the four groups with the semantic hits fused in.
    pub fn query(&self, input: SearchQueryInput) -> Result<SearchResponse, Invalid> {
        let query = input.grouped()?;
        let semantic = self.semantic_hits(&query.text);
        // Electron times `searchAll` after the query is embedded (`search.ts:553,680`).
        let start = Instant::now();
        let response = logged(self.vault.search.grouped(&query, &semantic))
            .map(|response| self.respond(response, start));
        self.track(
            "global",
            response.as_ref().map(|r| (r.query_time_ms, r.total_count)),
        );
        Ok(response.unwrap_or_default())
    }

    /// `search:quick`: the best twenty across every group.
    pub fn quick(
        &self,
        text: &str,
        types: Option<Vec<String>>,
    ) -> Result<QuickSearchResponse, Invalid> {
        let types = note_file_types(types)?;
        let semantic = self.semantic_hits(text);
        let start = Instant::now();
        let found = logged(self.vault.search.grouped_quick(text, &types, &semantic));
        let response = found.map(|found| {
            let tags = self.tags(found.iter().map(|item| item.id.as_str()));
            QuickSearchResponse {
                results: found
                    .into_iter()
                    .map(|item| view::item(item, &tags))
                    .collect(),
                query_time_ms: elapsed_ms(start),
            }
        });
        let answered = response.as_ref().map(|r| {
            let count = u32::try_from(r.results.len()).unwrap_or(u32::MAX);
            (r.query_time_ms, count)
        });
        self.track("quick", answered);
        Ok(response.unwrap_or_default())
    }

    fn track(&self, source: &str, answered: Option<(f64, u32)>) {
        if let Some(telemetry) = &self.telemetry {
            track(telemetry, source, answered);
        }
    }

    fn respond(&self, response: GroupedResponse, start: Instant) -> SearchResponse {
        let ids = response
            .groups
            .iter()
            .flat_map(|group| group.results.iter().map(|item| item.id.as_str()));
        let tags = self.tags(ids);
        SearchResponse {
            total_count: u32::try_from(response.total_count).unwrap_or(u32::MAX),
            groups: response
                .groups
                .into_iter()
                .map(|group| view::group(group, &tags))
                .collect(),
            query_time_ms: elapsed_ms(start),
        }
    }

    /// The tags of the notes and journal days among `ids`, each once by its folded spelling,
    /// first spelling kept. Empty when the read fails.
    fn tags<'a>(&self, ids: impl Iterator<Item = &'a str>) -> Tags {
        let ids: Vec<&str> = ids.collect();
        if ids.is_empty() {
            return Tags::new();
        }
        let rows = self
            .vault
            .search
            .result_tags(&ids)
            .inspect_err(|error| tracing::warn!(scope = "Search", "result tags: {error}"))
            .unwrap_or_default();
        let mut tags = Tags::new();
        let mut seen = HashSet::new();
        for (id, tag) in rows {
            if seen.insert((id.clone(), tag.to_lowercase())) {
                tags.entry(id).or_default().push(tag);
            }
        }
        tags
    }

    /// `semanticNoteHits` (`semantic.ts:50-131`): the notes near the query, their images
    /// included when image embeddings are on, best first. Empty when the query is not worth
    /// embedding, AI is off, the app has no text model, or the model is not loaded, in which case
    /// the load starts and this search answers from the index alone.
    pub fn semantic_hits(&self, text: &str) -> Vec<SemanticHit> {
        let query = text.trim();
        if !grouped::semantic::wants(query) {
            return Vec::new();
        }
        let Some(images) = self.ai_settings() else {
            return Vec::new();
        };
        let Some(model) = &self.model else {
            tracing::debug!(
                scope = "Search:Semantic",
                "no text model, answering from the index"
            );
            return Vec::new();
        };
        let status = model.status();
        if !status.loaded {
            if !status.loading {
                warm_up(model.clone());
            }
            return Vec::new();
        }
        let Some(vector) = model.embed(&build_query_embedding_input(query)) else {
            tracing::warn!(
                scope = "Search:Semantic",
                "the query was not embedded, answering from the index"
            );
            return Vec::new();
        };
        self.vault
            .search
            .semantic_note_hits(&vector, images)
            .inspect_err(|error| {
                tracing::warn!(scope = "Search:Semantic", "vector read failed: {error}")
            })
            .unwrap_or_default()
    }

    /// `None` when AI is off or unreadable, else whether image embeddings are on
    /// (`isImageEmbeddingEnabled`).
    fn ai_settings(&self) -> Option<bool> {
        features::read(self.settings, Some(self.vault))
            .inspect_err(|error| {
                tracing::warn!(scope = "Search:Semantic", "AI setting unreadable: {error}")
            })
            .ok()
            .filter(|settings| settings.enabled)
            .map(|settings| settings.image_embeddings)
    }
}

/// Starts the model load a search found missing, off the search's thread (`initEmbeddingModel`
/// in `semantic.ts:54-58`). The service logs a failed load.
fn warm_up(model: Arc<EmbeddingService>) {
    let started = std::thread::Builder::new()
        .name("memry-embed-warm".into())
        .spawn(move || {
            model.load();
        });
    if let Err(error) = started {
        tracing::warn!(
            scope = "Search:Semantic",
            "search model warm-up failed: {error}"
        );
    }
}

/// A search read's answer; a failure is logged and answers `None`.
fn logged<T>(read: Result<T, StorageError>) -> Option<T> {
    read.inspect_err(|error| tracing::error!(scope = "Search", "search failed: {error}"))
        .ok()
}

/// `search:get-stats`: the live rows of each type. A failed read answers zeros, as Electron does.
pub fn stats(vault: &OpenVault) -> SearchStats {
    vault
        .search
        .grouped_stats()
        .map(view::stats)
        .inspect_err(|error| tracing::error!(scope = "Search", "search stats failed: {error}"))
        .unwrap_or_default()
}

/// How many search reasons a vault keeps (`search-handlers.ts:242`). iOS keeps 10 in the same table.
const REASONS_CAP: u32 = 20;

/// `search:get-reasons`: the recently opened results whose items still exist, newest first.
pub fn reasons(vault: &OpenVault) -> Result<Vec<SearchReason>, StorageError> {
    Ok(vault
        .vault
        .search_recents(REASONS_CAP)
        .list()?
        .into_iter()
        .filter_map(view::reason)
        .collect())
}

/// `search:add-reason`: records the opened result and answers its row.
pub fn add_reason(vault: &OpenVault, input: AddReasonInput) -> Result<SearchReason, AddError> {
    for (field, text) in [
        ("itemId", &input.item_id),
        ("itemTitle", &input.item_title),
        ("searchQuery", &input.search_query),
    ] {
        if text.is_empty() {
            return Err(AddError::Invalid(Invalid(field)));
        }
    }
    let recents = vault.vault.search_recents(REASONS_CAP);
    recents.record(view::recorded(&input), input.search_query.clone())?;
    let stored = recents
        .list()?
        .into_iter()
        .filter_map(view::reason)
        .find(|reason| reason.item_type == input.item_type && reason.item_id == input.item_id);
    Ok(stored.unwrap_or_else(|| view::reason_from(&input, now_ms())))
}

/// `search:clear-reasons`.
pub fn clear_reasons(vault: &OpenVault) -> Result<(), StorageError> {
    vault.vault.search_recents(REASONS_CAP).clear()
}

#[derive(Debug, thiserror::Error)]
pub enum AddError {
    #[error(transparent)]
    Invalid(Invalid),
    #[error(transparent)]
    Storage(#[from] StorageError),
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

fn result_bucket(count: u32) -> &'static str {
    match count {
        0 => "zero",
        1..=5 => "one_to_five",
        _ => "six_plus",
    }
}

/// `search_performed` (`search-handlers.ts:79-99,122-142`): `source` is `global` or `quick`;
/// `answered` is the duration and result count, `None` for a failed search.
fn track(telemetry: &Service, source: &str, answered: Option<(f64, u32)>) {
    let mut event = Service::event("search_performed", "search", "queried");
    match answered {
        Some((duration_ms, count)) => {
            event.result = Some("success".to_owned());
            event.source = Some(source.to_owned());
            event.metrics = Some(Metrics {
                duration_ms: Some(duration_ms),
                result_count: Some(f64::from(count)),
                ..Metrics::default()
            });
            event.dimensions =
                Some([("result_bucket".to_owned(), result_bucket(count).to_owned())].into());
        }
        None => event.result = Some("failed".to_owned()),
    }
    telemetry.track(event);
}
