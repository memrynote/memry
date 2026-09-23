//! `Search`: the FTS index over one opened vault.
//!
//! The browse screen filters the note list it already holds, which matches
//! titles and only titles — a vault where the word is in the body reads as "no
//! results". `search_notes` has been in the core since the index tier landed;
//! it had no way across the FFI.
//!
//! **This opens `index.db`, which `Vault` deliberately does not.** The index is
//! a cache of `data.db` (data-model §A.5) and is rebuilt from it when it cannot
//! be trusted, so opening a vault must not depend on it. Building a `Search` is
//! where that cost is paid, and a vault that is never searched never pays it.
//!
//! **The index may be stale; the answer may not.** Every hit is checked against
//! `data.db` before it is returned, so a note deleted since the last reindex
//! cannot surface. That can return fewer hits than the limit asked for, which
//! is the right trade: a result that opens nothing is worse than a short list.
//!
//! **A reindex is the caller's to schedule.** It is idempotent and safe at any
//! time, but it walks the vault, so it is not hidden inside a keystroke.

use std::path::PathBuf;

use rusqlite::OptionalExtension as _;

use crate::api::errors::StorageError;
use crate::domain::search::{self, HitKind, SearchHit};
use crate::storage::{Db, open_index};

/// One search result.
///
/// Flattened from [`SearchHit`] because uniffi has no enum-with-payload that
/// reads well in Swift here: `journal_date` is `Some` exactly when `kind` is
/// `journal`, and nothing else distinguishes the two.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    /// `note`, `journal` or `task`.
    pub kind: String,
    /// The journal's calendar date, and `None` for everything else. A journal
    /// entry has no title of its own (§A.5), so this is what names it.
    pub journal_date: Option<String>,
    /// The bm25 score: negative, and more negative is a better match. Carried
    /// so a shell can show relevance if it wants to, never re-sorted — the
    /// order returned is already the ranking.
    pub score: f64,
}

impl From<SearchHit> for SearchResult {
    fn from(hit: SearchHit) -> Self {
        let (kind, journal_date) = match hit.kind {
            HitKind::Note => ("note", None),
            HitKind::Journal { date } => ("journal", Some(date)),
            HitKind::Task => ("task", None),
        };
        Self {
            id: hit.id,
            title: hit.title,
            kind: kind.to_owned(),
            journal_date,
            score: hit.score,
        }
    }
}

/// What a reindex did.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ReindexSummary {
    /// Whether the index was rebuilt from nothing rather than topped up.
    pub full: bool,
    pub notes_indexed: u32,
    pub tasks_indexed: u32,
    /// Rows the apply path had already flagged corrupt. **Not an error**: they
    /// are skipped by the indexer and counted here so a shell can say the
    /// index is short rather than pretending it is complete.
    pub corrupt_skipped: u32,
}

/// One note that links to another (N800).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Backlink {
    /// The note doing the linking.
    pub source_id: String,
    pub source_title: String,
    /// The title the link actually spells, which is not always the target's
    /// current title: a note renamed after being linked to keeps the old
    /// spelling in the link until the source is edited.
    pub target_title: String,
    /// `true` when the link is a `linkMention` carried in a property rather
    /// than written in the body, which desktop labels differently ("property
    /// → title") because it is not a sentence the user wrote.
    pub via_property: bool,
}

/// How a backlink list is ordered (N800), matching desktop's three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum BacklinkOrder {
    /// Most recently touched first, which is the default a reader wants.
    Recent,
    /// Alphabetical by the linking note's title.
    Title,
    /// Oldest first, for reading a thread of notes in the order it grew.
    Oldest,
}

/// The search surface over one opened vault.
#[derive(uniffi::Object)]
pub struct Search {
    data: Db,
    index: Db,
}

impl Search {
    /// Built by [`crate::api::vault::Vault::search`], which holds the data
    /// handle and knows the directory the index belongs beside.
    pub(crate) fn over(data: Db, directory: &str) -> Result<Self, StorageError> {
        let opened = open_index(&PathBuf::from(directory).join("index.db"))?;
        Ok(Self {
            data,
            index: opened.db,
        })
    }
}

#[uniffi::export]
impl Search {
    /// Every note linking to this one (N800).
    ///
    /// **Answerable only since the link projection landed.** `note_links`
    /// existed in the index schema and nothing wrote a row into it, so this
    /// query would have returned an empty list forever and read as "no note
    /// links here".
    ///
    /// Matched on the **title** rather than only on a resolved id, so a link
    /// written before its target existed still counts once the target is
    /// created — which is the case `target_id` being nullable exists for.
    pub fn backlinks(
        &self,
        note_id: String,
        order: BacklinkOrder,
    ) -> Result<Vec<Backlink>, StorageError> {
        let index = self.index.clone();
        self.data.call_blocking(move |data| {
            let title: Option<String> = data
                .query_row(
                    "SELECT title FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                    rusqlite::params![&note_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| StorageError::Failed {
                    what: error.to_string(),
                })?;
            // No such note is an empty list rather than an error: a note that
            // is not here has nothing linking to it that this vault can name.
            let Some(title) = title else {
                return Ok(Vec::new());
            };

            let sources: Vec<(String, String)> = index.call_blocking(|index| {
                let mut statement = index
                    .prepare(
                        "SELECT source_id, target_title FROM note_links \
                         WHERE target_id = ?1 OR target_title = ?2",
                    )
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })?;
                let rows = statement
                    .query_map(rusqlite::params![&note_id, &title], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })
            })?;

            // The source's own title and timestamps live in `data.db`, so the
            // two halves are joined here rather than in SQL: the index and the
            // data are separate databases on purpose.
            let mut out = Vec::new();
            for (source_id, target_title) in sources {
                if source_id == note_id {
                    // A note linking to itself is not a backlink.
                    continue;
                }
                let row = data
                    .query_row(
                        "SELECT title, COALESCE(modified_at, created_at, 0) FROM notes \
                         WHERE id = ?1 AND deleted_at IS NULL",
                        rusqlite::params![&source_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .optional()
                    .map_err(|error| StorageError::Failed {
                        what: error.to_string(),
                    })?;
                // A tombstoned source is skipped: its link is gone with it.
                let Some((source_title, stamp)) = row else {
                    continue;
                };
                out.push((
                    Backlink {
                        source_id,
                        source_title,
                        target_title,
                        // Nothing writes property-sourced links yet, so this
                        // is honestly false rather than guessed: see
                        // `research.md`.
                        via_property: false,
                    },
                    stamp,
                ));
            }

            match order {
                BacklinkOrder::Recent => out.sort_by(|a, b| {
                    b.1.cmp(&a.1)
                        .then_with(|| a.0.source_id.cmp(&b.0.source_id))
                }),
                BacklinkOrder::Oldest => out.sort_by(|a, b| {
                    a.1.cmp(&b.1)
                        .then_with(|| a.0.source_id.cmp(&b.0.source_id))
                }),
                BacklinkOrder::Title => out.sort_by(|a, b| {
                    a.0.source_title
                        .to_lowercase()
                        .cmp(&b.0.source_title.to_lowercase())
                        .then_with(|| a.0.source_id.cmp(&b.0.source_id))
                }),
            }
            Ok(out.into_iter().map(|(backlink, _)| backlink).collect())
        })
    }

    /// Notes and journals matching `query`, best first.
    ///
    /// A query carrying no searchable term returns **empty, not everything**:
    /// an empty search box is not a request for the whole vault.
    pub fn notes(&self, query: String, limit: u32) -> Result<Vec<SearchResult>, StorageError> {
        let index = self.index.clone();
        let limit = limit as usize;
        self.data.call_blocking(move |data| {
            index.call_blocking(|index| {
                Ok(search::search_notes(data, index, &query, limit)?
                    .into_iter()
                    .map(SearchResult::from)
                    .collect())
            })
        })
    }

    /// Tasks matching `query`, best first.
    ///
    /// Its own list rather than one merged with the notes: a bm25 score is
    /// relative to the table it was computed over, so interleaving the two
    /// would be inventing an order neither ranking supports.
    pub fn tasks(&self, query: String, limit: u32) -> Result<Vec<SearchResult>, StorageError> {
        let index = self.index.clone();
        let limit = limit as usize;
        self.data.call_blocking(move |data| {
            index.call_blocking(|index| {
                Ok(search::search_tasks(data, index, &query, limit)?
                    .into_iter()
                    .map(SearchResult::from)
                    .collect())
            })
        })
    }

    /// Brings the index up to date with the vault.
    ///
    /// Idempotent, incremental where it can be, and a full rebuild against an
    /// empty index. It walks what has changed since the last watermark, so it
    /// belongs on an explicit moment — a screen appearing, a sync finishing —
    /// and never on a keystroke.
    pub fn reindex(&self) -> Result<ReindexSummary, StorageError> {
        let index = self.index.clone();
        self.data.call_blocking(move |data| {
            index.call_blocking(|index| {
                let done = search::reindex(data, index, now_ms())?;
                Ok(ReindexSummary {
                    full: done.full,
                    notes_indexed: done.notes_indexed as u32,
                    tasks_indexed: done.tasks_indexed as u32,
                    corrupt_skipped: done.corrupt_skipped as u32,
                })
            })
        })
    }
}

/// Wall clock, in epoch milliseconds (data-model §A.6).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}
