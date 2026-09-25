//! Links: BlockNote's `parseLink` and `parseDestinationAndTitle`, and the
//! `isAllowedUri` check its link mark applies when parsing HTML.

use super::inline::collect;

/// `findClosingBracket` / `findClosingParen`.
pub(super) fn closing(text: &[char], open_at: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0i32;
    let mut i = open_at;
    while i < text.len() {
        if text[i] == '\\' && i + 1 < text.len() {
            i += 2;
            continue;
        }
        if text[i] == open {
            depth += 1;
        }
        if text[i] == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

/// `parseLink`: the destination, the link text and where the link ends.
pub(super) fn link(text: &[char], start: usize) -> Option<(String, &[char], usize)> {
    let text_end = closing(text, start, '[', ']')?;
    if text.get(text_end + 1) != Some(&'(') {
        return None;
    }
    let paren_end = closing(text, text_end + 1, '(', ')')?;
    let href = destination(&text[text_end + 2..paren_end]);
    Some((href, &text[start + 1..text_end], paren_end + 1))
}

/// The URL half of `parseDestinationAndTitle`. The title is dropped: the link
/// mark keeps only `href`.
pub(super) fn destination(raw: &[char]) -> String {
    let raw = collect(raw);
    let raw: Vec<char> = crate::domain::journal_rules::js_trim(&raw)
        .chars()
        .collect();
    if raw.first() == Some(&'<') {
        return match raw.iter().position(|c| *c == '>') {
            Some(close) => collect(&raw[1..close]),
            None => collect(&raw[1..]),
        };
    }
    let mut split = raw.len();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == '\\' && i + 1 < raw.len() {
            i += 2;
            continue;
        }
        if matches!(raw[i], ' ' | '\t' | '\n') {
            split = i;
            break;
        }
        i += 1;
    }
    collect(&raw[..split])
}

/// `isAllowedUri` of BlockNote's link mark, after its `!href` check.
pub(super) fn allowed_href(href: &str) -> bool {
    let cleaned: Vec<char> = href
        .chars()
        .filter(|c| {
            !matches!(*c as u32, 0x00..=0x20 | 0xA0 | 0x1680 | 0x180E | 0x2000..=0x2029 | 0x205F | 0x3000)
        })
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let Some(first) = cleaned.first() else {
        return false;
    };
    let cleaned_text = collect(&cleaned);
    const PROTOCOLS: [&str; 10] = [
        "http:", "https:", "ftp:", "ftps:", "mailto:", "tel:", "callto:", "sms:", "cid:", "xmpp:",
    ];
    if PROTOCOLS
        .iter()
        .any(|protocol| cleaned_text.starts_with(protocol))
    {
        return true;
    }
    if !first.is_ascii_lowercase() {
        return true;
    }
    let scheme_char = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || "+.-".contains(c);
    let blocks_end = |c: char| c.is_ascii_lowercase() || "+.-:".contains(c);
    for k in 1..=cleaned.len() {
        if !scheme_char(cleaned[k - 1]) {
            return false;
        }
        if k == cleaned.len() || !blocks_end(cleaned[k]) {
            return true;
        }
    }
    false
}
