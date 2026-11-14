//! What [`super::Search::search`] returns across the FFI.

use crate::domain::search::{HitKind, MatchKind, SearchHit, SnippetSegment};

/// One search result.
///
/// Flattened from [`SearchHit`] because uniffi has no enum-with-payload that
/// reads well in Swift here: `journal_date` is `Some` exactly when `kind` is
/// `journal`, and `emoji` and `folder_path` are `None` for anything but a
/// note.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    /// `note`, `journal`, `task` or `inbox`.
    pub kind: String,
    /// The journal's calendar date, and `None` for everything else. A journal
    /// entry has no title of its own (§A.5), so this is what names it.
    pub journal_date: Option<String>,
    /// The note's stored icon value verbatim (an emoji, or a desktop icon
    /// reference the shell may not draw), and `None` for everything else.
    pub emoji: Option<String>,
    /// The note's vault folder (`Work/Accounts`), `None` at the vault root and
    /// for everything that is not a note.
    pub folder_path: Option<String>,
    /// The bm25 score: negative, and more negative is a better match. Carried
    /// so a shell can show relevance if it wants to, never re-sorted — the
    /// order returned is already the ranking.
    pub score: f64,
    /// The body text around the match, highlighted runs marked (#4316). Plain
    /// runs only when the hit matched its title alone; empty when the body
    /// (a task's description) is.
    pub snippet: Vec<SnippetSegment>,
    /// Whether the index, the fuzzy title fallback or an alias found the hit
    /// (#4319). Only a body hit carries a snippet.
    pub match_kind: MatchKind,
    /// The alias the query matched, for a note or journal whose title does
    /// not hold the query. The row shows it as "also: <name>".
    pub matched_name: Option<String>,
}

impl From<SearchHit> for SearchResult {
    fn from(hit: SearchHit) -> Self {
        let (kind, journal_date, emoji, folder_path) = match hit.kind {
            HitKind::Note { emoji, folder_path } => ("note", None, emoji, folder_path),
            HitKind::Journal { date } => ("journal", Some(date), None, None),
            HitKind::Task => ("task", None, None, None),
            HitKind::Inbox => ("inbox", None, None, None),
        };
        Self {
            id: hit.id,
            title: hit.title,
            kind: kind.to_owned(),
            journal_date,
            emoji,
            folder_path,
            score: hit.score,
            snippet: hit.snippet,
            match_kind: hit.match_kind,
            matched_name: hit.matched_name,
        }
    }
}

/// One search's results by type. Each group is ranked on its own, because a
/// bm25 score is relative to the table it was computed over.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SearchGroups {
    pub notes: Vec<SearchResult>,
    pub journals: Vec<SearchResult>,
    pub tasks: Vec<SearchResult>,
    /// Captures in every state: filed, archived and snoozed ones too (#4320).
    pub inbox: Vec<SearchResult>,
}
