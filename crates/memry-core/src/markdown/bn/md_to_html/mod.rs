//! Port of BlockNote 0.54.2 `markdownToHtml`
//! (`api/parsers/markdown/markdownToHtml.ts`), byte for byte.
//!
//! Every JS regex of the source is a hand-written scanner in `scan.rs` or
//! `inline.rs`; `\s`, `trim` and `.` follow JS semantics, not Rust's.

mod block;
mod emit;
mod inline;
mod scan;
mod video;

use crate::markdown::limits::take_exceeded;

/// `None` when quotes, lists or inline constructs nest deeper than the
/// limits of [`crate::markdown::limits`]: the TypeScript throws a `RangeError`
/// there, and the stack would overflow here.
pub fn markdown_to_html(markdown: &str) -> Option<String> {
    take_exceeded();
    let html = emit::tokens_to_html(&block::tokenize(markdown));
    (!take_exceeded()).then_some(html)
}
