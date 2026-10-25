//! Port of `packages/editor-schema/src/inline/link-destinations.ts`: a link
//! destination that holds whitespace, kept whole as the link's `href` (BBF-109).
//!
//! Such a destination travels as an inert placeholder and comes back as the
//! link's `href`, byte for byte. The placeholder carries a word drawn once per
//! process, so note text does not hold one; [`pin_process_word`] fixes it for the
//! conformance tests.

use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde::Serialize;

use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};
use crate::markdown::shared::html_comments::random_process_word;
use crate::markdown::shared::markdown_fences::FenceTracker;

struct Placeholders {
    prefix: String,
    pattern: Regex,
}

static PLACEHOLDERS: OnceLock<Placeholders> = OnceLock::new();

fn placeholders_for(word: &str) -> Placeholders {
    let prefix = format!("MEMRYLNK{word}");
    let pattern = Regex::new(&format!("{prefix}([0-9]+)X")).expect("a placeholder pattern");
    Placeholders { prefix, pattern }
}

fn placeholders() -> &'static Placeholders {
    PLACEHOLDERS.get_or_init(|| placeholders_for(&random_process_word()))
}

/// Fixes the process word. Fails when a different word is already in use.
pub fn pin_process_word(word: &str) -> Result<(), String> {
    let wanted = placeholders_for(word);
    let current = PLACEHOLDERS.get_or_init(|| placeholders_for(word));
    if current.prefix == wanted.prefix {
        Ok(())
    } else {
        Err(format!(
            "the placeholder prefix is already {}",
            current.prefix
        ))
    }
}

fn placeholder(index: usize) -> String {
    format!("{}{index}X", placeholders().prefix)
}

const ALLOWED_SCHEMES: [&str; 10] = [
    "http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp",
];

/// BlockNote's `isAllowedUri` (link.ts), over a URI with its whitespace removed:
/// `^(?:(?:http|…|xmpp):|[^a-z]|[a-z0-9+.-]+(?:[^a-z+.\-:]|$))` with the `i` flag.
fn is_allowed_uri(uri: &str) -> bool {
    let bytes = uri.as_bytes();
    if let Some(colon) = uri.find(':')
        && ALLOWED_SCHEMES
            .iter()
            .any(|scheme| uri[..colon].eq_ignore_ascii_case(scheme))
    {
        return true;
    }
    let Some(first) = uri.chars().next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return true;
    }
    let run = bytes
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
        .count();
    // The run may end early where a digit follows (a digit is outside the
    // second class's exclusions), or at its end before anything but a colon.
    bytes[1..run].iter().any(u8::is_ascii_digit) || bytes.get(run) != Some(&b':')
}

/// `UNICODE_WHITESPACE`: `[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]`.
fn is_uri_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{20}'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{180E}'
            | '\u{2000}'..='\u{2029}'
            | '\u{205F}'
            | '\u{3000}'
    )
}

/// BlockNote's `findClosingBracket` / `findClosingParen`. Offsets are bytes;
/// only ASCII bytes are compared, so the byte after a backslash stands in for
/// the UTF-16 unit JavaScript skips.
fn closing(text: &[u8], open_at: usize, open: u8, close: u8) -> Option<usize> {
    let mut depth = 0i32;
    let mut at = open_at;
    while at < text.len() {
        if text[at] == b'\\' && at + 1 < text.len() {
            at += 2;
            continue;
        }
        if text[at] == open {
            depth += 1;
        }
        if text[at] == close {
            depth -= 1;
            if depth == 0 {
                return Some(at);
            }
        }
        at += 1;
    }
    None
}

/// The address half of BlockNote's `parseDestinationAndTitle`.
pub fn link_destination(href: &str) -> String {
    let raw = js_trim(href);
    if let Some(rest) = raw.strip_prefix('<') {
        return match rest.find('>') {
            Some(close) => rest[..close].to_owned(),
            None => rest.to_owned(),
        };
    }
    let bytes = raw.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' && at + 1 < bytes.len() {
            at += 1;
        } else if matches!(bytes[at], b' ' | b'\t' | b'\n') {
            return raw[..at].to_owned();
        }
        at += 1;
    }
    raw.to_owned()
}

/// `href` with its address half replaced and the rest, a title or nothing, kept
/// as written (BBF-112). An address with whitespace, or one that was angled, is
/// written in angle brackets.
pub fn with_link_destination(href: &str, address: &str) -> String {
    let raw = js_trim(href);
    let angled = raw.starts_with('<') && raw.contains('>');
    let rest = if angled {
        &raw[raw.find('>').map_or(0, |at| at + 1)..]
    } else if raw.starts_with('<') {
        // `raw.slice(raw.length - 1)`: the destination is everything after the `<`.
        raw.char_indices()
            .next_back()
            .map_or("", |(at, _)| &raw[at..])
    } else {
        &raw[link_destination(raw).len()..]
    };
    let spaced = address.chars().any(is_js_whitespace);
    if rest.is_empty() && !spaced {
        return address.to_owned();
    }
    if angled || spaced {
        format!("<{address}>{rest}")
    } else {
        format!("{address}{rest}")
    }
}

fn kept_whole(raw: &str) -> bool {
    raw == js_trim(raw)
        && raw.chars().any(is_js_whitespace)
        && !raw.contains(['\n', '`'])
        && [raw.to_owned(), link_destination(raw)].iter().all(|uri| {
            let bare: String = uri.chars().filter(|c| !is_uri_whitespace(*c)).collect();
            is_allowed_uri(&bare)
        })
}

fn mask_segment(text: &str, destinations: &mut Vec<String>) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut last = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\\' {
            at += 2;
            continue;
        }
        if bytes[at] != b'[' {
            at += 1;
            continue;
        }
        let Some(text_end) = closing(bytes, at, b'[', b']') else {
            at += 1;
            continue;
        };
        if bytes.get(text_end + 1) != Some(&b'(') {
            at += 1;
            continue;
        }
        let Some(paren_end) = closing(bytes, text_end + 1, b'(', b')') else {
            at += 1;
            continue;
        };
        let raw = &text[text_end + 2..paren_end];
        if !(at > 0 && bytes[at - 1] == b'!') && kept_whole(raw) {
            destinations.push(raw.to_owned());
            out.push_str(&text[last..text_end + 2]);
            out.push_str(&placeholder(destinations.len() - 1));
            last = paren_end;
        }
        at = paren_end + 1;
    }
    out.push_str(&text[last.min(text.len())..]);
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MaskedLinkDestinations {
    pub markdown: String,
    /// The destinations, by placeholder index. Empty when none was masked.
    pub destinations: Vec<String>,
}

/// Replace each spaced link destination outside a code fence with a placeholder.
pub fn mask_link_destinations(markdown: &str) -> MaskedLinkDestinations {
    let unchanged = || MaskedLinkDestinations {
        markdown: markdown.to_owned(),
        destinations: Vec::new(),
    };
    if !markdown.contains("](") {
        return unchanged();
    }
    let mut destinations = Vec::new();
    let mut fence = FenceTracker::new();
    let mut out: Vec<String> = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    for line in markdown.split('\n') {
        if fence.consume(line) {
            if !prose.is_empty() {
                out.push(mask_segment(&prose.join("\n"), &mut destinations));
                prose.clear();
            }
            out.push(line.to_owned());
        } else {
            prose.push(line);
        }
    }
    if !prose.is_empty() {
        out.push(mask_segment(&prose.join("\n"), &mut destinations));
    }
    if destinations.is_empty() {
        return unchanged();
    }
    MaskedLinkDestinations {
        markdown: out.join("\n"),
        destinations,
    }
}

/// Put back the destinations [`mask_link_destinations`] hid, in a run's text or
/// a link's `href`.
pub fn restore_link_destinations(text: &str, destinations: &[String]) -> String {
    if destinations.is_empty() || !text.contains("MEMRYLNK") {
        return text.to_owned();
    }
    placeholders()
        .pattern
        .replace_all(text, |caps: &Captures| {
            caps[1]
                .parse::<usize>()
                .ok()
                .and_then(|index| destinations.get(index))
                .cloned()
                .unwrap_or_else(|| caps[0].to_owned())
        })
        .into_owned()
}
