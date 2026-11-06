//! The in-file search of the large-file viewer (`vault/large-file-search.test.ts`), over a slice
//! reader at window sizes that put matches across window boundaries.
//!
//! | Test                                                     | Rule                                  |
//! | -------------------------------------------------------- | ------------------------------------- |
//! | hits match a plain per-line search (property)            | the renderer's re-find agrees         |
//! | case folds ASCII only                                    | 'É' does not match 'é'                |
//! | a match across a window boundary counts once             | the carry                             |
//! | the hit list stops at its cap while the total is true    | `MAX_SEARCH_HITS`                     |
//! | a query holding a line break finds nothing               | a hit is a line and an ordinal        |
//! | a stopped search is cancelled                            | a newer query supersedes it           |
//! | the search reads each byte once                          | one pass                              |

use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::large_file::LargeFileHit;
use memry_desktop::large_file::reader::PositionalRead;
use memry_desktop::large_file::search::{Found, SearchOptions, find_matches};
use memry_test_kit::proptest_config;
use proptest::prelude::*;

fn search(text: &str, query: &str, chunk_bytes: usize, max_hits: usize) -> Found {
    let options = SearchOptions {
        chunk_bytes,
        max_hits,
    };
    find_matches(text.as_bytes(), query, options, &|| false, &mut |_, _| {}).unwrap()
}

fn fold(text: &str) -> String {
    text.to_ascii_lowercase()
}

/// What the viewer's `HighlightedLine` finds: per line, the ASCII-folded, non-overlapping
/// occurrences from the left.
fn plain_hits(text: &str, query: &str) -> Vec<LargeFileHit> {
    let needle = fold(query);
    let mut hits = Vec::new();
    for (line, content) in text.split('\n').enumerate() {
        let haystack = fold(content);
        let mut from = 0;
        let mut ordinal = 0;
        while let Some(at) = haystack[from..].find(&needle) {
            hits.push(LargeFileHit {
                line: line as u64,
                ordinal,
            });
            ordinal += 1;
            from += at + needle.len();
        }
    }
    hits
}

fn hit(line: u64, ordinal: u64) -> LargeFileHit {
    LargeFileHit { line, ordinal }
}

proptest! {
    #![proptest_config(proptest_config(64))]

    #[test]
    fn hits_match_a_plain_per_line_search(
        text in "[aAbB\\n]{0,200}",
        query in "[aAbB]{1,4}",
        chunk in 1usize..12,
        max_hits in 0usize..30,
    ) {
        let found = search(&text, &query, chunk, max_hits);
        let all = plain_hits(&text, &query);
        prop_assert_eq!(found.total, all.len() as u64);
        prop_assert_eq!(&found.hits[..], &all[..all.len().min(max_hits)]);
        prop_assert_eq!(found.limited, all.len() > max_hits);
        prop_assert!(!found.cancelled);
        prop_assert_eq!(found.bytes_searched, text.len() as u64);
    }
}

#[test]
fn case_folds_ascii_only() {
    let found = search("Hello HELLO\nhello", "hElLo", 4, 10);
    assert_eq!(found.hits, [hit(0, 0), hit(0, 1), hit(1, 0)]);
    assert_eq!(search("Éclair éclair", "éclair", 4, 10).hits, [hit(0, 0)]);
    assert_eq!(search("çay ÇAY", "ÇAY", 3, 10).hits, [hit(0, 0)]);
}

#[test]
fn a_match_across_a_window_boundary_counts_once() {
    // "needle" spans the 8-byte window boundary in each line.
    let text = "xxxxxneedle\nyyyyyyneedleneedle\n";
    let found = search(text, "needle", 8, 10);
    assert_eq!(found.hits, [hit(0, 0), hit(1, 0), hit(1, 1)]);
    // Non-overlapping: "aaaa" holds two "aa", not three.
    assert_eq!(search("aaaa", "aa", 1, 10).total, 2);
}

#[test]
fn the_hit_list_stops_at_its_cap_while_the_total_is_true() {
    let text = "e".repeat(5000);
    let found = search(&text, "e", 64, 2000);
    assert_eq!(found.hits.len(), 2000);
    assert_eq!(found.total, 5000);
    assert!(found.limited);
    assert_eq!(found.hits[1999], hit(0, 1999));
}

#[test]
fn a_query_holding_a_line_break_finds_nothing() {
    for query in ["a\nb", "a\r", ""] {
        let found = search("a\nb a\r", query, 4, 10);
        assert_eq!(found, Found::default(), "{query:?}");
    }
}

#[test]
fn a_stopped_search_is_cancelled() {
    let windows = AtomicUsize::new(0);
    let stop = || windows.fetch_add(1, Ordering::Relaxed) >= 2;
    let mut seen = Vec::new();
    let options = SearchOptions {
        chunk_bytes: 4,
        max_hits: 100,
    };
    let text = "ab\n".repeat(100);
    let found = find_matches(text.as_bytes(), "b", options, &stop, &mut |bytes, total| {
        seen.push((bytes, total))
    })
    .unwrap();
    assert!(found.cancelled);
    assert_eq!(seen, [(4, 1), (8, 3)]);
}

struct Counting {
    bytes: Vec<u8>,
    read_bytes: AtomicUsize,
}

impl PositionalRead for Counting {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        let n = self.bytes.read_at(buf, offset)?;
        self.read_bytes.fetch_add(n, Ordering::Relaxed);
        Ok(n)
    }
}

#[test]
fn the_search_reads_each_byte_once() {
    let reader = Counting {
        bytes: "some text with a word\n".repeat(5000).into_bytes(),
        read_bytes: AtomicUsize::new(0),
    };
    let options = SearchOptions {
        chunk_bytes: 1000,
        max_hits: 10,
    };
    let found = find_matches(&reader, "word", options, &|| false, &mut |_, _| {}).unwrap();
    assert_eq!(found.total, 5000);
    assert_eq!(found.hits[9], hit(9, 0));
    assert_eq!(
        reader.read_bytes.load(Ordering::Relaxed),
        reader.bytes.len()
    );
}
