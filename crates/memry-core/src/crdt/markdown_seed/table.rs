//! Pipe tables: BlockNote's `tryParseTable` and `emitTable`
//! (`markdownToHtml.ts`), the table parse (`Table/block.ts`), and the two
//! masks desktop puts around them (`escapeWikiLinkPipesInTableRows`,
//! `maskCellCodeSpaces`).

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

use super::inline::cell_content;
use super::prepare::split_by_code_fences;
use super::shapes::is_table_separator;
use super::{SeedBlock, SeedCell, SeedKind, SeedRow, Unsupported};

/// One source row's cells, and whether `maskCellCodeSpaces` masked its code
/// spans' whitespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PipeRow {
    pub cells: Vec<String>,
    pub code_kept: bool,
}

/// `tryParseTable`: the header row, the body rows and the line after the
/// table, or `None` when `lines[start]` does not open one.
pub(super) fn try_parse_table(
    lines: &[&str],
    start: usize,
) -> Option<(PipeRow, Vec<PipeRow>, usize)> {
    let separator = lines.get(start + 1)?;
    if !separator.contains('|') || !is_table_separator(separator) || !lines[start].contains('|') {
        return None;
    }
    let mut end = start + 2;
    let mut rows = Vec::new();
    while end < lines.len() && lines[end].contains('|') {
        rows.push(pipe_row(lines[end]));
        end += 1;
    }
    Some((pipe_row(lines[start]), rows, end))
}

fn pipe_row(line: &str) -> PipeRow {
    PipeRow {
        cells: parse_pipe_cells(line),
        code_kept: line.contains('`') && !unsafe_for_code_mask(line),
    }
}

/// `maskCellCodeSpaces`' `UNSAFE_LINE`, `/[[\]]|<(?!br\s*\/?>)/i`: a row it
/// leaves unmasked.
fn unsafe_for_code_mask(line: &str) -> bool {
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

/// `parsePipeCells`: the line trimmed, one outer pipe off each end, split on
/// the unescaped pipes, each cell trimmed.
fn parse_pipe_cells(line: &str) -> Vec<String> {
    let trimmed = js_trim(line);
    let trimmed = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let content = trimmed.strip_suffix('|').unwrap_or(trimmed);
    let chars: Vec<char> = content.chars().collect();
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'|') {
            current.push('|');
            i += 2;
            continue;
        }
        if chars[i] == '|' {
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
/// `tableCell`s per body row, each cut or padded to the header's width.
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
