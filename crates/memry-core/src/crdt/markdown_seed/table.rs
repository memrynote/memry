//! Pipe tables: BlockNote's `tryParseTable` and `emitTable`
//! (`markdownToHtml.ts`), the table parse (`Table/block.ts`), and what
//! desktop does around them: `escapeWikiLinkPipesInTableRows`,
//! `maskCellCodeSpans` and `widenTables`.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::backtick_runs::{BacktickRuns, opens_fence_line};
use super::inline::cell_content;
use super::prepare::split_by_code_fences;
use super::shapes::is_table_separator;
use super::{SeedBlock, SeedCell, SeedKind, SeedRow, Unsupported};

/// One source row's cells, and whether `maskCellCodeSpans` masked its code
/// spans' whitespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PipeRow {
    pub cells: Vec<String>,
    pub code_kept: bool,
}

/// `tryParseTable`: the header row, the body rows and the line after the
/// table, or `None` when `lines[start]` does not open one. A pipe inside a
/// code span is hidden from it, as `maskCellCodeSpans` hides it, so it
/// neither opens a table nor continues one.
///
/// `widenTables`: the header row gets an empty cell for each column the
/// widest body row has past it, one spelled like a delimiter row included.
pub(super) fn try_parse_table(
    lines: &[&str],
    start: usize,
) -> Option<(PipeRow, Vec<PipeRow>, usize)> {
    let separator = lines.get(start + 1)?;
    if !separator.contains('|') || !is_table_separator(separator) || !has_cell_pipe(lines[start]) {
        return None;
    }
    let mut end = start + 2;
    let mut rows = Vec::new();
    while end < lines.len() && has_cell_pipe(lines[end]) {
        rows.push(pipe_row(lines[end]));
        end += 1;
    }
    let mut header = pipe_row(lines[start]);
    let widest = rows.iter().map(|row| row.cells.len()).max().unwrap_or(0);
    if widest > header.cells.len() {
        header.cells.resize(widest, String::new());
    }
    Some((header, rows, end))
}

fn pipe_row(line: &str) -> PipeRow {
    PipeRow {
        cells: parse_pipe_cells(line),
        code_kept: line.contains('`') && !unsafe_for_code_mask(line),
    }
}

fn has_cell_pipe(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    let hidden = code_span_pipes(&chars);
    chars
        .iter()
        .zip(hidden)
        .any(|(ch, hidden)| *ch == '|' && !hidden)
}

/// `maskCellCodeSpans`' pipes: for each char of `line`, whether it is a `|`
/// inside a code span, which splits no cell. Outside a code span a backslash
/// escapes the char after it; inside one, a `\|` is no such pipe, and the
/// splitter turns it into the pipe the writer escaped.
fn code_span_pipes(line: &[char]) -> Vec<bool> {
    let mut hidden = vec![false; line.len()];
    let ticks = BacktickRuns::of_chars(line);
    let mut i = 0;
    while i < line.len() {
        if line[i] == '\\' && i + 1 < line.len() {
            i += 2;
            continue;
        }
        if line[i] != '`' {
            i += 1;
            continue;
        }
        let run = line[i..].iter().take_while(|ch| **ch == '`').count();
        let Some((open, end)) = ticks.span_at(i, true) else {
            i += run;
            continue;
        };
        for at in i + run..end - (i + run - open) {
            hidden[at] = line[at] == '|' && line[at - 1] != '\\';
        }
        i = end;
    }
    hidden
}

/// `maskCellCodeSpans`' `UNSAFE_LINE`, `/[[\]]|<(?!br\s*\/?>)/i`: a row whose
/// code spans keep their whitespace unmasked.
pub(super) fn unsafe_for_code_mask(line: &str) -> bool {
    let line = &without_empty_links(line);
    if line.contains(['[', ']']) {
        return true;
    }
    line.match_indices('<').any(|(at, _)| {
        let rest = &line[at + 1..];
        let Some(after) = rest
            .get(..2)
            .filter(|tag| tag.eq_ignore_ascii_case("br"))
            .map(|_| &rest[2..])
        else {
            return true;
        };
        let after = after.trim_start_matches(is_js_whitespace);
        let after = after.strip_prefix('/').unwrap_or(after);
        !after.starts_with('>')
    })
}

/// `line` with each empty-label link outside code and outside an image
/// dropped. Desktop hides one behind a token before it reads `UNSAFE_LINE`
/// (`maskEmptyLinks`), so its brackets make no row unsafe.
fn without_empty_links(line: &str) -> String {
    if !line.contains("](") {
        return line.to_owned();
    }
    let bytes = line.as_bytes();
    let ticks = BacktickRuns::of_bytes(line);
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    let mut last = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'`' => {
                i = ticks
                    .span_at(i, !opens_fence_line(line, i))
                    .map_or_else(|| ticks.end_of(i), |(_, end)| end);
            }
            b'[' => {
                let label = i
                    + 1
                    + bytes[i + 1..]
                        .iter()
                        .take_while(|b| matches!(b, b' ' | b'\t'))
                        .count();
                let close = bytes[label..]
                    .starts_with(b"](")
                    .then(|| address_end(bytes, label + 1))
                    .flatten();
                let image = i > 0 && bytes[i - 1] == b'!';
                match close {
                    Some(end) if !image => {
                        out.push_str(&line[last..i]);
                        last = end + 1;
                        i = end + 1;
                    }
                    _ => i += 1,
                }
            }
            _ => i += 1,
        }
    }
    out.push_str(&line[last.min(line.len())..]);
    out
}

/// The `)` that brings the depth of the `(` at `open` back to zero, a
/// backslash stepping over the byte after it (`findClosingParen`).
fn address_end(bytes: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// `parsePipeCells`: the line trimmed, one outer pipe off each end, split on
/// the unescaped pipes outside code spans, each cell trimmed. An outer pipe
/// is never inside a code span: only whitespace comes before the first, and
/// a code span closes after the last.
fn parse_pipe_cells(line: &str) -> Vec<String> {
    let trimmed = js_trim(line);
    let trimmed = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let content = trimmed.strip_suffix('|').unwrap_or(trimmed);
    let chars: Vec<char> = content.chars().collect();
    let hidden = code_span_pipes(&chars);
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'|') {
            current.push('|');
            i += 2;
            continue;
        }
        if chars[i] == '|' && !hidden[i] {
            cells.push(js_trim(&current).to_owned());
            current.clear();
        } else {
            current.push(chars[i]);
        }
        i += 1;
    }
    cells.push(js_trim(&current).to_owned());
    cells
}

/// `emitTable` and the parse of the HTML it prints: a header row of
/// `tableHeader` cells unless every header cell is blank, then one row of
/// `tableCell`s per body row, each padded to the header's width.
pub(super) fn table_block(
    header: &PipeRow,
    rows: &[PipeRow],
    breaks: &[String],
) -> Result<SeedBlock, Unsupported> {
    let width = header.cells.len();
    let row = |source: &PipeRow, header: bool| -> Result<SeedRow, Unsupported> {
        let cells = (0..width)
            .map(|column| {
                let text = source.cells.get(column).map_or("", String::as_str);
                Ok(SeedCell {
                    header,
                    content: cell_content(text, breaks, source.code_kept)?,
                })
            })
            .collect::<Result<_, Unsupported>>()?;
        Ok(SeedRow { cells })
    };
    let mut table = Vec::new();
    if header.cells.iter().any(|cell| !js_trim(cell).is_empty()) {
        table.push(row(header, true)?);
    }
    for source in rows {
        table.push(row(source, false)?);
    }
    if table.is_empty() {
        return Err(Unsupported("table without rows"));
    }
    Ok(SeedBlock::new(SeedKind::Table { rows: table }, Vec::new()))
}

/// `escapeWikiLinkPipesInTableRows` (`shared/empty-lines.ts`): outside code
/// fences, a line shaped like a table row has each `|` inside `[[…]]`
/// escaped, so the row does not split on a wiki link's alias.
pub(super) fn escape_wiki_link_pipes_in_table_rows(markdown: &str) -> String {
    if !markdown.contains("[[") || !markdown.contains('|') {
        return markdown.to_owned();
    }
    split_by_code_fences(markdown)
        .into_iter()
        .map(|(text, is_code)| {
            if is_code {
                return text.to_owned();
            }
            text.split('\n')
                .map(|line| {
                    if is_table_row_line(line) {
                        escape_wiki_link_pipes(line)
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect()
}

/// `TABLE_ROW_LINE`, `/^\s*\|.*\|\s*$/`.
fn is_table_row_line(line: &str) -> bool {
    line.trim_start_matches(is_js_whitespace)
        .strip_prefix('|')
        .is_some_and(|rest| rest.trim_end_matches(is_js_whitespace).ends_with('|'))
}

fn escape_wiki_link_pipes(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut depth = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let pair = |a: char, b: char| chars[i] == a && chars.get(i + 1) == Some(&b);
        if chars[i] == '\\' && i + 1 < chars.len() {
            out.push(chars[i]);
            out.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if pair('[', '[') {
            depth += 1;
            out.push_str("[[");
            i += 2;
            continue;
        }
        if depth > 0 && pair(']', ']') {
            depth -= 1;
            out.push_str("]]");
            i += 2;
            continue;
        }
        if depth > 0 && chars[i] == '|' {
            out.push_str("\\|");
        } else {
            out.push(chars[i]);
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_split_on_unescaped_pipes_inside_the_outer_ones() {
        assert_eq!(parse_pipe_cells("| a | b\\|c |"), vec!["a", "b|c"]);
        assert_eq!(parse_pipe_cells("a | b"), vec!["a", "b"]);
        assert_eq!(parse_pipe_cells("|  |"), vec![""]);
    }

    #[test]
    fn only_a_closed_code_span_holds_its_pipes() {
        assert_eq!(
            parse_pipe_cells("| ``a|`b`` | `x\\|y` |"),
            vec!["``a|`b``", "`x|y`"]
        );
        assert_eq!(parse_pipe_cells("| \\`n|m\\` |"), vec!["\\`n", "m\\`"]);
        assert_eq!(parse_pipe_cells("| `u | v |"), vec!["`u", "v"]);
    }

    #[test]
    fn a_wiki_link_alias_pipe_is_escaped_only_in_a_table_row() {
        assert_eq!(
            escape_wiki_link_pipes_in_table_rows("| [[a|b]] |\nx [[a|b]]"),
            "| [[a\\|b]] |\nx [[a|b]]"
        );
    }

    #[test]
    fn a_link_or_tag_leaves_a_row_unmasked() {
        assert!(unsafe_for_code_mask("| [a](u) | `x` |"));
        assert!(unsafe_for_code_mask("| <b>x</b> |"));
        assert!(!unsafe_for_code_mask("| a<br>b | <BR /> |"));
    }
}
