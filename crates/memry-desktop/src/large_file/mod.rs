//! The read-only streaming viewer of large-file-class vault files (Step 14g, #3531): the port of
//! `vault/large-file-session.ts` and its index and search workers.
//!
//! A session is one open file plus the sparse line-offset index built for it. Nothing reads the
//! file as a whole: the open measures it through its handle, the index scan runs on its own
//! thread and streams, and every read is a window at a byte offset ([`reader`]). Memory stays a
//! few windows per session whatever the file size, up to [`VIEWER_MAX_BYTES`].
//!
//! Each open is a lease with its own event sink: two windows on one note, or a remount that opens
//! before the outgoing mount closes, share the file and its index, and each hears the scan on its
//! own channel. The session goes when its last lease closes.

pub mod index;
pub mod reader;
pub mod search;
mod sessions;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, FailureKind};
use crate::notes::error::NotesError;

pub use search::LargeFileHit;
pub use sessions::{EventSink, LargeFiles, ProgressSink};

/// Hard ceiling on what the viewer opens: SQLite's `MAX_LENGTH`, the largest value the rest of
/// the app can carry for one file (`large-file-session.ts:46`).
pub const VIEWER_MAX_BYTES: u64 = 2_147_483_645;

/// Sessions kept open at once. Each pins one OS file handle.
pub const MAX_OPEN_SESSIONS: usize = 4;

/// Most lines one page read may ask for: a screenful and its overscan, never the file.
pub const MAX_PAGE_LINES: u32 = 2000;

/// Longest query, in UTF-16 code units as the renderer counts it. The search carries one query
/// length between windows, so the query is part of the memory bound.
pub const MAX_QUERY_UNITS: usize = 200;

/// The answer to opening a large file. `too-large` carries the ceiling as well as the size, so
/// the renderer never restates a limit this side owns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "status")]
pub enum LargeFileOpenResult {
    #[serde(rename = "indexing", rename_all = "camelCase")]
    Indexing { session_id: String, file_bytes: u64 },
    #[serde(rename = "ready", rename_all = "camelCase")]
    Ready {
        session_id: String,
        file_bytes: u64,
        line_count: u64,
    },
    #[serde(rename = "too-large", rename_all = "camelCase")]
    TooLarge { file_bytes: u64, max_bytes: u64 },
    #[serde(rename = "missing")]
    Missing,
}

/// The index scan of one session, on the channel its open passed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "status")]
pub enum LargeFileEvent {
    #[serde(rename = "scanning", rename_all = "camelCase")]
    Scanning {
        session_id: String,
        bytes_scanned: u64,
        file_bytes: u64,
    },
    #[serde(rename = "ready", rename_all = "camelCase")]
    Ready {
        session_id: String,
        file_bytes: u64,
        line_count: u64,
    },
    #[serde(rename = "error", rename_all = "camelCase")]
    Error { session_id: String, message: String },
    // The session went away while this lease still held it: the file changed on disk, or the
    // handle was needed for another file. Nothing failed; reopening resolves it. (A plain
    // comment: a doc comment on a variant breaks the generated union's line.)
    #[serde(rename = "closed", rename_all = "camelCase")]
    Closed { session_id: String },
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileReadLinesInput {
    pub session_id: String,
    pub start_line: u64,
    pub count: u32,
}

/// One page of lines. `lines.len()` says where it ended; `count` was a ceiling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileLines {
    pub start_line: u64,
    pub lines: Vec<String>,
    /// Absolute line numbers cut at the per-line byte cap.
    pub truncated: Vec<u64>,
    pub line_count: u64,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileSearchInput {
    pub session_id: String,
    pub query: String,
}

/// The end of one search. `hits` is capped for navigation while `total` counts every match.
/// `cancelled` is a query a newer one (or a close) superseded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "status")]
pub enum LargeFileSearchResult {
    #[serde(rename = "complete")]
    Complete {
        query: String,
        hits: Vec<LargeFileHit>,
        total: u64,
        // True when `hits` was cut short and `total` is the larger truth.
        limited: bool,
    },
    #[serde(rename = "cancelled")]
    Cancelled { query: String },
}

/// A count still growing, on the channel the search passed. Never a final answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileSearchProgress {
    pub session_id: String,
    pub query: String,
    pub bytes_searched: u64,
    pub file_bytes: u64,
    /// Matches found so far.
    pub total: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum LargeFileError {
    #[error(transparent)]
    Notes(#[from] NotesError),
    #[error("a page read asks for 1 to {MAX_PAGE_LINES} lines")]
    PageSize,
    #[error("a search query is 1 to {MAX_QUERY_UNITS} characters")]
    Query,
    #[error("the large file could not be read: {0}")]
    Io(#[from] std::io::Error),
}

impl CoreError for LargeFileError {
    fn kind_and_code(&self) -> (FailureKind, &'static str) {
        match self {
            Self::Notes(error) => error.kind_and_code(),
            Self::PageSize | Self::Query => (FailureKind::Invalid, "large_file_invalid_input"),
            Self::Io(_) => (FailureKind::Storage, "large_file_io"),
        }
    }
}
