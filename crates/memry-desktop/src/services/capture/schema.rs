//! The `/capture` body, checked as `ArticleCaptureSchema` (`packages/contracts/src/capture-api.ts`,
//! zod 4.3) checks it: unknown keys dropped, an absent optional key allowed and `null` refused,
//! `url` trimmed and parsed as an absolute URL (the trimmed string is what zod outputs), and
//! string bounds counted in UTF-16 code units as zod's `.max()` counts `.length`.

use std::borrow::Cow;

use memry_core::domain::inbox::ingest::{
    InboxArticle, InboxArticleProperties, InboxExtractionStatus,
};
use serde_json::{Map, Value};

/// A capture that passed the schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArticleCapture {
    pub article: InboxArticle,
    pub screenshot_data_url: Option<String>,
    pub pdf_data_url: Option<String>,
    pub pdf_filename: Option<String>,
    pub tags: Option<Vec<String>>,
    pub force: bool,
    pub folder: Option<String>,
    pub vault_id: Option<String>,
}

const MODES: [&str; 4] = ["article", "selection", "screenshot", "pdf"];

/// `json` with every unpaired UTF-16 surrogate escape inside a string (`\ud83d` without its low
/// half, or a low half alone) replaced by `\ufffd`, as `toWellFormed` would. The extension cuts
/// `excerpt` at 200 UTF-16 units, which can split an emoji, and `JSON.stringify` writes the
/// half as an escape; `JSON.parse` accepts it, `serde_json` does not.
pub fn to_well_formed(json: &str) -> Cow<'_, str> {
    let bytes = json.as_bytes();
    let mut out = String::new();
    let (mut copied, mut at, mut in_string) = (0, 0, false);
    while at < bytes.len() {
        match bytes[at] {
            b'"' => {
                in_string = !in_string;
                at += 1;
            }
            b'\\' if in_string => {
                let Some(unit) = escaped_unit(bytes, at) else {
                    // `\\`, `\"` and the other two-byte escapes.
                    at += 2;
                    continue;
                };
                let high = (0xd800..0xdc00).contains(&unit);
                let paired = high && escaped_unit(bytes, at + 6).is_some_and(is_low_surrogate);
                if paired {
                    at += 12;
                } else if high || is_low_surrogate(unit) {
                    out.push_str(&json[copied..at]);
                    out.push_str("\\ufffd");
                    at += 6;
                    copied = at;
                } else {
                    at += 6;
                }
            }
            _ => at += 1,
        }
    }
    if copied == 0 {
        return Cow::Borrowed(json);
    }
    out.push_str(&json[copied..]);
    Cow::Owned(out)
}

/// The code unit of a `\uXXXX` escape starting at `at`.
fn escaped_unit(bytes: &[u8], at: usize) -> Option<u16> {
    let hex = bytes.get(at..at + 6)?.strip_prefix(b"\\u")?;
    if !hex.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    u16::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()
}

fn is_low_surrogate(unit: u16) -> bool {
    (0xdc00..0xe000).contains(&unit)
}

/// `None` when `value` is not a valid capture (`422 invalid-capture`).
pub fn parse(value: &Value) -> Option<ArticleCapture> {
    let body = value.as_object()?;
    let url = url(body.get("url")?)?;
    let mode = string(body.get("mode")?)?;
    if !MODES.contains(&mode.as_str()) {
        return None;
    }
    let extraction_status = match string(body.get("extractionStatus")?)?.as_str() {
        "full" => InboxExtractionStatus::Full,
        "partial" => InboxExtractionStatus::Partial,
        "failed" => InboxExtractionStatus::Failed,
        _ => return None,
    };
    let article = InboxArticle {
        url,
        content_markdown: string(body.get("contentMarkdown")?)?,
        excerpt: string(body.get("excerpt")?)?,
        extraction_status,
        properties: properties(body.get("properties")?)?,
        hero_image: optional(body, "heroImage", string)?,
    };
    Some(ArticleCapture {
        article,
        screenshot_data_url: optional(body, "screenshotDataUrl", string)?,
        pdf_data_url: optional(body, "pdfDataUrl", string)?,
        pdf_filename: optional(body, "pdfFilename", |v| bounded(v, 0, 255))?,
        tags: optional(body, "tags", tags)?,
        force: optional(body, "force", Value::as_bool)?.unwrap_or(false),
        folder: optional(body, "folder", |v| bounded(v, 1, 1024))?,
        vault_id: optional(body, "vaultId", |v| bounded(v, 1, 128))?,
    })
}

fn properties(value: &Value) -> Option<InboxArticleProperties> {
    let p = value.as_object()?;
    Some(InboxArticleProperties {
        title: string(p.get("title")?)?,
        source: string(p.get("source")?)?,
        author: optional(p, "author", string)?,
        published: optional(p, "published", string)?,
        created: string(p.get("created")?)?,
        description: optional(p, "description", string)?,
    })
}

/// `Some(None)` for an absent key, `None` (invalid) for a present key `read` refuses, `null`
/// included.
fn optional<T>(
    map: &Map<String, Value>,
    key: &str,
    read: impl Fn(&Value) -> Option<T>,
) -> Option<Option<T>> {
    match map.get(key) {
        None => Some(None),
        Some(value) => read(value).map(Some),
    }
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn bounded(value: &Value, min: usize, max: usize) -> Option<String> {
    let text = value.as_str()?;
    let len = text.encode_utf16().count();
    (min..=max).contains(&len).then(|| text.to_owned())
}

fn tags(value: &Value) -> Option<Vec<String>> {
    value.as_array()?.iter().map(string).collect()
}

/// `z.url()`: the input trimmed as JavaScript's `String.prototype.trim` trims, then parsed by
/// `new URL()` (the `url` crate is the same WHATWG parser).
fn url(value: &Value) -> Option<String> {
    let trimmed = value.as_str()?.trim_matches(is_js_whitespace);
    url::Url::parse(trimmed).ok()?;
    Some(trimmed.to_owned())
}

/// ECMAScript WhiteSpace and LineTerminator, which `trim` removes. Rust's `char::is_whitespace`
/// differs (it has U+0085 and lacks U+FEFF).
pub(super) fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
