//! Line shapes of BlockNote 0.54's block tokenizer
//! (`api/parsers/markdown/markdownToHtml.ts`), one regex each, ported by hand
//! with JavaScript's `\s` and `trim()`.

use crate::domain::journal_rules::{is_js_whitespace, js_trim};

pub(super) fn blank(line: &str) -> bool {
    js_trim(line).is_empty()
}

/// Leading JS-whitespace characters, counted in characters (they are all in
/// the BMP, so this is also their UTF-16 length).
pub(super) fn leading_ws(line: &str) -> usize {
    line.chars().take_while(|c| is_js_whitespace(*c)).count()
}

/// Byte offset after the first `count` characters.
pub(super) fn skip_chars(line: &str, count: usize) -> &str {
    let at = line
        .char_indices()
        .nth(count)
        .map_or(line.len(), |(at, _)| at);
    &line[at..]
}

/// `/^(#{1,6})\s/`
pub(super) fn starts_heading(line: &str) -> bool {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    (1..=6).contains(&hashes) && line[hashes..].chars().next().is_some_and(is_js_whitespace)
}

/// `/^(`{3,}|~{3,})/`
pub(super) fn starts_fence(line: &str) -> bool {
    line.starts_with("```") || line.starts_with("~~~")
}

/// `/^(\s{0,3})([-*_])\s*(\2\s*){2,}$/`
pub(super) fn is_rule(line: &str) -> bool {
    let lead = leading_ws(line);
    if lead > 3 {
        return false;
    }
    let rest = skip_chars(line, lead);
    let Some(mark) = rest.chars().next().filter(|c| matches!(c, '-' | '*' | '_')) else {
        return false;
    };
    let mut marks = 0;
    for c in rest.chars() {
        if c == mark {
            marks += 1;
        } else if !is_js_whitespace(c) {
            return false;
        }
    }
    marks >= 3
}

/// `/^\s*([-*+]|\d+[.)])\s+/`
pub(super) fn starts_list_item(line: &str) -> bool {
    list_marker(skip_chars(line, leading_ws(line)))
        .is_some_and(|(_, rest)| rest.chars().next().is_some_and(is_js_whitespace))
}

/// `[-*+]|\d+[.)]` at the start of `text`: the marker and what follows it.
pub(super) fn list_marker(text: &str) -> Option<(&str, &str)> {
    if text.starts_with(['-', '*', '+']) {
        return Some(text.split_at(1));
    }
    let digits = text.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || !text[digits..].starts_with(['.', ')']) {
        return None;
    }
    Some(text.split_at(digits + 1))
}

/// `/^\s*\|(.+\|)+\s*$/`
pub(super) fn is_pipe_row(line: &str) -> bool {
    let Some(rest) = line.trim_start_matches(is_js_whitespace).strip_prefix('|') else {
        return false;
    };
    // `(.+\|)+`: at least one character, then the last pipe.
    let rest = rest.trim_end_matches(is_js_whitespace);
    rest.chars().count() >= 2 && rest.ends_with('|')
}

/// `/^\s{0,3}>/`
pub(super) fn starts_quote(line: &str) -> bool {
    let lead = leading_ws(line);
    lead <= 3 && skip_chars(line, lead).starts_with('>')
}

/// `/^[=-]+\s*$/`
pub(super) fn is_setext_underline(line: &str) -> bool {
    let body = line.trim_end_matches(is_js_whitespace);
    !body.is_empty() && body.chars().all(|c| c == '=' || c == '-')
}

/// `/^={1,}\s*$/`
pub(super) fn is_setext_h1(line: &str) -> bool {
    let body = line.trim_end_matches(is_js_whitespace);
    !body.is_empty() && body.chars().all(|c| c == '=')
}

pub(super) const HTML_BLOCK_TAGS: &[&str] = &[
    "address",
    "article",
    "aside",
    "audio",
    "base",
    "basefont",
    "blockquote",
    "body",
    "caption",
    "center",
    "col",
    "colgroup",
    "dd",
    "details",
    "dialog",
    "dir",
    "div",
    "dl",
    "dt",
    "fieldset",
    "figcaption",
    "figure",
    "footer",
    "form",
    "frame",
    "frameset",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "head",
    "header",
    "hr",
    "html",
    "iframe",
    "legend",
    "li",
    "link",
    "main",
    "menu",
    "menuitem",
    "nav",
    "noframes",
    "ol",
    "optgroup",
    "option",
    "p",
    "param",
    "section",
    "source",
    "summary",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "title",
    "tr",
    "track",
    "ul",
];

/// `isHtmlBlockStart`.
pub(super) fn is_html_block_start(line: &str) -> bool {
    let indent = line.chars().take_while(|c| *c == ' ').count();
    if indent > 3 {
        return false;
    }
    let Some(rest) = line[indent..].strip_prefix('<') else {
        return false;
    };
    if rest.starts_with("!--") || rest.starts_with('?') || rest.starts_with("![CDATA[") {
        return true;
    }
    if rest
        .strip_prefix('!')
        .is_some_and(|after| after.starts_with(|c: char| c.is_ascii_alphabetic()))
    {
        return true;
    }
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    if !rest.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return false;
    }
    let name_len = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .count();
    let after = &rest[name_len..];
    let closes = after.is_empty()
        || after.starts_with(is_js_whitespace)
        || after.starts_with('>')
        || after.starts_with("/>");
    closes && HTML_BLOCK_TAGS.contains(&rest[..name_len].to_ascii_lowercase().as_str())
}

/// `/^(#{1,6})\s+(.+?)(?:\s+#+\s*|\s*)$/`: the level and the content.
pub(super) fn heading(line: &str) -> Option<(u8, String)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest: Vec<char> = line[hashes..].chars().collect();
    let spaces = rest.iter().take_while(|c| is_js_whitespace(**c)).count();
    if spaces == 0 {
        return None;
    }
    // `\s+` is greedy and gives back one character when nothing else is left.
    let from = if spaces == rest.len() {
        if spaces < 2 {
            return None;
        }
        spaces - 1
    } else {
        spaces
    };
    let tail_matches = |tail: &[char]| {
        if tail.iter().all(|c| is_js_whitespace(*c)) {
            return true;
        }
        let lead = tail.iter().take_while(|c| is_js_whitespace(**c)).count();
        let marks = tail[lead..].iter().take_while(|c| **c == '#').count();
        lead > 0 && marks > 0 && tail[lead + marks..].iter().all(|c| is_js_whitespace(*c))
    };
    (from + 1..=rest.len())
        .find(|&end| tail_matches(&rest[end..]))
        .map(|end| (hashes as u8, rest[from..end].iter().collect()))
}

/// `tryParseTable`, recognition only: the line after the table, or `None`.
pub(super) fn table_end(lines: &[&str], start: usize) -> Option<usize> {
    let separator = lines.get(start + 1)?;
    if !separator.contains('|') || !is_table_separator(separator) || !lines[start].contains('|') {
        return None;
    }
    let mut end = start + 2;
    while end < lines.len() && lines[end].contains('|') {
        end += 1;
    }
    Some(end)
}

/// `/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/`
pub(super) fn is_table_separator(line: &str) -> bool {
    let trimmed = line.trim_matches(is_js_whitespace);
    let trimmed = trimmed.strip_prefix('|').unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix('|').unwrap_or(trimmed);
    trimmed.split('|').all(|cell| {
        let cell = cell.trim_matches(is_js_whitespace);
        let cell = cell.strip_prefix(':').unwrap_or(cell);
        let cell = cell.strip_suffix(':').unwrap_or(cell);
        !cell.is_empty() && cell.chars().all(|c| c == '-')
    })
}
