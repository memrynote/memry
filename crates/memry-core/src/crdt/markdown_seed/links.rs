//! Links: BlockNote's `parseLink` and `parseDestinationAndTitle`, and the
//! `isAllowedUri` check its link mark applies when parsing HTML.

use super::closers::Closers;
use super::inline::collect;

/// `parseLink`: the destination, the link text and where the link ends.
pub(super) fn link<'t>(
    closers: &mut Closers<'t>,
    start: usize,
) -> Option<(String, &'t [char], usize)> {
    let text = closers.text();
    let text_end = closers.closing(start, '[', ']')?;
    if text.get(text_end + 1) != Some(&'(') {
        return None;
    }
    let paren_end = closers.closing(text_end + 1, '(', ')')?;
    let raw = &text[text_end + 2..paren_end];
    let kept = kept_whole(raw);
    // An address cut at a blank with a parenthesis open in it is no link
    // (`is_unwritable`).
    if kept.is_none() && is_unwritable(&destination(raw)) {
        return None;
    }
    let href = kept.unwrap_or_else(|| destination(raw));
    Some((href, &text[start + 1..text_end], paren_end + 1))
}

/// Whether no markdown spells `address` and reads it back as itself: one with
/// a line break in it, or one that leaves a parenthesis open, as desktop's
/// `hrefParenTokens` counts them (the writer escapes the parenthesis and the
/// parser keeps the backslash). Such a link or image stays the text it was
/// (`editor-schema/src/inline/unwritable-links.ts`).
pub(super) fn is_unwritable(address: &str) -> bool {
    if address.contains('\n') {
        return true;
    }
    let mut depth = 0_usize;
    let mut chars = address.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if chars.next().is_none() {
                    return true;
                }
            }
            '(' => depth += 1,
            ')' => match depth.checked_sub(1) {
                Some(open) => depth = open,
                None => return true,
            },
            _ => {}
        }
    }
    depth != 0
}

/// A destination with whitespace is the link's `href` as written, title and
/// angle brackets included, as desktop's `maskLinkDestinations` keeps it
/// (`packages/editor-schema/src/inline/link-destinations.ts`, BBF-109).
fn kept_whole(raw: &[char]) -> Option<String> {
    let text = collect(raw);
    // JavaScript's `\s`: Unicode whitespace without U+0085, plus U+FEFF.
    let spaced = text
        .chars()
        .any(|c| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
    let kept = text == crate::domain::journal_rules::js_trim(&text)
        && spaced
        && !text.contains(['\n', '`'])
        && allowed_href(&text)
        && allowed_href(&destination(raw));
    kept.then_some(text)
}

/// The URL half of `parseDestinationAndTitle`. The title is dropped: the link
/// mark keeps only `href`.
pub(crate) fn destination(raw: &[char]) -> String {
    destination_and_title(raw).0
}

/// `parseDestinationAndTitle`: the URL, and a title quoted `"…"`, `'…'` or
/// `(…)` after it.
pub(super) fn destination_and_title(raw: &[char]) -> (String, Option<String>) {
    let raw = collect(raw);
    let raw: Vec<char> = crate::domain::journal_rules::js_trim(&raw)
        .chars()
        .collect();
    let (url, rest) = if raw.first() == Some(&'<') {
        match raw.iter().position(|c| *c == '>') {
            Some(close) => (collect(&raw[1..close]), collect(&raw[close + 1..])),
            None => (collect(&raw[1..]), String::new()),
        }
    } else {
        let split = url_end(&raw);
        (collect(&raw[..split]), collect(&raw[split..]))
    };
    let rest = crate::domain::journal_rules::js_trim(&rest);
    let quoted = |open: char, close: char| {
        rest.strip_prefix(open)
            .and_then(|inner| inner.strip_suffix(close))
            .filter(|inner| !inner.contains(close))
    };
    let title = quoted('"', '"')
        .or_else(|| quoted('\'', '\''))
        .or_else(|| quoted('(', ')'))
        .map(str::to_owned);
    (url, title)
}

/// Where an unbracketed destination ends: its first unescaped space, tab or
/// newline.
fn url_end(raw: &[char]) -> usize {
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == '\\' && i + 1 < raw.len() {
            i += 2;
            continue;
        }
        if matches!(raw[i], ' ' | '\t' | '\n') {
            return i;
        }
        i += 1;
    }
    raw.len()
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
