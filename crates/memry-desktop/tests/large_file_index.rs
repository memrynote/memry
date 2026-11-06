//! The sparse line-offset index and the page reads of the large-file viewer
//! (`vault/large-file-index.test.ts`), over a slice reader at window sizes that cross many
//! windows.
//!
//! | Test                                                      | Rule                                  |
//! | --------------------------------------------------------- | ------------------------------------- |
//! | lines and pages match a plain split (property)            | the index and reads are exact         |
//! | a trailing newline closes the last line                   | "a\nb\n" is two lines                 |
//! | the table stays under its cap and the stride doubles      | 512 KB whatever the file              |
//! | a CRLF file reads without the carriage return             | `decodeLine`                          |
//! | a character split across two windows decodes whole        | decode after the line is complete     |
//! | a line past the cap comes back cut and reported           | `MAX_LINE_BYTES`                      |
//! | a page ends at its byte budget, never empty               | `LARGE_FILE_PAGE_BYTES`               |
//! | a page of a one-line file reads one cut line's windows    | no read to the end of a cut last line |
//! | the scan reads each byte once                             | one pass                              |
//! | a stopped scan returns nothing                            | eviction stops the scan               |

use std::sync::atomic::{AtomicUsize, Ordering};

use memry_desktop::large_file::index::{
    LineIndex, ReadOptions, ScanOptions, read_lines, scan_line_index,
};
use memry_desktop::large_file::reader::PositionalRead;
use memry_test_kit::proptest_config;
use proptest::prelude::*;

/// A slice reader that counts its reads and the bytes they returned.
struct Counting {
    bytes: Vec<u8>,
    reads: AtomicUsize,
    read_bytes: AtomicUsize,
}

impl Counting {
    fn new(bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            bytes: bytes.into(),
            reads: AtomicUsize::new(0),
            read_bytes: AtomicUsize::new(0),
        }
    }
}

impl PositionalRead for Counting {
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
        let n = self.bytes.read_at(buf, offset)?;
        self.reads.fetch_add(1, Ordering::Relaxed);
        self.read_bytes.fetch_add(n, Ordering::Relaxed);
        Ok(n)
    }
}

fn scan(bytes: &[u8], chunk_bytes: usize, max_checkpoints: usize) -> LineIndex {
    let options = ScanOptions {
        chunk_bytes,
        max_checkpoints,
    };
    scan_line_index(bytes, options, &|| false, &mut |_| {})
        .unwrap()
        .expect("not stopped")
}

fn small_reads() -> ReadOptions {
    ReadOptions {
        chunk_bytes: 7,
        max_line_bytes: 1 << 20,
        max_bytes: 1 << 20,
    }
}

/// The lines a text editor shows: split on `\n`, a trailing newline opening no line.
fn plain_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    body.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_owned())
        .collect()
}

proptest! {
    #![proptest_config(proptest_config(64))]

    #[test]
    fn lines_and_pages_match_a_plain_split(
        text in "[ab\\n\\r]{0,300}",
        chunk in 1usize..9,
        cap in 1usize..6,
        start in 0u64..80,
        count in 1usize..40,
    ) {
        let index = scan(text.as_bytes(), chunk, cap);
        let lines = plain_lines(&text);
        prop_assert_eq!(index.line_count, lines.len() as u64);
        prop_assert!(index.checkpoints.len() <= cap);
        for (i, offset) in index.checkpoints.iter().enumerate() {
            let line = i as u64 * index.stride;
            prop_assert!(line < index.line_count);
            let expected: usize = text.split_inclusive('\n').take(line as usize).map(str::len).sum();
            prop_assert_eq!(*offset, expected as u64);
        }
        let page = read_lines(text.as_bytes(), &index, start, count, small_reads()).unwrap();
        let wanted: Vec<String> = lines.iter().skip(start as usize).take(count).cloned().collect();
        prop_assert_eq!(page.lines, wanted);
        prop_assert!(page.truncated.is_empty());
    }
}

#[test]
fn a_trailing_newline_closes_the_last_line() {
    assert_eq!(scan(b"a\nb\n", 3, 8).line_count, 2);
    assert_eq!(scan(b"a\nb", 3, 8).line_count, 2);
    assert_eq!(scan(b"\n", 3, 8).line_count, 1);
    assert_eq!(scan(b"", 3, 8).line_count, 0);
    assert!(scan(b"", 3, 8).checkpoints.is_empty());
}

#[test]
fn the_table_stays_under_its_cap_and_the_stride_doubles() {
    let text = "x\n".repeat(1000);
    let index = scan(text.as_bytes(), 64, 16);
    assert!(index.checkpoints.len() <= 16, "{}", index.checkpoints.len());
    assert_eq!(index.stride, 64);
    assert_eq!(index.line_count, 1000);
    let page = read_lines(text.as_bytes(), &index, 777, 3, small_reads()).unwrap();
    assert_eq!(page.lines, ["x", "x", "x"]);
    assert_eq!(page.start_line, 777);
}

#[test]
fn a_crlf_file_reads_without_the_carriage_return() {
    let text = b"one\r\ntwo\r\nthree";
    let index = scan(text, 4, 8);
    let page = read_lines(&text[..], &index, 0, 10, small_reads()).unwrap();
    assert_eq!(page.lines, ["one", "two", "three"]);
}

#[test]
fn a_character_split_across_two_windows_decodes_whole() {
    let text = "ağaç\nçiçek\n日本語\n";
    let index = scan(text.as_bytes(), 1, 8);
    let options = ReadOptions {
        chunk_bytes: 1,
        ..small_reads()
    };
    let page = read_lines(text.as_bytes(), &index, 0, 10, options).unwrap();
    assert_eq!(page.lines, ["ağaç", "çiçek", "日本語"]);
}

#[test]
fn a_line_past_the_cap_comes_back_cut_and_reported() {
    let text = format!("short\n{}\nafter\n", "y".repeat(50));
    let index = scan(text.as_bytes(), 8, 8);
    let options = ReadOptions {
        chunk_bytes: 8,
        max_line_bytes: 10,
        max_bytes: 1 << 20,
    };
    let page = read_lines(text.as_bytes(), &index, 0, 10, options).unwrap();
    assert_eq!(page.lines, ["short", "yyyyyyyyyy", "after"]);
    assert_eq!(page.truncated, [1]);
}

#[test]
fn a_page_ends_at_its_byte_budget_never_empty() {
    let text = format!("{}\n", "z".repeat(30)).repeat(20);
    let index = scan(text.as_bytes(), 16, 64);
    let options = ReadOptions {
        chunk_bytes: 16,
        max_line_bytes: 1 << 20,
        max_bytes: 100,
    };
    let page = read_lines(text.as_bytes(), &index, 0, 200, options).unwrap();
    // 30 + 30 + 30 is under 100, the fourth line reaches it.
    assert_eq!(page.lines.len(), 4);
    let alone = ReadOptions {
        max_bytes: 10,
        ..options
    };
    let page = read_lines(text.as_bytes(), &index, 5, 200, alone).unwrap();
    assert_eq!(
        page.lines.len(),
        1,
        "a line over the budget still comes back"
    );
}

#[test]
fn a_page_of_a_one_line_file_reads_one_cut_lines_windows() {
    let reader = Counting::new("m".repeat(100_000));
    let index = scan(&reader.bytes, 4096, 8);
    assert_eq!(index.line_count, 1);
    let options = ReadOptions {
        chunk_bytes: 100,
        max_line_bytes: 1000,
        max_bytes: 1 << 20,
    };
    let page = read_lines(&reader, &index, 0, 200, options).unwrap();
    assert_eq!(page.lines, ["m".repeat(1000)]);
    assert_eq!(page.truncated, [0]);
    let bound = 1000 / 100 + 1;
    let reads = reader.reads.load(Ordering::Relaxed);
    assert!(
        reads <= bound,
        "{reads} reads for one cut line, bound {bound}"
    );
}

#[test]
fn the_scan_reads_each_byte_once() {
    let reader = Counting::new("line of text\n".repeat(10_000));
    let options = ScanOptions {
        chunk_bytes: 1000,
        max_checkpoints: 64,
    };
    let index = scan_line_index(&reader, options, &|| false, &mut |_| {})
        .unwrap()
        .unwrap();
    assert_eq!(index.line_count, 10_000);
    let len = reader.bytes.len();
    assert_eq!(reader.read_bytes.load(Ordering::Relaxed), len);
    assert_eq!(reader.reads.load(Ordering::Relaxed), len.div_ceil(1000) + 1);
}

#[test]
fn a_stopped_scan_returns_nothing() {
    let reader = Counting::new("x\n".repeat(1000));
    let options = ScanOptions {
        chunk_bytes: 10,
        max_checkpoints: 64,
    };
    let windows = AtomicUsize::new(0);
    let stop = || windows.fetch_add(1, Ordering::Relaxed) >= 3;
    let mut progress = Vec::new();
    let scanned = scan_line_index(&reader, options, &stop, &mut |bytes| progress.push(bytes));
    assert!(scanned.unwrap().is_none());
    assert_eq!(progress, [10, 20, 30]);
    assert_eq!(reader.reads.load(Ordering::Relaxed), 3);
}
