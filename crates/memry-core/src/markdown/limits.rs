//! Nesting limits. The converter recurses once per level of nesting (blocks,
//! quotes, lists, HTML elements, Yjs elements), and a stack overflow aborts the
//! process, which `catch_unwind` cannot stop: a 1 KB body of `>` characters
//! would crash-loop the app through the vault watcher. Past [`MAX_NESTING_DEPTH`]
//! the conversion fails closed, as the TypeScript does on a `RangeError`
//! (`status: "error"` in the oracle): the caller keeps the file.
//!
//! Real notes nest a few levels. The cap is far above that and far below the
//! depth at which a 2 MiB thread stack overflows in a debug build.

use yrs::{ReadTxn, XmlFragment, XmlFragmentRef, XmlOut};

pub const MAX_NESTING_DEPTH: usize = 100;

/// Largest `colspan` or `rowspan` a table cell may claim. The TypeScript
/// answers a 100000-column span and fails on a million (oracle cases in
/// `markdown_depth.rs`), and a span costs memory in proportion to itself.
pub const MAX_TABLE_SPAN: usize = 100_000;

/// Largest table grid (rows x columns, spans included) the converter builds.
pub const MAX_TABLE_CELLS: usize = 4_000_000;

/// True when a line of `markdown` opens more than [`MAX_NESTING_DEPTH`] levels
/// of block quotes and list indentation. A cheap scan, run before any parse.
pub fn markdown_nests_too_deep(markdown: &str) -> bool {
    markdown.lines().any(|line| {
        let mut rest = line;
        let mut indent = 0usize;
        let mut quotes = 0usize;
        loop {
            let trimmed = rest.trim_start_matches([' ', '\t']);
            indent += rest[..rest.len() - trimmed.len()]
                .bytes()
                .map(|b| if b == b'\t' { 4 } else { 1 })
                .sum::<usize>();
            match trimmed.strip_prefix('>') {
                Some(after) => {
                    quotes += 1;
                    if quotes > MAX_NESTING_DEPTH {
                        return true;
                    }
                    rest = after;
                }
                None => {
                    rest = trimmed;
                    break;
                }
            }
        }
        let is_item = rest.starts_with(['-', '*', '+'])
            || rest
                .trim_start_matches(|c: char| c.is_ascii_digit())
                .starts_with('.');
        is_item && quotes + indent / 2 > MAX_NESTING_DEPTH
    })
}

/// True when the fragment's element tree is deeper than [`MAX_NESTING_DEPTH`].
/// Iterative, so it is safe to run on a tree of any depth.
pub fn fragment_too_deep<T: ReadTxn>(txn: &T, fragment: &XmlFragmentRef) -> bool {
    let mut stack: Vec<(XmlOut, usize)> = fragment.children(txn).map(|c| (c, 1)).collect();
    while let Some((node, depth)) = stack.pop() {
        if depth > MAX_NESTING_DEPTH {
            return true;
        }
        if let XmlOut::Element(element) = node {
            stack.extend(element.children(txn).map(|c| (c, depth + 1)));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_and_indented_items_are_counted() {
        assert!(!markdown_nests_too_deep(&">".repeat(100)));
        assert!(markdown_nests_too_deep(&">".repeat(101)));
        assert!(markdown_nests_too_deep(&"> ".repeat(1000)));
        assert!(markdown_nests_too_deep(&format!("{}- x", " ".repeat(400))));
        assert!(!markdown_nests_too_deep(&format!(
            "{}text",
            " ".repeat(400)
        )));
        assert!(!markdown_nests_too_deep("- a\n  - b\n    - c"));
    }
}
