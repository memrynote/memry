//! Streaming literal search over a large-file-class vault file (`vault/large-file-search.ts`).
//! Large files never enter the search index, so this is the only way to find anything in one.
//!
//! Bytes, not text: matching encoded bytes never decodes a window, and UTF-8 is
//! self-synchronising, so a valid encoded query only aligns with whole characters. Case folding
//! is ASCII-only (`aho-corasick`'s `ascii_case_insensitive`), which never changes a length and
//! never touches a byte of a multi-byte sequence; 'É' does not match 'é'. Each hit is a line and
//! which occurrence on that line it is, counted with the same fold and the same non-overlapping
//! advance the renderer uses to highlight the line text it already holds.

use std::io;

use aho_corasick::{AhoCorasick, Input, MatchKind};

use super::reader::PositionalRead;

/// Window one pass reads at a time. Matches the line-index scan's window.
pub const SEARCH_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Hit positions kept for navigation. The count is exact regardless; only the navigable list is
/// bounded, since a 2 GB file searched for `e` holds hundreds of millions of matches.
pub const MAX_SEARCH_HITS: usize = 2000;

const NEWLINE: u8 = b'\n';
const CARRIAGE_RETURN: u8 = b'\r';

/// One match: which line, and which occurrence on that line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
pub struct LargeFileHit {
    pub line: u64,
    pub ordinal: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct SearchOptions {
    pub chunk_bytes: usize,
    pub max_hits: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            chunk_bytes: SEARCH_CHUNK_BYTES,
            max_hits: MAX_SEARCH_HITS,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Found {
    pub hits: Vec<LargeFileHit>,
    /// Every match in the file, the ones past `max_hits` too.
    pub total: u64,
    /// True when `hits` was cut at `max_hits` and `total` is larger.
    pub limited: bool,
    pub cancelled: bool,
    pub bytes_searched: u64,
}

/// One streaming pass, counting every match of `query` and keeping the first `max_hits`. `stop`
/// is asked before every window (a superseded query stops within one read); `progress` hears the
/// bytes searched and the count so far after every window.
pub fn find_matches<R: PositionalRead + ?Sized>(
    read: &R,
    query: &str,
    options: SearchOptions,
    stop: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> io::Result<Found> {
    let needle = query.as_bytes();
    // A query spanning lines has no position the viewer could point at, and a match holding no
    // newline is what lets a match never span two lines below.
    if needle.is_empty() || needle.contains(&NEWLINE) || needle.contains(&CARRIAGE_RETURN) {
        return Ok(Found::default());
    }
    let finder = AhoCorasick::builder()
        .ascii_case_insensitive(true)
        .match_kind(MatchKind::LeftmostFirst)
        .build([needle])
        .map_err(io::Error::other)?;

    // The overlap carried between windows is one byte short of the query, so a match straddling
    // a boundary is seen whole exactly once.
    let carry = needle.len() - 1;
    let chunk_bytes = options.chunk_bytes.max(needle.len() * 2);
    let mut window = vec![0u8; carry + chunk_bytes];

    let mut found = Found::default();
    let mut line: u64 = 0;
    let mut ordinal: u64 = 0;
    let mut position: u64 = 0;
    let mut carry_len = 0usize;
    // Absolute offset matching resumes from. Matches do not overlap, so a counted match consumes
    // its bytes, and carrying this across windows keeps a window's tail from reporting what the
    // head of the next one reports.
    let mut resume_at: u64 = 0;

    loop {
        if stop() {
            found.cancelled = true;
            break;
        }
        let read_bytes = read.read_at(&mut window[carry_len..carry_len + chunk_bytes], position)?;
        if read_bytes == 0 {
            break;
        }
        let view = &window[..carry_len + read_bytes];
        let view_start = position - carry_len as u64;
        // Newlines in the carry were counted with the previous window.
        let mut newline_from = carry_len;
        let match_from = usize::try_from(resume_at.saturating_sub(view_start))
            .unwrap_or(usize::MAX)
            .min(view.len());

        for hit in finder.find_iter(Input::new(view).span(match_from..view.len())) {
            if hit.start() > newline_from {
                let newlines =
                    memchr::memchr_iter(NEWLINE, &view[newline_from..hit.start()]).count();
                if newlines > 0 {
                    line += newlines as u64;
                    ordinal = 0;
                }
            }
            found.total += 1;
            if found.hits.len() < options.max_hits {
                found.hits.push(LargeFileHit { line, ordinal });
            }
            ordinal += 1;
            // A match holds no newline, so nothing it covers is a line end.
            newline_from = newline_from.max(hit.end());
            resume_at = view_start + hit.end() as u64;
        }
        let newlines = memchr::memchr_iter(NEWLINE, &view[newline_from..]).count();
        if newlines > 0 {
            line += newlines as u64;
            ordinal = 0;
        }

        position += read_bytes as u64;
        let view_len = view.len();
        let next_carry = carry.min(view_len);
        window.copy_within(view_len - next_carry..view_len, 0);
        carry_len = next_carry;
        progress(position, found.total);
    }

    found.limited = found.total > found.hits.len() as u64;
    found.bytes_searched = position;
    Ok(found)
}
