//! `SearchRecents`: the search sheet's recently opened results (#4322).
//!
//! Its own object rather than more methods on [`crate::api::search::Search`]:
//! it reads only `data.db`, so it never pays for opening `index.db`. The rules
//! (cap, dedupe, liveness) are [`crate::domain::search::recents`]'s.

use crate::api::errors::StorageError;
use crate::api::search::SearchResult;
use crate::domain::search::recents;
use crate::domain::search::{HitKind, SearchHit};
use crate::storage::Db;

/// One recently opened result.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SearchRecent {
    /// The item, shaped like a hit so the shell opens it the same way.
    pub result: SearchResult,
    /// The query that found it.
    pub query: String,
    /// Epoch milliseconds.
    pub visited_at: i64,
}

/// Recents over one opened vault.
#[derive(uniffi::Object)]
pub struct SearchRecents {
    data: Db,
}

impl SearchRecents {
    /// Built by [`crate::api::vault::Vault::search_recents`].
    pub(crate) fn over(data: Db) -> Self {
        Self { data }
    }
}

#[uniffi::export]
impl SearchRecents {
    /// Records that `result` was opened from a search for `query`.
    pub fn record(&self, result: SearchResult, query: String) -> Result<(), StorageError> {
        let kind = match (result.kind.as_str(), result.journal_date) {
            ("note", _) => HitKind::Note {
                emoji: result.emoji,
                folder_path: result.folder_path,
            },
            ("task", _) => HitKind::Task,
            ("journal", date) => HitKind::Journal {
                date: date.unwrap_or_default(),
            },
            (other, _) => {
                return Err(StorageError::Failed {
                    what: format!("not a search result kind: {other}"),
                });
            }
        };
        let hit = SearchHit {
            id: result.id,
            title: result.title,
            kind,
            score: result.score,
            snippet: Vec::new(),
        };
        self.data
            .call_blocking(move |data| recents::record(data, &hit, &query, now_ms()))
    }

    /// The recents whose items still exist, newest first, at most ten.
    pub fn list(&self) -> Result<Vec<SearchRecent>, StorageError> {
        self.data.call_blocking(|data| {
            Ok(recents::list(data)?
                .into_iter()
                .map(|recent| SearchRecent {
                    result: SearchResult::from(recent.hit),
                    query: recent.query,
                    visited_at: recent.visited_at,
                })
                .collect())
        })
    }

    /// Forgets every recent.
    pub fn clear(&self) -> Result<(), StorageError> {
        self.data.call_blocking(|data| recents::clear(data))
    }
}

/// Wall clock, in epoch milliseconds (data-model §A.6).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
