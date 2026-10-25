//! `normalizeSerializedMarkdown` and the table helpers of `empty-lines.ts`: the
//! serializer's output brought to the style vault files use.

use std::sync::LazyLock;

use regex::Regex;

use super::{JS_WS, is_list_item_line, split_by_code_fences};
use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};
use crate::markdown::shared::html_comments::decode_html_comment_tokens;

/// `[^\S\n]`.
fn is_blank(c: char) -> bool {
    c != '\n' && is_js_whitespace(c)
}

static TABLE_ROW_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^[{JS_WS}]*\|[^\n\r\u{{2028}}\u{{2029}}]*\|[{JS_WS}]*$"
    ))
    .expect("static pattern")
});

/// `TABLE_ROW_LINE`: starts and ends with a pipe once trimmed.
pub(crate) fn is_table_row_line(line: &str) -> bool {
    TABLE_ROW_LINE.is_match(line)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `TABLE_ROW_START`: `^[ \t]*\|`.
fn is_table_row_start(line: &str) -> bool {
    line.trim_start_matches([' ', '\t']).starts_with('|')
}

/// Put a table row that a line break split back onto one line: the backslash
/// break becomes a space.
fn join_broken_table_rows(lines: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        if let Some(previous) = out.last_mut()
            && previous.ends_with('\\')
            && is_table_row_start(previous)
        {
            previous.pop();
            previous.push(' ');
            previous.push_str(line);
            continue;
        }
        out.push((*line).to_owned());
    }
    out
}

static LIST_ITEM_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t]*(?:[-*+]|[0-9]+[.)])[ \t]+").expect("static pattern"));

/// Indent the line a hard break inside a list item continues onto (BBF-99).
fn indent_list_item_breaks(lines: &[String]) -> Vec<String> {
    let mut indent = 0;
    lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if let Some(item) = LIST_ITEM_PREFIX.find(line) {
                indent = item.end();
                return line.clone();
            }
            let previous = index.checked_sub(1).map(|p| lines[p].as_str());
            if indent == 0 || !previous.is_some_and(|p| p.ends_with('\\')) {
                indent = 0;
                return line.clone();
            }
            // Only after a hard break's lone `\` line: a soft break keeps the lazy
            // spelling, which the parser reads the same way it did before.
            let after_hard_break = previous.is_some_and(|p| js_trim(p) == "\\")
                && index
                    .checked_sub(2)
                    .is_some_and(|p| lines[p].ends_with('\\'));
            if after_hard_break && !line.chars().next().is_some_and(is_js_whitespace) {
                format!("{}{line}", " ".repeat(indent))
            } else {
                line.clone()
            }
        })
        .collect()
}

/// `BACKSLASH_BREAK_RUN` (`(?:\\\n([^\S\n]*(?:>[^\S\n]?)*))+`, global): each run
/// of backslash breaks replaced by what its count and last prefix call for.
fn replace_backslash_break_runs(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        if !(bytes[i] == b'\\' && bytes.get(i + 1) == Some(&b'\n')) {
            i += 1;
            continue;
        }
        let mut count = 0;
        let mut j = i;
        let mut prefix = "";
        while bytes.get(j) == Some(&b'\\') && bytes.get(j + 1) == Some(&b'\n') {
            j += 2;
            let prefix_start = j;
            j += text[j..].len() - text[j..].trim_start_matches(is_blank).len();
            while bytes.get(j) == Some(&b'>') {
                j += 1;
                if let Some(c) = text[j..].chars().next().filter(|c| is_blank(*c)) {
                    j += c.len_utf8();
                }
            }
            prefix = &text[prefix_start..j];
            count += 1;
        }
        out.push_str(&text[last..i]);
        if count == 2 {
            out.push_str("  \n");
            out.push_str(prefix);
        } else {
            for _ in 0..count {
                out.push('\n');
                out.push_str(prefix);
            }
        }
        last = j;
        i = j;
    }
    out.push_str(&text[last..]);
    out
}

/// `line.replace(/^([ \t]*)[*+](\s)/, '$1-$2')`.
fn dash_bullet(line: &str) -> String {
    let rest = line.trim_start_matches([' ', '\t']);
    let indent = line.len() - rest.len();
    let mut chars = rest.chars();
    if matches!(chars.next(), Some('*' | '+')) && chars.next().is_some_and(is_js_whitespace) {
        return format!("{}-{}", &line[..indent], &rest[1..]);
    }
    line.to_owned()
}

fn normalize_prose_markdown(text: &str) -> String {
    let split: Vec<&str> = text.split('\n').collect();
    let joined = join_broken_table_rows(&split);
    let indented = indent_list_item_breaks(&joined).join("\n");
    let replaced = replace_backslash_break_runs(&indented);
    let lines: Vec<&str> = replaced.split('\n').collect();

    let mut out: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if js_trim(line).is_empty() {
            // Drop a blank line only between two list items, never a real paragraph gap.
            if let (Some(prev), Some(next)) = (out.last(), lines.get(i + 1))
                && is_list_item_line(prev)
                && is_list_item_line(next)
            {
                continue;
            }
        }
        out.push(dash_bullet(line));
    }
    compact_tables(&out).join("\n")
}

/// Normalize BlockNote's markdown serializer output to the CommonMark/Obsidian
/// style vault files use. Code fences stay byte for byte; HTML comment tokens
/// become their comments again (AF-015).
pub fn normalize_serialized_markdown(markdown: &str) -> String {
    if markdown.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for region in split_by_code_fences(markdown) {
        if region.is_code {
            out.push_str(&region.text);
        } else {
            out.push_str(&normalize_prose_markdown(&region.text));
        }
    }
    // Last, so nothing above reads the inside of a comment.
    decode_html_comment_tokens(&out)
}

/// `SEPARATOR_CELL`: `^:?-+:?$`.
fn is_separator_cell(cell: &str) -> bool {
    let inner = cell.strip_prefix(':').unwrap_or(cell);
    let inner = inner.strip_suffix(':').unwrap_or(inner);
    // `-+` needs one dash; a lone `:` is read as the opening colon with no dash.
    !inner.is_empty() && inner.bytes().all(|b| b == b'-')
}

fn compact_tables(lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        match table_run_at(lines, i) {
            None => {
                out.push(lines[i].clone());
                i += 1;
            }
            Some(run) => {
                out.extend(relay_table(&lines[i..run]));
                i = run;
            }
        }
    }
    out
}

/// End index (exclusive) of the table starting at `start`, or `None`.
fn table_run_at(lines: &[String], start: usize) -> Option<usize> {
    if !is_table_row_line(&lines[start]) {
        return None;
    }
    let separator = lines.get(start + 1)?;
    if !is_table_row_line(separator) {
        return None;
    }
    if !split_row(separator)
        .iter()
        .all(|cell| is_separator_cell(cell))
    {
        return None;
    }
    let mut end = start + 2;
    while end < lines.len() && is_table_row_line(&lines[end]) {
        end += 1;
    }
    Some(end)
}

/// Cells of one row, trimmed, without the outer delimiters.
fn split_row(line: &str) -> Vec<String> {
    let trimmed = js_trim(line);
    let inner = if trimmed.is_empty() {
        ""
    } else {
        let body = &trimmed[1..];
        body.strip_suffix('|').unwrap_or(body)
    };
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        // An escaped pipe is cell content, not a delimiter.
        if c == '\\' && chars.peek() == Some(&'|') {
            current.push_str("\\|");
            chars.next();
            continue;
        }
        if c == '|' {
            cells.push(js_trim(&current).to_owned());
            current.clear();
            continue;
        }
        current.push(c);
    }
    cells.push(js_trim(&current).to_owned());
    cells
}

/// A cell's width as the file will hold it, an HTML comment by its own length (AF-015).
fn cell_width(cell: &str) -> usize {
    utf16_len(&decode_html_comment_tokens(cell))
}

fn separator_cell(cell: &str, width: usize) -> String {
    let left = cell.starts_with(':');
    let right = cell.ends_with(':') && utf16_len(cell) > 1;
    let dashes = width
        .saturating_sub(usize::from(left) + usize::from(right))
        .max(1);
    format!(
        "{}{}{}",
        if left { ":" } else { "" },
        "-".repeat(dashes),
        if right { ":" } else { "" }
    )
}

fn relay_table(rows: &[String]) -> Vec<String> {
    let grid: Vec<Vec<String>> = rows.iter().map(|row| split_row(row)).collect();
    let columns = grid.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns)
        .map(|column| {
            let mut width = 0;
            for (index, row) in grid.iter().enumerate() {
                // The separator sets no width of its own.
                if index == 1 {
                    continue;
                }
                width = width.max(row.get(column).map_or(0, |cell| cell_width(cell)));
            }
            width.max(1)
        })
        .collect();

    grid.iter()
        .enumerate()
        .map(|(index, row)| {
            let cells: Vec<String> = widths
                .iter()
                .enumerate()
                .map(|(column, width)| {
                    if index == 1 {
                        separator_cell(row.get(column).map_or("-", String::as_str), *width)
                    } else {
                        let cell = row.get(column).map_or("", String::as_str);
                        format!(
                            "{cell}{}",
                            " ".repeat(width.saturating_sub(cell_width(cell)))
                        )
                    }
                })
                .collect();
            format!("| {} |", cells.join(" | "))
        })
        .collect()
}

/// Escape the `|` inside a `[[target|alias]]` sitting in a table row (reading
/// fix for BlockNote 0.51's table parser).
pub fn escape_wiki_link_pipes_in_table_rows(markdown: &str) -> String {
    if !markdown.contains("[[") || !markdown.contains('|') {
        return markdown.to_owned();
    }
    let mut out = String::new();
    for region in split_by_code_fences(markdown) {
        if region.is_code {
            out.push_str(&region.text);
            continue;
        }
        let lines: Vec<String> = region
            .text
            .split('\n')
            .map(|line| {
                if is_table_row_line(line) {
                    escape_wiki_link_pipes(line)
                } else {
                    line.to_owned()
                }
            })
            .collect();
        out.push_str(&lines.join("\n"));
    }
    out
}

fn escape_wiki_link_pipes(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::new();
    let mut depth = 0;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            let next = line[i + 1..].chars().next().expect("a next character");
            out.push('\\');
            out.push(next);
            i += 1 + next.len_utf8();
            continue;
        }
        if bytes[i..].starts_with(b"[[") {
            depth += 1;
            out.push_str("[[");
            i += 2;
            continue;
        }
        if depth > 0 && bytes[i..].starts_with(b"]]") {
            depth -= 1;
            out.push_str("]]");
            i += 2;
            continue;
        }
        let c = line[i..].chars().next().expect("a character");
        if depth > 0 && c == '|' {
            out.push_str("\\|");
        } else {
            out.push(c);
        }
        i += c.len_utf8();
    }
    out
}
