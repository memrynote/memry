//! Port of `packages/shared/src/html-comments.ts`: HTML and `%% … %%` comments
//! carried through the markdown parse as one-word hex tokens.
//!
//! The token prefix ends in a word drawn once per process, so note text does not
//! hold a token (BBF-30). [`pin_process_word`] fixes the word for the conformance
//! tests, which cannot know a random one.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::{LazyLock, OnceLock};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::markdown::shared::empty_lines::JS_WS;
use crate::markdown::shared::markdown_code::replace_markdown_comments;

static TOKEN_PREFIX: OnceLock<String> = OnceLock::new();

/// Twelve random capital letters, as `String.fromCharCode(65 + byte % 26)` gives.
pub(crate) fn random_process_word() -> String {
    let state = RandomState::new();
    (0..12u8)
        .map(|i| {
            let mut hasher = state.build_hasher();
            hasher.write_u8(i);
            char::from(b'A' + (hasher.finish() % 26) as u8)
        })
        .collect()
}

fn token_prefix() -> &'static str {
    TOKEN_PREFIX.get_or_init(|| format!("MEMRYCMT{}", random_process_word()))
}

/// Fixes the process word. Fails when a different word is already in use.
pub fn pin_process_word(word: &str) -> Result<(), String> {
    let prefix = format!("MEMRYCMT{word}");
    let current = TOKEN_PREFIX.get_or_init(|| prefix.clone());
    if *current == prefix {
        Ok(())
    } else {
        Err(format!("the token prefix is already {current}"))
    }
}

pub fn encode_html_comment_token(source: &str) -> String {
    let mut out = String::from(token_prefix());
    for byte in source.as_bytes() {
        out.push_str(&format!("{byte:02x}"));
    }
    out.push('X');
    out
}

/// `TextDecoder#decode` of the bytes `hex` spells: pairs read as `parseInt(.., 16)`,
/// an odd digit dropped, invalid UTF-8 replaced, a leading BOM removed.
fn decode_hex(hex: &str) -> String {
    let bytes: Vec<u8> = (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0))
        .collect();
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

pub fn has_html_comment_token(text: &str) -> bool {
    text.contains(token_prefix())
}

/// The next token at or after `from`: its start, its end and its hex digits.
fn find_token(text: &str, from: usize) -> Option<(usize, usize, &str)> {
    let prefix = token_prefix();
    let bytes = text.as_bytes();
    let mut from = from;
    loop {
        let start = from + text.get(from..)?.find(prefix)?;
        let hex_start = start + prefix.len();
        let mut end = hex_start;
        while bytes
            .get(end)
            .is_some_and(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            end += 1;
        }
        if bytes.get(end) == Some(&b'X') {
            return Some((start, end + 1, &text[hex_start..end]));
        }
        from = start + 1;
    }
}

/// Every token in `text` replaced by the comment it carries.
pub fn decode_html_comment_tokens(text: &str) -> String {
    if !has_html_comment_token(text) {
        return text.to_owned();
    }
    let mut out = String::new();
    let mut last = 0;
    while let Some((start, end, hex)) = find_token(text, last) {
        out.push_str(&text[last..start]);
        out.push_str(&decode_hex(hex));
        last = end;
    }
    out.push_str(&text[last..]);
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HtmlCommentPart {
    Text { text: String },
    Comment { source: String },
}

/// `text` cut at its tokens, empty text parts left out.
pub fn split_html_comment_tokens(text: &str) -> Vec<HtmlCommentPart> {
    let mut parts = Vec::new();
    let mut last = 0;
    while let Some((start, end, hex)) = find_token(text, last) {
        if start > last {
            parts.push(HtmlCommentPart::Text {
                text: text[last..start].to_owned(),
            });
        }
        parts.push(HtmlCommentPart::Comment {
            source: decode_hex(hex),
        });
        last = end;
    }
    if last < text.len() {
        parts.push(HtmlCommentPart::Text {
            text: text[last..].to_owned(),
        });
    }
    parts
}

/// The JS `.`: anything but a line terminator.
const DOT: &str = r"[^\n\r\u{2028}\u{2029}]";

static MARKER_COMMENT: LazyLock<Regex> = LazyLock::new(|| {
    let patterns = [
        r"^<!-- file:\{[^}]+\} -->$".to_owned(),
        format!(r"^<!--[{JS_WS}]*memry:block-nesting-level=[0-9]+[{JS_WS}]*-->$"),
        r"^<!-- colors:\{[^}]*\} -->$".to_owned(),
        format!(r"^<!-- table-colors:\{{{DOT}*\}} -->$"),
        format!(r"^<!-- table-align:\{{{DOT}*\}} -->$"),
        r"^<!-- align:(?:center|right|justify) -->$".to_owned(),
        format!(r"^<!-- table-layout:\{{{DOT}*\}} -->$"),
    ];
    Regex::new(&format!("(?:{})", patterns.join("|"))).expect("static pattern")
});

static WRITING_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^<!--[{JS_WS}]*/?(?:alt|ghost)(?::[A-Za-z0-9_-]{{1,64}})?[{JS_WS}]*-->$"
    ))
    .expect("static pattern")
});

/// Memry's own marker comments keep the parsers that read them: a sidecar,
/// file or nesting marker on a line of its own, and a writing tools marker
/// anywhere.
fn is_memry_marker(comment: &str, whole_line: bool) -> bool {
    WRITING_MARKER.is_match(comment) || (whole_line && MARKER_COMMENT.is_match(comment))
}

const LINK_CARD_KEEP: &str = "MEMRYLINKCARD";

/// A run of `**`, `~~`, `*` or `_` tokens (`(?:\*\*|~~|\*|_)*`) read from `at`:
/// where it ends, or `None` when a lone `~` cannot be tokenised.
fn emphasis_run_end(text: &str, at: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut end = at;
    while bytes
        .get(end)
        .is_some_and(|b| matches!(b, b'*' | b'_' | b'~'))
    {
        end += 1;
    }
    let mut tildes = 0;
    for b in &bytes[at..end] {
        if *b == b'~' {
            tildes += 1;
        } else {
            if tildes % 2 == 1 {
                return None;
            }
            tildes = 0;
        }
    }
    (tildes % 2 == 0).then_some(end)
}

/// The paragraph that must follow a link-card line: one `[[link]]`, optionally
/// wrapped in emphasis, that ends its line.
fn is_sole_wiki_link_line(text: &str, at: usize) -> bool {
    let Some(at) = emphasis_run_end(text, at) else {
        return false;
    };
    let Some(rest) = text[at..].strip_prefix("[[") else {
        return false;
    };
    let target = rest.find([']', '|', '\n']).unwrap_or(rest.len());
    if target == 0 {
        return false;
    }
    let mut rest = &rest[target..];
    if let Some(alias) = rest.strip_prefix('|') {
        let len = alias.find([']', '\n']).unwrap_or(alias.len());
        if len == 0 {
            return false;
        }
        rest = &alias[len..];
    }
    let Some(rest) = rest.strip_prefix("]]") else {
        return false;
    };
    let at = text.len() - rest.len();
    let Some(end) = emphasis_run_end(text, at) else {
        return false;
    };
    text[end..]
        .chars()
        .next()
        .is_none_or(|c| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

/// `LINK_CARD_CANDIDATE` (flags `gm`): a `link-card` marker line that is
/// directly followed, after any other comment lines, by a paragraph that is one
/// `[[link]]`. Returns the end of the marker line.
fn link_card_candidate_end(text: &str, start: usize) -> Option<usize> {
    const OPEN: &str = "<!-- link-card:{";
    const CLOSE: &str = "} -->";
    let rest = &text[start..];
    if !rest.starts_with(OPEN) {
        return None;
    }
    let line_end = start + rest.find('\n')?;
    let line = &text[start..line_end];
    if line.len() < OPEN.len() + CLOSE.len()
        || !line.ends_with(CLOSE)
        || line[OPEN.len()..line.len() - CLOSE.len()].contains(['\r', '\u{2028}', '\u{2029}'])
    {
        return None;
    }
    let mut at = line_end + 1;
    while let Some(n) = text[at..].find('\n') {
        let next = &text[at..at + n];
        if next.len() >= 9 && next.starts_with("<!-- ") && next.ends_with(" -->") {
            at += n + 1;
        } else {
            break;
        }
    }
    is_sole_wiki_link_line(text, at).then_some(line_end)
}

/// `parseLinkCardMarker(line)` is non-null: the line names a valid setting.
fn is_valid_link_card_marker(line: &str) -> bool {
    let Some(json) = line
        .strip_prefix("<!-- link-card:")
        .and_then(|rest| rest.strip_suffix(" -->"))
    else {
        return false;
    };
    if !json.starts_with('{')
        || !json.ends_with('}')
        || json.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
    {
        return false;
    }
    let Ok(serde_json::Value::Object(parsed)) = serde_json::from_str::<serde_json::Value>(json)
    else {
        return false;
    };
    let mut any = false;
    if let Some(size) = parsed.get("size") {
        if !matches!(size.as_str(), Some("none" | "small" | "medium")) {
            return false;
        }
        any = true;
    }
    for key in ["cover", "preview"] {
        if let Some(flag) = parsed.get(key) {
            if !flag.is_boolean() {
                return false;
            }
            any = true;
        }
    }
    any
}

/// Every HTML and `%% … %%` comment outside code replaced by its token, except
/// Memry's own markers and a valid `link-card` line (#2845).
pub fn mask_html_comments(markdown: &str) -> String {
    let mut kept = String::with_capacity(markdown.len());
    let mut last = 0;
    let mut start = 0;
    let mut starts = vec![0];
    starts.extend(markdown.char_indices().filter_map(|(at, c)| {
        matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}').then_some(at + c.len_utf8())
    }));
    for line_start in starts {
        if line_start < start {
            continue;
        }
        if let Some(end) = link_card_candidate_end(markdown, line_start) {
            let line = &markdown[line_start..end];
            kept.push_str(&markdown[last..line_start]);
            if is_valid_link_card_marker(line) {
                kept.push_str(LINK_CARD_KEEP);
                kept.push_str(&line["<!--".len()..]);
            } else {
                kept.push_str(line);
            }
            last = end;
            start = end;
        }
    }
    kept.push_str(&markdown[last..]);

    let open_token = encode_html_comment_token("<!--");
    replace_markdown_comments(
        &kept,
        &mut |source, whole_line, _| {
            if is_memry_marker(source, whole_line) {
                source.to_owned()
            } else {
                encode_html_comment_token(source)
            }
        },
        "<!--",
        &open_token,
    )
    .replace(LINK_CARD_KEEP, "<!--")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_process_word_is_twelve_capitals() {
        let word = random_process_word();
        assert_eq!(word.len(), 12);
        assert!(word.chars().all(|c| c.is_ascii_uppercase()));
    }

    #[test]
    fn a_token_round_trips_through_its_hex() {
        let token = encode_html_comment_token("<!-- \u{65e5} -->");
        assert_eq!(decode_html_comment_tokens(&token), "<!-- \u{65e5} -->");
    }
}
