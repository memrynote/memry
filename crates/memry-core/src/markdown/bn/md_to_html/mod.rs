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

pub fn markdown_to_html(markdown: &str) -> String {
    emit::tokens_to_html(&block::tokenize(markdown))
}
