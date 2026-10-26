//! Port of `packages/shared/src/hard-breaks.ts`: the token a hard break wears
//! across BlockNote's markdown parser, so `Line one  \nLine two` stays a hard break.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde::Serialize;

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};
use crate::markdown::shared::empty_lines::split_by_code_fences;

const HARD_BREAK_TOKEN_PREFIX: &str = "MEMRYHBK";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MaskedHardBreaks {
    pub markdown: String,
    /// The spelling each token replaced, by index. Empty when nothing was masked.
    pub breaks: Vec<String>,
}

/// `[^\S\n]`: whitespace other than a newline.
fn is_blank(c: char) -> bool {
    c != '\n' && is_js_whitespace(c)
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The byte just past `<br\s*\/?>` (any case) starting at `at`, if it is there.
fn br_tag_end(text: &str, at: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.len() < at + 3 || !bytes[at..at + 3].eq_ignore_ascii_case(b"<br") {
        return None;
    }
    let mut end = at + 3;
    let after_ws = text[end..].trim_start_matches(is_js_whitespace);
    end = text.len() - after_ws.len();
    if bytes.get(end) == Some(&b'/') {
        end += 1;
    }
    (bytes.get(end) == Some(&b'>')).then_some(end + 1)
}

/// True when `text` ends with `<br\s*\/?>`.
fn ends_with_br_tag(text: &str) -> bool {
    let Some(body) = text.strip_suffix('>') else {
        return false;
    };
    let body = body.strip_suffix('/').unwrap_or(body);
    let body = body.trim_end_matches(is_js_whitespace);
    body.len() >= 3 && body.as_bytes()[body.len() - 3..].eq_ignore_ascii_case(b"<br")
}

/// `HTML_BREAK_MID_LINE`: an author's `<br>` with more text after it on the same
/// line. Calls `on_tag` for each and replaces it with what that returns.
fn replace_mid_line_breaks(line: &str, on_tag: &mut dyn FnMut(&str) -> String) -> String {
    let mut out = String::new();
    let mut last = 0;
    let mut from = 0;
    while let Some(n) = line[from..].find('<') {
        let at = from + n;
        from = at + 1;
        let Some(end) = br_tag_end(line, at) else {
            continue;
        };
        // Not right after another tag (and any blanks between).
        let before = line[..at].trim_end_matches(is_blank);
        if ends_with_br_tag(before) {
            continue;
        }
        // Not before another `<br`, and followed by text on the same line.
        let after = line[end..].trim_start_matches(is_blank);
        let bytes = after.as_bytes();
        if bytes.len() >= 3
            && bytes[..3].eq_ignore_ascii_case(b"<br")
            && !after[3..].chars().next().is_some_and(is_word_char)
        {
            continue;
        }
        if !after.chars().next().is_some_and(|c| !is_js_whitespace(c)) {
            continue;
        }
        out.push_str(&line[last..at]);
        out.push_str(&on_tag(&line[at..end]));
        last = end;
        from = end;
    }
    out.push_str(&line[last..]);
    out
}

/// `HARD_BREAK_LINE`: `(?:[ \t]{2,}|\\)$`. The start of the trailing spelling.
fn hard_break_start(line: &str) -> Option<usize> {
    let kept = line.trim_end_matches([' ', '\t']);
    if line.len() - kept.len() >= 2 {
        return Some(kept.len());
    }
    line.ends_with('\\').then(|| line.len() - 1)
}

fn is_hard_break_line(line: &str) -> bool {
    hard_break_start(line).is_some()
}

/// `NOT_PARAGRAPH_LINE`: `^(?:[ \t]|[>#]|[-*+][ \t]|\d+[.)][ \t])|\|`.
fn is_not_paragraph_line(line: &str) -> bool {
    line.contains('|') || starts_with_block_marker(line)
}

fn starts_with_block_marker(line: &str) -> bool {
    let bytes = line.as_bytes();
    match bytes.first() {
        Some(b' ' | b'\t' | b'>' | b'#') => true,
        Some(b'-' | b'*' | b'+') => matches!(bytes.get(1), Some(b' ' | b'\t')),
        Some(b'0'..=b'9') => {
            let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
            matches!(bytes.get(digits), Some(b'.' | b')'))
                && matches!(bytes.get(digits + 1), Some(b' ' | b'\t'))
        }
        _ => false,
    }
}

/// The length of a list item marker plus the blanks after it: `LIST_ITEM_PREFIX`
/// (`^[ \t]*(?:[-*+]|\d+[.)])[ \t]+`) or, with `one_blank`, `LIST_ITEM_START`.
fn list_item_prefix_len(line: &str, one_blank: bool) -> Option<usize> {
    let rest = line.trim_start_matches([' ', '\t']);
    let indent = line.len() - rest.len();
    let bytes = rest.as_bytes();
    let marker = match bytes.first()? {
        b'-' | b'*' | b'+' => 1,
        b'0'..=b'9' => {
            let digits = bytes.iter().take_while(|b| b.is_ascii_digit()).count();
            if !matches!(bytes.get(digits), Some(b'.' | b')')) {
                return None;
            }
            digits + 1
        }
        _ => return None,
    };
    let blanks = bytes[marker..]
        .iter()
        .take_while(|b| matches!(b, b' ' | b'\t'))
        .count();
    if blanks == 0 {
        return None;
    }
    Some(indent + marker + if one_blank { 1 } else { blanks })
}

fn is_list_item_start(line: &str) -> bool {
    list_item_prefix_len(line, true).is_some()
}

/// `BLOCK_START`.
fn is_block_start(line: &str) -> bool {
    let rest = line.trim_start_matches([' ', '\t']);
    if is_list_item_start(line) {
        return true;
    }
    if rest.starts_with(['>', '|']) || rest.starts_with("```") || rest.starts_with("~~~") {
        return true;
    }
    let hashes = rest.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes)
        && rest[hashes..]
            .chars()
            .next()
            .is_none_or(|c| c == ' ' || c == '\t')
    {
        return true;
    }
    // `(?:[-*_=][ \t]*){3,}$`
    let starts = rest.starts_with(['-', '*', '_', '=']);
    starts
        && rest
            .chars()
            .all(|c| matches!(c, '-' | '*' | '_' | '=' | ' ' | '\t'))
        && rest.chars().filter(|c| !matches!(c, ' ' | '\t')).count() >= 3
}

/// `LINK_SYNTAX`: `[[\]]|<a\b`.
fn has_link_syntax(line: &str) -> bool {
    if line.contains(['[', ']']) {
        return true;
    }
    let bytes = line.as_bytes();
    line.match_indices('<').any(|(at, _)| {
        bytes
            .get(at + 1)
            .is_some_and(|b| b.eq_ignore_ascii_case(&b'a'))
            && !line[at + 2..].chars().next().is_some_and(is_word_char)
    })
}

static TASK_ITEM_BOX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([ \t]*(?:[-*+]|[0-9]+[.)])[ \t]+)\[[ xX]\]").expect("static pattern")
});
static JOINED_BREAK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"MEMRYHBK[0-9]+;<br>").expect("static pattern"));
static HARD_BREAK_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"MEMRYHBK([0-9]+);").expect("static pattern"));

/// `line.replace(TASK_ITEM_BOX, keep ? '$1' : '')`.
fn without_task_box(line: &str, keep_prefix: bool) -> String {
    TASK_ITEM_BOX
        .replace(line, |caps: &Captures| {
            if keep_prefix {
                caps[1].to_owned()
            } else {
                String::new()
            }
        })
        .into_owned()
}

/// `INLINE_SPAN_SYNTAX`: a backtick, bracket or `<`.
fn has_inline_span_syntax(text: &str) -> bool {
    text.contains(['`', '[', ']', '<'])
}

/// Mark every hard line break in `markdown` so it survives the parse. Code
/// fences are skipped; a raw `<pre>` block is not.
pub fn mask_hard_breaks(markdown: &str) -> MaskedHardBreaks {
    if markdown.is_empty() {
        return MaskedHardBreaks {
            markdown: String::new(),
            breaks: Vec::new(),
        };
    }
    let mut breaks = Vec::new();
    let mut out = String::new();
    for region in split_by_code_fences(markdown) {
        if region.is_code {
            out.push_str(&region.text);
        } else {
            out.push_str(&mask_prose_hard_breaks(&region.text, &mut breaks));
        }
    }
    MaskedHardBreaks {
        markdown: out,
        breaks,
    }
}

fn contains_br(text: &str) -> bool {
    text.as_bytes()
        .windows(3)
        .any(|w| w.eq_ignore_ascii_case(b"<br"))
}

fn mask_prose_hard_breaks(text: &str, breaks: &mut Vec<String>) -> String {
    let has_br = contains_br(text);
    if !has_br
        && !text.contains("  ")
        && !text.contains('\t')
        && !text.contains('\\')
        && !text.contains("](")
    {
        return text.to_owned();
    }

    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    let mut in_other_block = false;
    let mut in_list_item = false;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].clone();
        if js_trim(&line).is_empty() {
            in_other_block = false;
        } else if is_not_paragraph_line(&line) {
            in_other_block = true;
        }
        if js_trim(&line).is_empty() {
            in_list_item = false;
        } else if is_list_item_start(&line) {
            in_list_item = true;
        } else if is_block_start(&line) {
            in_list_item = false;
        }
        // Link and image URLs never reach the unmask, so a line with any link
        // syntax keeps its tags as they were rather than risk a token in the file.
        if has_br && !in_other_block && !has_link_syntax(&line) {
            lines[index] = replace_mid_line_breaks(&line, &mut |tag| {
                breaks.push(String::new());
                format!("{HARD_BREAK_TOKEN_PREFIX}{};{tag}", breaks.len() - 1)
            });
        }
        if index == lines.len() - 1 || js_trim(&lines[index + 1]).is_empty() {
            index += 1;
            continue;
        }
        // The parser ends a list item at a soft break inside link text too, so
        // `- [a\nb](u)` lost its link (BBF-106). Joined with a `<br>`, the item
        // keeps one link with a soft break in it.
        if in_list_item
            && !is_hard_break_line(&line)
            && !is_block_start(&lines[index + 1])
            && ends_inside_link_text(&line, &lines[index + 1..])
        {
            join_with_break(&mut lines, index);
            continue;
        }
        if js_trim(&line).is_empty() || !is_hard_break_line(&line) {
            index += 1;
            continue;
        }
        // The marker replaces the spelling rather than joining it.
        let current = lines[index].clone();
        if let Some(start) = hard_break_start(&current) {
            breaks.push(current[start..].to_owned());
            lines[index] = format!(
                "{}{HARD_BREAK_TOKEN_PREFIX}{};",
                &current[..start],
                breaks.len() - 1
            );
        }
        // A list item's continuation line becomes a child paragraph, or ends the
        // list on a lazy one, so the break is lost (BBF-99). Joined with the
        // `<br>` the item parses to, the token lands against that newline.
        let joined = format!(
            "{}{}",
            JOINED_BREAK.replace_all(&without_task_box(&lines[index], false), ""),
            lines[index + 1]
        );
        if in_list_item && !is_block_start(&lines[index + 1]) && !has_inline_span_syntax(&joined) {
            join_with_break(&mut lines, index);
            continue;
        }
        index += 1;
    }
    lines.join("\n")
}

/// `lines[index] += '<br>' + lines[index + 1].trimStart()`, dropping the next line.
fn join_with_break(lines: &mut Vec<String>, index: usize) {
    let next = lines.remove(index + 1);
    lines[index].push_str("<br>");
    lines[index].push_str(next.trim_start_matches(is_js_whitespace));
}

/// True when `line` ends inside link text that the last line of its paragraph closes.
fn ends_inside_link_text(line: &str, after: &[String]) -> bool {
    let end = after
        .iter()
        .position(|next| js_trim(next).is_empty() || is_block_start(next));
    let rest = end.map_or(after, |end| &after[..end]);
    let paragraph = std::iter::once(line)
        .chain(rest.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let rest_text = rest.join("\n");
    if !rest.last().is_some_and(|last| last.contains("](")) {
        return false;
    }
    if paragraph_breaks_join(&paragraph)
        || address_keeps_split(&paragraph)
        || contains_br(&rest_text)
        || rest[..rest.len() - 1]
            .iter()
            .any(|next| is_hard_break_line(next))
    {
        return false;
    }
    let mut depth: i32 = 0;
    for c in without_task_box(line, true).chars() {
        match c {
            '[' => depth += 1,
            ']' => depth = (depth - 1).max(0),
            _ => {}
        }
    }
    depth > 0
}

/// `/`|<(?!br>)|!\[|\\[[\]]|<br>[^\S\n]*\n|\n[^\S\n]*<br>/i`.
fn paragraph_breaks_join(paragraph: &str) -> bool {
    let bytes = paragraph.as_bytes();
    let br_at = |at: usize| {
        bytes
            .get(at..at + 4)
            .is_some_and(|w| w.eq_ignore_ascii_case(b"<br>"))
    };
    if paragraph.contains('`') || paragraph.contains("![") {
        return true;
    }
    for (at, c) in paragraph.char_indices() {
        match c {
            '<' => {
                if !br_at(at) {
                    return true;
                }
                let after = paragraph[at + 4..].trim_start_matches(is_blank);
                if after.starts_with('\n') {
                    return true;
                }
            }
            '\\' => {
                if matches!(bytes.get(at + 1), Some(b'[' | b']')) {
                    return true;
                }
            }
            '\n' => {
                let after = paragraph[at + 1..].trim_start_matches(is_blank);
                let start = paragraph.len() - after.len();
                if br_at(start) {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

/// True when an address in `paragraph` holds a title or a space, or holds a
/// parenthesis that is unbalanced or next to a backslash (BBF-107).
fn address_keeps_split(paragraph: &str) -> bool {
    for (at, _) in paragraph.match_indices("](") {
        let mut depth = 0i32;
        let mut paren = false;
        let mut backslash = false;
        let mut closed = false;
        for c in paragraph[at + 2..].chars() {
            if is_js_whitespace(c) {
                return true;
            }
            if c == '\\' {
                backslash = true;
            } else if c == '(' {
                paren = true;
                depth += 1;
            } else if c == ')' {
                let was = depth;
                depth -= 1;
                if was == 0 {
                    closed = true;
                    break;
                }
            }
        }
        if paren && (!closed || backslash) {
            return true;
        }
    }
    false
}

/// Turn each surviving token back into the second newline that spells a hard
/// break in the document, and delete any that lost its newline. For one inline
/// text run of prose.
pub fn unmask_hard_breaks(text: &str) -> String {
    if !text.contains(HARD_BREAK_TOKEN_PREFIX) {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut last = 0;
    let mut from = 0;
    while let Some(caps) = HARD_BREAK_TOKEN.captures_at(text, from) {
        let whole = caps.get(0).expect("whole match");
        let spaces_start = text[last..whole.start()].trim_end_matches(is_blank).len() + last;
        out.push_str(&text[last..spaces_start]);
        let spaces = &text[spaces_start..whole.start()];
        if text[whole.end()..].starts_with('\n') {
            out.push_str("\n\n");
            last = whole.end() + 1;
        } else {
            out.push_str(spaces);
            last = whole.end();
        }
        from = last;
    }
    out.push_str(&text[last..]);
    out
}

/// Put back the exact spelling each token replaced, for one inline text run of
/// a code block. A token with no recorded spelling is deleted.
pub fn restore_hard_break_spelling(text: &str, breaks: &[String]) -> String {
    if !text.contains(HARD_BREAK_TOKEN_PREFIX) {
        return text.to_owned();
    }
    HARD_BREAK_TOKEN
        .replace_all(text, |caps: &Captures| {
            caps[1]
                .parse::<usize>()
                .ok()
                .and_then(|index| breaks.get(index))
                .cloned()
                .unwrap_or_default()
        })
        .into_owned()
}

/// True when the text still carries a token, so callers can skip the walk.
pub fn has_hard_break_token(text: &str) -> bool {
    text.contains(HARD_BREAK_TOKEN_PREFIX)
}
