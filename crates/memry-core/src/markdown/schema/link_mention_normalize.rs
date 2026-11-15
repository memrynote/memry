//! Port of `normalizeLinkMentions` in
//! `packages/editor-schema/src/inline/link-mention-normalize.ts`: the seed turns
//! each `((mention:…))` token into a `linkMention` node, once, in the doc every
//! device receives. Left as text, each device's editor promoted it on open, and
//! two devices doing that before they synced merged into two chips per mention
//! (#3871).
//!
//! Every token `parseLinkMentionToken` accepts is promoted, a legacy one with
//! `_ * ! ~ '` raw included (#4478). The node re-encodes it, so the source
//! record keeps the file's bytes until the token's own paragraph is edited.
//! A token in a run with any active style stays text (#4652).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value as Json, json};

use crate::markdown::bn::dom_parser::rules::url::parse_like_node;
use crate::markdown::frontmatter::js::is_js_whitespace;
use crate::markdown::shared::critic_markup::uri::decode_uri_component;

/// `MENTION_TOKEN_REGEX`.
static MENTION_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\(mention:([^()\n\r]+)\)\)").expect("static pattern"));

/// `extractDomain`: `new URL(url).hostname.replace('www.', '')`, which drops the
/// first `www.` wherever it sits, and the URL itself when it does not parse.
fn extract_domain(url: &str) -> String {
    match parse_like_node(url) {
        Some(parsed) => parsed.host_str().unwrap_or("").replacen("www.", "", 1),
        None => url.to_owned(),
    }
}

/// `parseLinkMentionToken`. A payload without whitespace or a backslash is
/// decoded as it is. Otherwise both are stripped, a repair older builds' remark
/// escapes and stray spaces need, and what is left must be in the union of every
/// token alphabet and decode to a URL.
fn parse_link_mention_token(encoded: &str) -> Option<String> {
    let strip = |c: char| is_js_whitespace(c) || c == '\\';
    if !encoded.contains(strip) {
        return decode_uri_component(encoded).filter(|url| !url.is_empty());
    }
    let repaired: String = encoded.chars().filter(|&c| !strip(c)).collect();
    let in_any_alphabet = |b: u8| b.is_ascii_alphanumeric() || b".%!'*~_-".contains(&b);
    if repaired.is_empty() || !repaired.bytes().all(in_any_alphabet) {
        return None;
    }
    let url = decode_uri_component(&repaired)?;
    parse_like_node(&url).map(|_| url)
}

fn styled_text(text: &str, styles: Option<&Json>) -> Json {
    match styles {
        Some(styles) => json!({"type": "text", "text": text, "styles": styles}),
        None => Json::String(text.to_owned()),
    }
}

/// `hasActiveStyle`: a `linkMention` node carries no styles, so a token in a
/// run with code, emphasis, strikethrough, underline or a colour stays text;
/// as a chip it would lose the delimiters around it on write-back.
fn has_active_style(styles: &Json) -> bool {
    styles.as_object().is_some_and(|styles| {
        styles.values().any(|value| match value {
            Json::Bool(active) => *active,
            Json::String(colour) => colour != "default",
            _ => false,
        })
    })
}

/// `splitTextWithLinkMentions`: `None` when nothing was promoted.
fn split_text(text: &str, styles: Option<&Json>) -> Option<Vec<Json>> {
    if !text.contains("((mention:") || styles.is_some_and(has_active_style) {
        return None;
    }
    let mut segments = Vec::new();
    let mut last = 0;
    for caps in MENTION_TOKEN.captures_iter(text) {
        let full = caps.get(0).expect("whole match");
        let Some(url) = parse_link_mention_token(&caps[1]) else {
            continue;
        };
        if full.start() > last {
            segments.push(styled_text(&text[last..full.start()], styles));
        }
        let domain = extract_domain(&url);
        segments.push(json!({
            "type": "linkMention",
            "props": {"url": url, "domain": domain, "title": "", "favicon": "", "siteName": ""},
        }));
        last = full.end();
    }
    if segments.is_empty() {
        return None;
    }
    if last < text.len() {
        segments.push(styled_text(&text[last..], styles));
    }
    Some(segments)
}

/// `normalizeInlineContent`: `None` when nothing was promoted.
fn normalize_inline(content: &Json) -> Option<Json> {
    if let Json::String(text) = content {
        return split_text(text, None).map(Json::Array);
    }
    let items = content.as_array()?;
    let mut changed = false;
    let mut next = Vec::with_capacity(items.len());
    for item in items {
        let split = match item {
            Json::String(text) => split_text(text, None),
            Json::Object(node) if node.get("type").and_then(Json::as_str) == Some("text") => {
                let text = node.get("text").and_then(Json::as_str).unwrap_or("");
                let empty = Json::Object(Map::new());
                split_text(text, Some(node.get("styles").unwrap_or(&empty)))
            }
            _ => None,
        };
        match split {
            Some(segments) => {
                changed = true;
                next.extend(segments);
            }
            None => next.push(item.clone()),
        }
    }
    changed.then_some(Json::Array(next))
}

/// `normalizeTableContent`: rewrites the rows in place.
fn normalize_table(table: &mut Json) {
    let Some(rows) = table.get_mut("rows").and_then(Json::as_array_mut) else {
        return;
    };
    for row in rows {
        let Some(cells) = row.get_mut("cells").and_then(Json::as_array_mut) else {
            continue;
        };
        for cell in cells {
            if cell.is_array() {
                if let Some(content) = normalize_inline(cell) {
                    *cell = content;
                }
            } else if cell.get("type").and_then(Json::as_str) == Some("tableCell") {
                let empty = Json::String(String::new());
                let current = cell.get("content").unwrap_or(&empty);
                if let Some(content) = normalize_inline(current) {
                    cell["content"] = content;
                }
            }
        }
    }
}

/// `normalizeLinkMentions(blocks)`, in place.
pub fn normalize_link_mentions(blocks: &mut [Json]) {
    for block in blocks {
        // A code block's own text is literal; blocks nested under it are not code.
        let is_code = block.get("type").and_then(Json::as_str) == Some("codeBlock");
        if !is_code && let Some(content) = block.get_mut("content") {
            if content.is_string() || content.is_array() {
                if let Some(next) = normalize_inline(content) {
                    *content = next;
                }
            } else if content.get("type").and_then(Json::as_str) == Some("tableContent") {
                normalize_table(content);
            }
        }
        if let Some(children) = block.get_mut("children").and_then(Json::as_array_mut) {
            normalize_link_mentions(children);
        }
    }
}
