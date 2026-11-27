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

/// What [`opens_block`] reads of the run's lines above the line it asks about,
/// kept as each line joins the run. Reading it back through the run for every
/// line costs a pass per line, quadratic in a long table or indented item.
#[derive(Default)]
pub(super) struct Above {
    /// The last line not indented past a marker starts a list item.
    item: bool,
    /// The last line is in a table: a run of pipe lines back to a delimiter
    /// row under a pipe line.
    table: bool,
}

impl Above {
    /// Takes `lines[i]` into the run. `first` is whether it is the run's
    /// first line.
    pub(super) fn take(&mut self, lines: &[&str], i: usize, first: bool) {
        let line = lines[i];
        // An item's own lines are indented past its marker; a line flush left
        // ends it.
        if first || !indented_text(line) {
            self.item = starts_list_item(line);
        }
        // A table runs on while each line holds a pipe.
        self.table = !first
            && line.contains('|')
            && ((is_table_separator(line) && lines[i - 1].contains('|')) || self.table);
    }
}

/// `opensBlock`: whether `lines[i]` opens a block, `first` being the first line
/// the same parse reads (the lines above it belong to blocks already claimed)
/// and `above` the lines from there to `lines[i - 1]`.
///
/// A quote ends any paragraph, list item, heading or table above it, so `>`
/// opens a block unless the line above is its own quote's. Any other line opens
/// one where the block above takes no more lines: a heading, a thematic break,
/// a fence, a list item or a table. A paragraph and a quote's lazy lines take
/// it in.
pub(super) fn opens_block(lines: &[&str], i: usize, first: usize, above: &Above) -> bool {
    if i <= first {
        return true;
    }
    let previous = lines[i - 1];
    if starts_quote(lines[i]) {
        return !starts_quote(previous);
    }
    js_trim(previous).is_empty()
        || heading(previous)
        || fence_line(previous).is_some()
        || is_rule(previous)
        || above.item
        || above.table
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
        let mut above = Above::default();
        for i in 0..at {
            above.take(&lines, i, i == 0);
        }
        opens_block(&lines, at, 0, &above)
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
