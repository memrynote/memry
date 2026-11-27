//! Where BlockNote's parser starts a block of its own, for the lines a custom
//! block opens on, `>` and `$$`: `packages/editor-schema/src/blocks/block-starts.ts`.
//!
//! The claims wanted a blank line above, so `# H\n> [!tip]\n> d` seeded a quote
//! holding the text `[!tip]`, and the canonical form's blank line made a
//! callout of it on the next seed.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::prepare::fence_line;
use super::shapes::{
    is_pipe_row, is_rule, is_setext_underline, is_table_separator, leading_ws, skip_chars,
    starts_list_item, starts_quote,
};

/// `HEADING`, `/^#{1,6}(?:\s|$)/`.
fn heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    (1..=6).contains(&hashes) && line[hashes..].chars().next().is_none_or(is_js_whitespace)
}

/// `/^\s+\S/`.
fn indented_text(line: &str) -> bool {
    let rest = line.trim_start_matches(is_js_whitespace);
    rest.len() < line.len() && !rest.is_empty()
}

/// `opensBlock`: whether `lines[i]` opens a block, `first` being the first line
/// the same parse reads (the lines above it belong to blocks already claimed).
///
/// A quote ends any paragraph, list item, heading or table above it, so `>`
/// opens a block unless the line above is its own quote's. Any other line opens
/// one where the block above takes no more lines: a heading, a thematic break,
/// a fence, a list item or a table. A paragraph and a quote's lazy lines take
/// it in.
pub(super) fn opens_block(lines: &[&str], i: usize, first: usize) -> bool {
    if i <= first {
        return true;
    }
    let above = lines[i - 1];
    if starts_quote(lines[i]) {
        return !starts_quote(above);
    }
    if js_trim(above).is_empty() || heading(above) || fence_line(above).is_some() || is_rule(above)
    {
        return true;
    }
    // An item's own lines are indented past its marker; a line flush left ends it.
    let mut item = i - 1;
    while item > first && indented_text(lines[item]) {
        item -= 1;
    }
    if starts_list_item(lines[item]) {
        return true;
    }
    // A table runs on while each line holds a pipe.
    let mut row = i - 1;
    while row > first && lines[row].contains('|') {
        if is_table_separator(lines[row]) && lines[row - 1].contains('|') {
            return true;
        }
        row -= 1;
    }
    false
}

/// `endsParagraphBefore`: BlockNote ends a paragraph before `line`, or before
/// a line that the `next` line underlines as a setext heading. A dashed rule
/// is left out, since under a paragraph it is a setext underline.
pub(super) fn ends_paragraph_before(line: Option<&str>, next: Option<&str>) -> bool {
    let Some(line) = line.filter(|line| !js_trim(line).is_empty()) else {
        return true;
    };
    // `/^\s{0,3}-+\s*$/`
    let lead = leading_ws(line);
    let rest = skip_chars(line, lead).trim_end_matches(is_js_whitespace);
    if lead <= 3 && !rest.is_empty() && rest.chars().all(|c| c == '-') {
        return false;
    }
    if next.is_some_and(is_setext_underline) {
        return true;
    }
    heading(line)
        || fence_line(line).is_some()
        || starts_quote(line)
        || is_rule(line)
        || starts_list_item(line)
        || is_pipe_row(line)
        // `/^\s{0,3}<!--/`
        || (lead <= 3 && skip_chars(line, lead).starts_with("<!--"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opens(source: &str, at: usize) -> bool {
        let lines: Vec<&str> = source.split('\n').collect();
        opens_block(&lines, at, 0)
    }

    #[test]
    fn a_quote_line_opens_a_block_unless_the_line_above_is_a_quote_line() {
        assert!(opens("one\n> a", 1));
        assert!(opens("# H\n> a", 1));
        assert!(!opens("> a\n> b", 1));
        assert!(opens("> a\nlazy\n> b", 2));
    }

    #[test]
    fn another_line_opens_a_block_where_the_block_above_is_closed() {
        assert!(opens("# H\n$$", 1));
        assert!(opens("- a\n  more\n$$", 2));
        assert!(opens("| a |\n|---|\n$$", 2));
        assert!(opens("```\nx\n```\n$$", 3));
        assert!(!opens("text\n$$", 1));
        assert!(!opens("| a |\n$$", 1));
        assert!(!opens("#######\n$$", 1));
    }

    #[test]
    fn a_paragraph_ends_before_a_block_but_a_dashed_rule_is_its_underline() {
        for line in ["", "# H", "```", "> q", "***", "- a", "| a |", "<!-- c -->"] {
            assert!(ends_paragraph_before(Some(line), None), "{line}");
        }
        assert!(ends_paragraph_before(None, None));
        assert!(!ends_paragraph_before(Some("---"), None));
        assert!(!ends_paragraph_before(Some("text"), None));
        assert!(!ends_paragraph_before(Some("text"), Some("text")));
        // A line the next one underlines is a heading of its own.
        assert!(ends_paragraph_before(Some("H"), Some("---")));
        assert!(ends_paragraph_before(Some("H"), Some("===  ")));
        assert!(!ends_paragraph_before(Some("---"), Some("---")));
    }
}
