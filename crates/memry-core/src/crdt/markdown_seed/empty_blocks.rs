//! Empty items and headings: `packages/editor-schema/src/empty-blocks.ts`.
//!
//! BlockNote's parser wants text after a list marker or a heading's `#`, and
//! reads a line with none as a paragraph of the marker. Desktop gives each
//! such line a placeholder word for the parser to hold, and takes it back out
//! of the blocks afterwards ([`mask_empty_block_lines`],
//! [`drop_empty_block_placeholders`]). `document_fallback` keeps `MEMRY` out
//! of the source, so the word is never text the author wrote.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::markers::FenceTracker;
use super::{SeedBlock, SeedInline, SeedKind};

const PLACEHOLDER: &str = "MEMRYEMBCORE";

/// `markdown` with the placeholder on each empty item or heading line. An item
/// line counts only where a list item can start without ending a paragraph:
/// after a blank line or another item. Lines in a fence are left alone.
pub(super) fn mask_empty_block_lines(markdown: &str) -> String {
    let mut fence = FenceTracker::default();
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut out = Vec::with_capacity(lines.len());
    for (index, line) in lines.iter().enumerate() {
        if fence.consume(line) {
            out.push((*line).to_owned());
            continue;
        }
        let opens = index
            .checked_sub(1)
            .is_none_or(|before| js_trim(lines[before]).is_empty() || is_item_line(lines[before]));
        if is_empty_heading(line) || (opens && is_empty_item(line)) {
            out.push(format!(
                "{} {PLACEHOLDER}",
                line.trim_end_matches(is_js_whitespace)
            ));
        } else {
            out.push((*line).to_owned());
        }
    }
    out.join("\n")
}

/// `blocks` with every placeholder `mask_empty_block_lines` added taken back
/// out, an item or a heading left with no content.
pub(super) fn drop_empty_block_placeholders(blocks: &mut [SeedBlock]) {
    for block in blocks {
        if let [SeedInline::Text { text, .. }] = block.content.as_slice()
            && js_trim(text) == PLACEHOLDER
        {
            block.content.clear();
        }
        drop_empty_block_placeholders(&mut block.children);
    }
}

/// Whether a placeholder is still in some block's text after
/// [`drop_empty_block_placeholders`]: a marker line that sat inside a
/// paragraph, which desktop leaves as text with its per-process word. The
/// seed keeps such a chunk literal rather than build that text.
pub(super) fn leaks_placeholder(blocks: &[SeedBlock]) -> bool {
    let text_holds = |content: &[SeedInline]| {
        content.iter().any(
            |piece| matches!(piece, SeedInline::Text { text, .. } if text.contains(PLACEHOLDER)),
        )
    };
    blocks.iter().any(|block| {
        let cells = match &block.kind {
            SeedKind::Table { rows } => rows
                .iter()
                .flat_map(|row| &row.cells)
                .any(|cell| text_holds(&cell.content)),
            _ => false,
        };
        cells || text_holds(&block.content) || leaks_placeholder(&block.children)
    })
}

fn blank(c: char) -> bool {
    matches!(c, ' ' | '\t')
}

/// `/^#{1,6}[ \t]*$/`: flush left, since BlockNote reads an indented `#` as
/// paragraph text.
fn is_empty_heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    (1..=6).contains(&hashes) && line[hashes..].chars().all(blank)
}

/// The text after a list marker, and whether the marker is a bullet:
/// `/^[ \t]*(?:[-*+]|\d{1,9}[.)])/`.
fn after_marker(line: &str) -> Option<(&str, bool)> {
    let rest = line.trim_start_matches(blank);
    if let Some(after) = rest.strip_prefix(['-', '*', '+']) {
        return Some((after, true));
    }
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if (1..=9).contains(&digits) {
        return rest[digits..]
            .strip_prefix(['.', ')'])
            .map(|after| (after, false));
    }
    None
}

/// `/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/`.
fn is_item_line(line: &str) -> bool {
    after_marker(line).is_some_and(|(after, _)| after.is_empty() || after.starts_with(blank))
}

/// `/^[ \t]*(?:[-*+](?: \[[ xX]\])?|\d{1,9}[.)])[ \t]*$/`: a to-do box
/// only after a bullet.
fn is_empty_item(line: &str) -> bool {
    let Some((after, bullet)) = after_marker(line) else {
        return false;
    };
    let boxed = bullet
        .then(|| after.strip_prefix(" ["))
        .flatten()
        .and_then(|rest| rest.strip_prefix([' ', 'x', 'X']))
        .and_then(|rest| rest.strip_prefix(']'));
    boxed.unwrap_or(after).chars().all(blank)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_line_gets_the_placeholder_only_where_it_opens_a_block() {
        let word = |line: &str| format!("{line} {PLACEHOLDER}");
        assert_eq!(mask_empty_block_lines("#"), word("#"));
        assert_eq!(mask_empty_block_lines("## "), word("##"));
        assert_eq!(mask_empty_block_lines("- [x] "), word("- [x]"));
        assert_eq!(
            mask_empty_block_lines("1.\n2."),
            format!("{}\n{}", word("1."), word("2."))
        );
        assert_eq!(mask_empty_block_lines("text\n-"), "text\n-");
        assert_eq!(
            mask_empty_block_lines("text\n#"),
            format!("text\n{}", word("#"))
        );
        assert_eq!(mask_empty_block_lines("```\n-\n```"), "```\n-\n```");
        assert_eq!(mask_empty_block_lines("####### "), "####### ");
        assert_eq!(mask_empty_block_lines("- a b"), "- a b");
        assert_eq!(mask_empty_block_lines("1. [ ]"), "1. [ ]");
    }

    #[test]
    fn only_a_flush_left_hash_is_an_empty_heading() {
        assert_eq!(mask_empty_block_lines(" #"), " #");
        assert_eq!(mask_empty_block_lines("   ##\t"), "   ##\t");
        assert_eq!(mask_empty_block_lines("a  \n #"), "a  \n #");
    }

    #[test]
    fn a_placeholder_left_in_text_is_seen_and_empty_blocks_lose_theirs() {
        let leaked = [SeedBlock::literal(&format!("a {PLACEHOLDER}"))];
        assert!(leaks_placeholder(&leaked));
        let (mut blocks, mut fallbacks) = (Vec::new(), Vec::new());
        crate::crdt::markdown_seed::blocks::parse_chunk("#\n\n-\n- a", &mut blocks, &mut fallbacks);
        assert!(fallbacks.is_empty());
        assert!(blocks.iter().take(2).all(|block| block.content.is_empty()));
    }
}
