//! Obsidian `%% … %%` comments, masked before any line is split
//! (`shared/src/html-comments.ts` `maskHtmlComments`, which walks the note with
//! `shared/src/markdown-code.ts` `walkMarkdown`).
//!
//! Desktop turns each comment into one word the parser cannot touch, and into
//! an `htmlComment` node once the blocks exist, so a comment holding blank
//! lines, a fence or a list stays one inline node ([`super::comment_nodes`]).
//! This is the same walk for the `%%` form only: fenced and indented code,
//! code spans, a `%%` that never closes (text), a comment that crosses a table
//! cell end (text), and a `<!--` comment, which owns its `%%` text and which
//! this seed does not build (it stays as written, and its `<…` sends the
//! block to the fallback). A `<!--` comment that spans lines changes the
//! lines desktop reads, so it sends the whole text there
//! ([`Masked::multiline_html`]).

use std::sync::LazyLock;

use crate::domain::journal_rules::js_trim;

use super::backtick_runs::BacktickRuns;
use super::comment_closes::{Later, LaterCloses};
use super::markers::FenceTracker;
use super::mask_word::mask_word;

/// The word a masked comment becomes: `MEMRYCMT`, the process's mask word,
/// the comment's bytes in hex, `X`. No source text spells one.
pub(super) fn token_prefix() -> &'static str {
    static PREFIX: LazyLock<String> = LazyLock::new(|| format!("MEMRYCMT{}", mask_word()));
    &PREFIX
}

pub(super) fn encode(source: &str) -> String {
    format!("{}{}X", token_prefix(), hex::encode(source.as_bytes()))
}

/// What [`mask`] found.
pub(super) struct Masked {
    pub text: String,
    /// A `<!--` comment crosses lines, or never closes.
    pub multiline_html: bool,
}

#[derive(Clone, Copy)]
pub(super) struct Form {
    pub open: &'static str,
    pub close: &'static str,
    pub prose_only: bool,
}

const FORMS: [Form; 2] = [
    Form {
        open: "<!--",
        close: "-->",
        prose_only: false,
    },
    Form {
        open: "%%",
        close: "%%",
        prose_only: true,
    },
];

#[derive(Clone, Copy)]
pub(super) struct Close {
    pub line: usize,
    pub end: usize,
}

/// The next place a pattern occurs, from a position that only moves forward:
/// the last hit stands until the position passes it, and a miss stands for
/// good. It saves a scan to the end of the line for each comment on it.
#[derive(Default)]
pub(super) struct Next(Option<Option<usize>>);

impl Next {
    pub(super) fn at(
        &mut self,
        from: usize,
        find: impl FnOnce() -> Option<usize>,
    ) -> Option<usize> {
        match self.0 {
            Some(None) => return None,
            Some(Some(at)) if at >= from => return Some(at),
            _ => {}
        }
        let found = find();
        self.0 = Some(found);
        found
    }
}

struct Pending {
    prefix: String,
    source: String,
    close: Option<Close>,
    html_block: bool,
}

/// `maskHtmlComments` for the `%%` form: each closed comment outside code
/// becomes its token.
pub(super) fn mask(markdown: &str) -> Masked {
    if !markdown.contains("%%") && !markdown.contains("<!--") {
        return Masked {
            text: markdown.to_owned(),
            multiline_html: false,
        };
    }
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut fence = FenceTracker::default();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut multiline_html = false;
    let mut pending: Option<Pending> = None;
    let mut later_closes = LaterCloses::new(&lines);
    let (mut block_start, mut indented_code, mut container) = (true, false, false);
    for (index, full) in lines.iter().enumerate() {
        let mut line: &str = full;
        let mut result = String::new();
        let mut closes_comment = false;
        let mut html_block = false;

        if let Some(open) = pending.as_mut() {
            if open.close.map(|close| close.line) != Some(index) {
                open.source.push('\n');
                open.source.push_str(line);
                if index == lines.len() - 1 {
                    out.push(format!(
                        "{}{}",
                        open.prefix,
                        comment(&open.source, &mut multiline_html)
                    ));
                }
                continue;
            }
            let end = open.close.map_or(0, |close| close.end);
            let source = format!("{}\n{}", open.source, &line[..end]);
            result = format!("{}{}", open.prefix, comment(&source, &mut multiline_html));
            html_block = open.html_block;
            pending = None;
            line = &line[end..];
            closes_comment = true;
        } else if fence.consume(without_cr(line)) {
            out.push(line.to_owned());
            block_start = true;
            indented_code = false;
            continue;
        } else if js_trim(line).is_empty() {
            out.push(line.to_owned());
            block_start = true;
            continue;
        } else if is_indented(line) && !container && (block_start || indented_code) {
            out.push(line.to_owned());
            indented_code = true;
            continue;
        } else if !is_indented(line) {
            container = container_start(line) || (container && !block_start);
        }
        block_start = false;
        indented_code = false;
        if !closes_comment {
            html_block = html_block_comment(line);
        }

        let table_row = table_row_line(line);
        let ticks = BacktickRuns::of_bytes(line);
        let mut next_tick = Next::default();
        let mut next_open = [Next::default(), Next::default()];
        let mut i = 0;
        while i < line.len() {
            let tick = next_tick.at(i, || line[i..].find('`').map(|at| at + i));
            let opened = next_comment_open(line, i, &mut next_open);
            if tick.is_none() && opened.is_none() {
                break;
            }
            if let Some((form, at)) = opened
                && tick.is_none_or(|tick| at < tick)
            {
                let close = line[at + form.open.len()..]
                    .find(form.close)
                    .map(|found| found + at + form.open.len());
                // GFM splits a row into cells before it reads inline syntax,
                // so a comment in a cell ends in that cell or is text.
                if table_row && close.is_none_or(|close| ends_cell(line, &ticks, at, close)) {
                    result.push_str(&line[i..at + form.open.len()]);
                    i = at + form.open.len();
                    continue;
                }
                if let Some(close) = close {
                    let end = close + form.close.len();
                    result.push_str(&line[i..at]);
                    result.push_str(&comment(&line[at..end], &mut multiline_html));
                    i = end;
                    continue;
                }
                let inline = closes_comment || !js_trim(&line[..at]).is_empty();
                // An HTML block ends on the line holding its `-->`, so a
                // `<!--` after that close cannot reach a later line.
                let reopened = html_block && !form.prose_only && (closes_comment || i > 0);
                let later = if reopened {
                    Later::Text
                } else {
                    later_closes.find(index, form, inline)
                };
                if matches!(later, Later::Text) || (form.prose_only && matches!(later, Later::None))
                {
                    result.push_str(&line[i..at + form.open.len()]);
                    i = at + form.open.len();
                    continue;
                }
                pending = Some(Pending {
                    prefix: format!("{result}{}", &line[i..at]),
                    source: line[at..].to_owned(),
                    close: match later {
                        Later::At(close) => Some(close),
                        _ => None,
                    },
                    html_block,
                });
                break;
            }

            let tick = tick.unwrap_or(0);
            let run_end = tick + line[tick..].bytes().take_while(|b| *b == b'`').count();
            let Some(close_at) = ticks.closing(run_end, run_end - tick) else {
                result.push_str(&line[i..run_end]);
                i = run_end;
                continue;
            };
            let end = close_at + (run_end - tick);
            result.push_str(&line[i..end]);
            i = end;
        }
        if let Some(open) = &pending {
            if index == lines.len() - 1 {
                out.push(format!(
                    "{}{}",
                    open.prefix,
                    comment(&open.source, &mut multiline_html)
                ));
            }
            continue;
        }
        result.push_str(&line[i..]);
        out.push(result);
    }
    Masked {
        text: out.join("\n"),
        multiline_html,
    }
}

/// `line` with each closed `<!--` comment outside a code span as its token.
///
/// Only a `<summary>` line gets this. Desktop masks every comment before it
/// reads a line, so the comment in a summary that is no toggle is a node there
/// whatever `<` surrounds it, and the seed, which keeps a `<!--` comment as
/// written anywhere a `<` would send its block to the fallback, hides the
/// line's `<` instead ([`super::toggles`]) and so has to build the node here.
pub(super) fn encode_html_comments(line: &str) -> String {
    let ticks = BacktickRuns::of_bytes(line);
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < line.len() {
        if line[i..].starts_with('`') {
            let run = line[i..].bytes().take_while(|b| *b == b'`').count();
            let end = ticks
                .closing(i + run, run)
                .map_or(i + run, |close| close + run);
            out.push_str(&line[i..end]);
            i = end;
        } else if let Some(close) = line[i..]
            .starts_with("<!--")
            .then(|| line[i + 4..].find("-->"))
            .flatten()
        {
            let end = i + 4 + close + 3;
            out.push_str(&encode(&line[i..end]));
            i = end;
        } else {
            let width = line[i..].chars().next().map_or(1, char::len_utf8);
            out.push_str(&line[i..i + width]);
            i += width;
        }
    }
    out
}

/// A whole comment's replacement. `<!--` stays as written.
fn comment(source: &str, multiline: &mut bool) -> String {
    if source.starts_with("%%") {
        encode(source)
    } else {
        *multiline |= source.contains('\n');
        source.to_owned()
    }
}

fn next_comment_open(line: &str, from: usize, next: &mut [Next; 2]) -> Option<(Form, usize)> {
    FORMS
        .iter()
        .zip(next)
        .filter_map(|(form, next)| {
            let at = next.at(from, || line[from..].find(form.open).map(|at| at + from))?;
            Some((*form, at))
        })
        .min_by_key(|(_, at)| *at)
}

/// Whether a cell ends between `from` and `limit`: an unescaped `|` there
/// that is not inside `[[target|alias]]` or a code span. The pipe that ends
/// the cell may be far past the comment, so the scan stops at its close.
fn ends_cell(line: &str, ticks: &BacktickRuns, from: usize, limit: usize) -> bool {
    let bytes = line.as_bytes();
    let mut depth = 0;
    let mut i = from;
    while i < bytes.len().min(limit) {
        if bytes[i] == b'\\' {
            i += 1;
        } else if bytes[i] == b'`' {
            let run_end = i + bytes[i..].iter().take_while(|b| **b == b'`').count();
            i = match ticks.closing(run_end, run_end - i) {
                Some(close) => close + (run_end - i),
                None => run_end,
            } - 1;
        } else if bytes[i..].starts_with(b"[[") {
            depth += 1;
            i += 1;
        } else if depth > 0 && bytes[i..].starts_with(b"]]") {
            depth -= 1;
            i += 1;
        } else if bytes[i] == b'|' && depth == 0 {
            return true;
        }
        i += 1;
    }
    false
}

/// The fence pattern cannot match past a CRLF note's trailing `\r`.
pub(super) fn without_cr(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

/// `INDENTED`, `/^(?: {0,3}\t| {4})/`.
fn is_indented(line: &str) -> bool {
    let rest = line.trim_start_matches(' ');
    let spaces = line.len() - rest.len();
    spaces >= 4 || (spaces <= 3 && rest.starts_with('\t'))
}

/// `TABLE_ROW_LINE`, `/^\s*\|.*\|\s*$/`.
fn table_row_line(line: &str) -> bool {
    let trimmed = js_trim(line);
    trimmed.len() >= 2 && trimmed.starts_with('|') && trimmed.ends_with('|')
}

/// `CONTAINER_START`: a list item or footnote definition.
fn container_start(line: &str) -> bool {
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return false;
    }
    let after = if let Some(after) = rest.strip_prefix(['-', '*', '+']) {
        after
    } else if let Some(note) = rest.strip_prefix("[^") {
        let Some(label) = note.find(']').map(|end| &note[..end]) else {
            return false;
        };
        if label.is_empty() || label.contains(char::is_whitespace) {
            return false;
        }
        match note[label.len() + 1..].strip_prefix(':') {
            Some(after) => after,
            None => return false,
        }
    } else {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        match rest[digits..].strip_prefix(['.', ')']) {
            Some(after) if (1..=9).contains(&digits) => after,
            _ => return false,
        }
    };
    after.is_empty() || after.starts_with(char::is_whitespace)
}

/// `HTML_BLOCK_COMMENT`: after any block quote and list item markers that
/// start the block inside them, up to three spaces and `<!--`.
///
/// The pattern's alternatives each step past one marker, and at most one fits
/// at a given place: a fourth space fits none, `>` and a list marker begin
/// with different characters, and a `>` followed by a space or tab takes it,
/// since the line that starts with that space is read by the same steps as
/// the line without it. So one walk along the line decides, however many
/// markers it holds.
fn html_block_comment(mut line: &str) -> bool {
    loop {
        let spaces = line.bytes().take_while(|b| *b == b' ').count();
        if spaces > 3 {
            return false;
        }
        let rest = &line[spaces..];
        if rest.starts_with("<!--") {
            return true;
        }
        if let Some(after) = rest.strip_prefix('>') {
            line = after.strip_prefix([' ', '\t']).unwrap_or(after);
            continue;
        }
        let marker = rest.strip_prefix(['-', '*', '+']).or_else(|| {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            rest[digits..]
                .strip_prefix(['.', ')'])
                .filter(|_| (1..=9).contains(&digits))
        });
        // Up to four spaces follow the marker, and the item's text starts
        // after all of them.
        let Some(after) = marker else {
            return false;
        };
        let blank = after.bytes().take_while(|b| *b == b' ').count();
        if !(1..=4).contains(&blank) {
            return false;
        }
        line = &after[blank..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(markdown: &str) -> String {
        mask(markdown).text
    }

    #[test]
    fn a_closed_comment_outside_code_becomes_one_word() {
        let word = encode("%% b %%");
        assert_eq!(masked("a %% b %% c"), format!("a {word} c"));
        assert_eq!(masked("%%\nx\n\ny\n%%"), encode("%%\nx\n\ny\n%%"));
    }

    #[test]
    fn code_a_stray_opener_and_a_cell_end_keep_their_text() {
        for same in [
            "`a %% b %% c`",
            "```\n%% x %%\n```",
            "    %% x %%",
            "50%% off",
            "| a %% b | c %% |",
            "<!-- %% x %% -->",
        ] {
            assert_eq!(masked(same), same, "{same}");
        }
    }

    #[test]
    fn a_comment_skips_a_fence_and_a_cell_keeps_a_code_span_pipe() {
        assert_eq!(
            masked("%%\n```\n%%\n```\n%%"),
            encode("%%\n```\n%%\n```\n%%")
        );
        let word = encode("%% `x|y` %%");
        assert_eq!(masked("| %% `x|y` %% | 2 |"), format!("| {word} | 2 |"));
    }

    #[test]
    fn a_multiline_html_comment_is_flagged() {
        assert!(mask("%% a %%\n<!--\nx\n-->").multiline_html);
        assert!(!mask("%% a %%\n<!-- x -->").multiline_html);
    }

    #[test]
    fn an_html_block_comment_opens_behind_quote_and_list_markers() {
        for open in [
            "<!-- c",
            "   <!--",
            "> <!--",
            ">\t<!--",
            "> > - <!--",
            "1.   > <!--",
        ] {
            assert!(html_block_comment(open), "{open:?}");
        }
        for text in ["    <!--", "> x <!--", "-     <!--", "10 <!--", ">  \t<!--"] {
            assert!(!html_block_comment(text), "{text:?}");
        }
    }
}
