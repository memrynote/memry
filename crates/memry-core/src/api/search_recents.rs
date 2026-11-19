//! `SearchRecents`: the search sheet's recently opened results (#4322).
//!
//! Its own object rather than more methods on [`crate::api::search::Search`]:
//! it reads only `data.db`, so it never pays for opening `index.db`. The rules
//! (trim, dedupe, liveness) are [`crate::domain::search::recents`]'s; how many
//! recents to keep is the shell's, given once when it builds the handle.

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
    cap: u32,
}

impl SearchRecents {
    /// Built by [`crate::api::vault::Vault::search_recents`].
    pub(crate) fn over(data: Db, cap: u32) -> Self {
        // A cap of zero would erase every recent on the next open.
        Self {
            data,
            cap: cap.max(1),
        }
    }
}

#[uniffi::export]
impl SearchRecents {
    /// Records that `result` was opened from a search for `query`. The
    /// result's `emoji` is stored as its icon, whatever its kind.
    pub fn record(&self, result: SearchResult, query: String) -> Result<(), StorageError> {
        let icon = result.emoji.clone();
        let kind = match (result.kind.as_str(), result.journal_date) {
            ("note", _) => HitKind::Note {
                emoji: result.emoji,
                folder_path: result.folder_path,
            },
            ("task", _) => HitKind::Task,
            ("inbox", _) => HitKind::Inbox,
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
            match_kind: result.match_kind,
            matched_name: result.matched_name,
        };
        let cap = self.cap;
        self.data.call_blocking(move |data| {
            recents::record(data, &hit, &query, icon.as_deref(), cap, now_ms())
        })
    }

    /// The recents whose items still exist, newest first, at most the cap the
    /// handle was built with. A note shows its emoji as it is now; any other
    /// kind shows the icon it was recorded with.
    pub fn list(&self) -> Result<Vec<SearchRecent>, StorageError> {
        let cap = self.cap;
        self.data.call_blocking(move |data| {
            Ok(recents::list(data, cap)?
                .into_iter()
                .map(|recent| {
                    let is_note = matches!(recent.hit.kind, HitKind::Note { .. });
                    let mut result = SearchResult::from(recent.hit);
                    if !is_note {
                        result.emoji = recent.icon;
                    }
                    SearchRecent {
                        result,
                        query: recent.query,
                        visited_at: recent.visited_at,
                    }
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
