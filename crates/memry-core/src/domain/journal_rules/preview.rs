//! The one-line preview a journal day shows in Month and on Home.
//!
//! Mirrors `extractJournalPreview` (`domain-notes/src/journal/preview.ts`) and
//! `replaceWikiLinks` / `wikiLinkLabel` / `splitWikiTarget`
//! (`shared/src/wiki-target.ts`). The core has no regex engine, so each JS
//! regex is a hand-written scanner with the same global-replace semantics:
//! left to right, a match resumes the scan at its end, a failed position
//! advances by one. None of the patterns can match inside a surrogate pair, so
//! scanning by `char` equals JS's scan by code unit.

use super::{is_js_whitespace, js_trim};

/// The preview length desktop asks for everywhere it shows one.
pub const JOURNAL_PREVIEW_LENGTH: usize = 100;

/// Markdown to a short plain preview: headings, link targets, wiki-link
/// syntax, images and emphasis markers removed, whitespace collapsed, then
/// truncated at a word boundary when one falls in the last 30 % of the limit.
///
/// `max_length` counts UTF-16 code units. A cut that splits a surrogate pair
/// (JS keeps the lone half) yields U+FFFD, the one thing a Rust `String`
/// cannot carry.
pub fn extract_journal_preview(content: &str, max_length: usize) -> String {
    let chars: Vec<char> = content.chars().collect();
    let chars = replace_all(&chars, |c, i| {
        strip_heading(c, i).map(|end| (end, Vec::new()))
    });
    let chars = replace_all(&chars, markdown_link);
    let chars = replace_all(&chars, wiki_link);
    let chars = replace_all(&chars, |c, i| image(c, i).map(|end| (end, Vec::new())));
    let chars = replace_all(&chars, emphasis);
    let collapsed = collapse_whitespace(&chars);
    let cleaned = js_trim(&collapsed);

    let units: Vec<u16> = cleaned.encode_utf16().collect();
    if units.len() <= max_length {
        return cleaned.to_owned();
    }
    let truncated = &units[..max_length];
    let last_space = truncated.iter().rposition(|&unit| unit == u16::from(b' '));
    let kept = match last_space {
        // `lastSpace > maxLength * 0.7`, compared as JS numbers.
        Some(space) if space as f64 > max_length as f64 * 0.7 => &truncated[..space],
        _ => truncated,
    };
    let mut preview = String::from_utf16_lossy(kept);
    preview.push_str("...");
    preview
}

/// `text.replace(/pattern/g, …)`: `matcher(chars, i)` returns the match end
/// and its replacement when the pattern matches at `i`.
fn replace_all(
    chars: &[char],
    matcher: impl Fn(&[char], usize) -> Option<(usize, Vec<char>)>,
) -> Vec<char> {
    let mut out = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        match matcher(chars, i) {
            Some((end, replacement)) if end > i => {
                out.extend(replacement);
                i = end;
            }
            _ => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// The index of the first `stop` at or after `from`, when at least one other
/// character precedes it (`[^stop]+stop`).
fn run_until(chars: &[char], from: usize, stop: impl Fn(char) -> bool) -> Option<usize> {
    let offset = chars.get(from..)?.iter().position(|&c| stop(c))?;
    (offset > 0).then_some(from + offset)
}

fn at(chars: &[char], i: usize, expected: char) -> bool {
    chars.get(i) == Some(&expected)
}

/// JS LineTerminator: where a multiline `^` may match.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^#+\s+/gm`: the match end.
fn strip_heading(chars: &[char], i: usize) -> Option<usize> {
    if i > 0 && !is_line_terminator(chars[i - 1]) {
        return None;
    }
    let hashes = chars[i..].iter().take_while(|&&c| c == '#').count();
    if hashes == 0 {
        return None;
    }
    let spaces = chars[i + hashes..]
        .iter()
        .take_while(|&&c| is_js_whitespace(c))
        .count();
    (spaces > 0).then_some(i + hashes + spaces)
}

/// `/\[([^\]]+)\]\([^)]+\)/g` → `$1`.
fn markdown_link(chars: &[char], i: usize) -> Option<(usize, Vec<char>)> {
    if !at(chars, i, '[') {
        return None;
    }
    let close = run_until(chars, i + 1, |c| c == ']')?;
    if !at(chars, close + 1, '(') {
        return None;
    }
    let paren = run_until(chars, close + 2, |c| c == ')')?;
    Some((paren + 1, chars[i + 1..close].to_vec()))
}

/// `/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g` → `wikiLinkLabel(target, alias)`.
fn wiki_link(chars: &[char], i: usize) -> Option<(usize, Vec<char>)> {
    if !at(chars, i, '[') || !at(chars, i + 1, '[') {
        return None;
    }
    let target_end = run_until(chars, i + 2, |c| c == ']' || c == '|')?;
    let target: String = chars[i + 2..target_end].iter().collect();
    let (alias, close) = if at(chars, target_end, '|') {
        let alias_end = run_until(chars, target_end + 1, |c| c == ']')?;
        let alias: String = chars[target_end + 1..alias_end].iter().collect();
        (Some(alias), alias_end)
    } else {
        (None, target_end)
    };
    if !at(chars, close, ']') || !at(chars, close + 1, ']') {
        return None;
    }
    let label = wiki_link_label(&target, alias.as_deref());
    Some((close + 2, label.chars().collect()))
}

/// `wikiLinkLabel`: the alias when it has text, else the note half, else the
/// heading half.
fn wiki_link_label(target: &str, alias: Option<&str>) -> String {
    let chosen = alias.map(js_trim).unwrap_or("");
    if !chosen.is_empty() {
        return chosen.to_owned();
    }
    let raw = js_trim(target);
    match raw.find('#') {
        None => raw.to_owned(),
        Some(hash) => {
            let note = js_trim(&raw[..hash]);
            if !note.is_empty() {
                return note.to_owned();
            }
            // `split('#')` always yields a last segment.
            let heading = raw[hash + 1..].rsplit('#').next().unwrap_or("");
            js_trim(heading).to_owned()
        }
    }
}

/// `/!\[[^\]]*\]\([^)]+\)/g`: the match end.
fn image(chars: &[char], i: usize) -> Option<usize> {
    if !at(chars, i, '!') || !at(chars, i + 1, '[') {
        return None;
    }
    let close = i + 2 + chars[i + 2..].iter().position(|&c| c == ']')?;
    if !at(chars, close + 1, '(') {
        return None;
    }
    let paren = run_until(chars, close + 2, |c| c == ')')?;
    Some(paren + 1)
}

fn is_emphasis_marker(c: char) -> bool {
    c == '*' || c == '_'
}

/// `/[*_]{1,3}([^*_]+)[*_]{1,3}/g` → `$1`. Backtracking cannot change the
/// result: a shorter opening leaves a marker where the body must start, and a
/// shorter body leaves a non-marker where the closing must start.
fn emphasis(chars: &[char], i: usize) -> Option<(usize, Vec<char>)> {
    let opening = chars[i..]
        .iter()
        .take_while(|&&c| is_emphasis_marker(c))
        .count();
    if opening == 0 || opening > 3 {
        return None;
    }
    let body_start = i + opening;
    let body_end = run_until(chars, body_start, is_emphasis_marker)?;
    let closing = chars[body_end..]
        .iter()
        .take(3)
        .take_while(|&&c| is_emphasis_marker(c))
        .count();
    Some((body_end + closing, chars[body_start..body_end].to_vec()))
}

/// `/\s+/g` → `' '`.
fn collapse_whitespace(chars: &[char]) -> String {
    let mut out = String::with_capacity(chars.len());
    let mut in_run = false;
    for &c in chars {
        if is_js_whitespace(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(content: &str) -> String {
        extract_journal_preview(content, JOURNAL_PREVIEW_LENGTH)
    }

    #[test]
    fn emphasis_run_of_four_markers_falls_through_to_three() {
        assert_eq!(preview("****x**"), "*x");
    }

    #[test]
    fn heading_needs_line_start_and_whitespace() {
        assert_eq!(preview("a # b\n#c\n## d"), "a # b #c d");
    }

    #[test]
    fn wiki_link_without_close_is_kept() {
        assert_eq!(preview("[[a|b] c"), "[[a|b] c");
        assert_eq!(preview("[[a]] [[#x|  ]]"), "a x");
    }

    #[test]
    fn surrogate_split_becomes_replacement_character() {
        assert_eq!(extract_journal_preview("a😀b", 2), "a\u{FFFD}...");
    }
}
