//! `dist/extractors/chatgpt.js`.

use crate::web::extract::dom::NodeId;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{decode_uri_component, is_js_whitespace, trim};
use url::Url;

use super::base::{Cx, Extracted, Extractor, attr_of, text_of, trimmed};
use super::conversation::{
    Conversation, ConversationMeta, Footnote, Message, extract_conversation, page_title,
    truncated_title,
};

const TURN: &str = r#"[data-testid^="conversation-turn-"]"#;
const SR_HEADINGS: &str = "h4.sr-only, h5.sr-only, h6.sr-only";

pub struct ChatGptExtractor {
    turns: Vec<NodeId>,
    footnotes: Vec<Footnote>,
    cached: Option<Vec<Message>>,
}

impl ChatGptExtractor {
    pub fn new(cx: &mut Cx) -> Result<Self, ExtractError> {
        Ok(Self {
            turns: cx.qsa(TURN)?,
            footnotes: Vec::new(),
            cached: None,
        })
    }

    /// `getMessageContentElements`: the outermost `.markdown, .whitespace-pre-wrap` elements.
    fn content_elements(cx: &Cx, el: NodeId) -> Result<Vec<NodeId>, ExtractError> {
        let selector = ".markdown, .whitespace-pre-wrap";
        let mut candidates = Vec::new();
        if cx.doc.matches(el, selector)? {
            candidates.push(el);
        }
        candidates.extend(cx.doc.query_selector_all(el, selector)?);
        Ok(candidates
            .iter()
            .copied()
            .filter(|&c| !candidates.iter().any(|&o| o != c && cx.doc.contains(o, c)))
            .collect())
    }

    fn get_title(&self, cx: &mut Cx) -> Result<String, ExtractError> {
        let page = page_title(cx);
        if !page.is_empty() && page != "ChatGPT" {
            return Ok(page);
        }
        if let Some(&first) = self.turns.first()
            && let Some(message) = cx.doc.query_selector(first, ".text-message")?
        {
            return Ok(truncated_title(&text_of(cx.doc, message)));
        }
        Ok("ChatGPT Conversation".to_string())
    }

    /// The `replace` callback of `citationPattern`: records the footnote and returns the
    /// reference that replaces the citation spans.
    fn citation_reference(&mut self, url: &str) -> String {
        let mut domain = String::new();
        let mut fragment_text = String::new();
        let outcome = (|| -> Result<(), ()> {
            let parsed = Url::parse(url).map_err(|_| ())?;
            let host = parsed.host_str().unwrap_or_default();
            domain = host.strip_prefix("www.").unwrap_or(host).to_string();
            let parts: Vec<&str> = url.split("#:~:text=").collect();
            if parts.len() > 1 {
                let decoded = decode_uri_component(parts[1]).ok_or(())?;
                let decoded = decoded.replace("%2C", ",");
                let pieces: Vec<&str> = decoded.split(',').collect();
                fragment_text = if pieces.len() > 1 && !trim(pieces[0]).is_empty() {
                    format!(" — {}...", trim(pieces[0]))
                } else if !trim(pieces[0]).is_empty() {
                    format!(" — {}", trim(&decoded))
                } else {
                    String::new()
                };
            }
            Ok(())
        })();
        if outcome.is_err() {
            tracing::error!(url, "Failed to parse URL");
            domain = url.to_string();
        }
        let number = match self.footnotes.iter().position(|f| f.url == url) {
            Some(i) => i + 1,
            None => {
                self.footnotes.push(Footnote {
                    url: url.to_string(),
                    text: format!("<a href=\"{url}\">{domain}</a>{fragment_text}"),
                });
                self.footnotes.len()
            }
        };
        format!("<sup id=\"fnref:{number}\"><a href=\"#fn:{number}\">{number}</a></sup>")
    }
}

/// `starts_with_ci(text, at, needle)` for an ASCII needle, as the `i` flag of a non-Unicode
/// JS regex folds only ASCII.
fn starts_with_ci(text: &str, at: usize, needle: &str) -> bool {
    text.get(at..at + needle.len())
        .is_some_and(|s| s.eq_ignore_ascii_case(needle))
}

fn skip_ws(text: &str, mut at: usize) -> usize {
    while let Some(c) = text[at..].chars().next() {
        if !is_js_whitespace(c) {
            break;
        }
        at += c.len_utf8();
    }
    at
}

/// The end index of `<span[^>]*?>` at `at` (up to the first `>`), if there is one.
fn span_open_end(text: &str, at: usize) -> Option<usize> {
    if !starts_with_ci(text, at, "<span") {
        return None;
    }
    text[at + 5..].find('>').map(|i| at + 5 + i + 1)
}

/// The URL of `<a(?=[^>]*?href="([^"]+)")(?=[^>]*?target="_blank")(?=[^>]*?rel="noopener")[^>]*?>`
/// at `at`, with the index after its `>`.
fn anchor_open(text: &str, at: usize) -> Option<(String, usize)> {
    if !starts_with_ci(text, at, "<a") {
        return None;
    }
    let close = text[at + 2..].find('>')? + at + 2;
    let tag = &text[at + 2..close];
    let has = |needle: &str| (0..=tag.len()).any(|i| starts_with_ci(tag, i, needle));
    if !has("target=\"_blank\"") || !has("rel=\"noopener\"") {
        return None;
    }
    // The first `href="` with at least one non-quote character and a closing quote.
    let href = (0..tag.len())
        .filter(|&i| starts_with_ci(tag, i, "href=\""))
        .find_map(|i| {
            let start = at + 2 + i + 6;
            let end = start + text[start..].find('"')?;
            (end > start).then(|| text[start..end].to_string())
        })?;
    Some((href, close + 1))
}

/// Matches `citationPattern` (flags `gi`) at the first possible start at or after `from`:
/// an optional `&ZeroWidthSpace;`, nested citation `<span>`s around an anchor, and the closing
/// `</a>` followed by one or more `</span>`. Returns the match range and the anchor URL.
fn find_citation(text: &str, lower: &str, from: usize) -> Option<(usize, usize, String)> {
    const ZWS: &str = "&ZeroWidthSpace;";
    let mut start = from;
    while let Some(i) = lower[start..].find("<span") {
        let span_at = start + i;
        let match_start =
            if span_at >= from + ZWS.len() && starts_with_ci(text, span_at - ZWS.len(), ZWS) {
                span_at - ZWS.len()
            } else {
                span_at
            };
        // `<span ...>\s*` then any number of further `<span ...>\s*`.
        let mut pos = span_open_end(text, span_at)?;
        pos = skip_ws(text, pos);
        while let Some(end) = span_open_end(text, pos) {
            pos = skip_ws(text, end);
        }
        if let Some((url, after_open)) = anchor_open(text, pos) {
            // The lazy `[\s\S]*?</a>` retries later `</a>` until the tail matches.
            let mut search = after_open;
            while let Some(j) = lower[search..].find("</a>") {
                let mut end = skip_ws(text, search + j + 4);
                if starts_with_ci(text, end, "</span>") {
                    while starts_with_ci(text, end, "</span>") {
                        end = skip_ws(text, end + 7);
                    }
                    return Some((match_start, end, url));
                }
                search += j + 4;
            }
        }
        start = span_at + 1;
    }
    None
}

impl Conversation for ChatGptExtractor {
    fn extract_messages(&mut self, cx: &mut Cx) -> Result<Vec<Message>, ExtractError> {
        if let Some(cached) = &self.cached {
            return Ok(cached.clone());
        }
        let mut messages = Vec::new();
        self.footnotes.clear();
        let turns = self.turns.clone();
        for turn in turns {
            let author = cx
                .doc
                .query_selector(turn, SR_HEADINGS)?
                .map(|el| trimmed(cx.doc, el))
                .unwrap_or_default();
            let author = author
                .strip_suffix(':')
                .map(str::to_string)
                .unwrap_or(author);
            let mut message_els = Vec::new();
            for el in cx
                .doc
                .query_selector_all(turn, "[data-message-author-role]")?
            {
                if cx.doc.closest(el, TURN)? == Some(turn) {
                    message_els.push(el);
                }
            }
            let role = message_els
                .first()
                .map(|&el| attr_of(cx.doc, el, "data-message-author-role"))
                .unwrap_or_default();
            let mut parts = Vec::new();
            for &el in &message_els {
                let content_elements = Self::content_elements(cx, el)?;
                if content_elements.is_empty() {
                    parts.push(cx.doc.inner_html(el));
                } else {
                    parts.extend(content_elements.iter().map(|&c| cx.doc.inner_html(c)));
                }
            }
            if parts.is_empty() {
                parts.push(cx.doc.inner_html(turn));
            }
            let mut content = parts.join("\n").replace('\u{200B}', "");
            let temp = cx.doc.create_element("div");
            let fragment = cx.doc.parse_fragment(&content);
            cx.doc.append_child(temp, fragment)?;
            for el in cx.doc.query_selector_all(temp, SR_HEADINGS)? {
                cx.doc.remove(el);
            }
            content = cx.doc.inner_html(temp);

            let mut replaced = String::new();
            let mut last = 0;
            let lower = content.to_ascii_lowercase();
            while let Some((start, end, url)) = find_citation(&content, &lower, last) {
                replaced.push_str(&content[last..start]);
                replaced.push_str(&self.citation_reference(&url));
                last = end;
            }
            replaced.push_str(&content[last..]);

            let cleanup = cx.doc.create_element("div");
            let fragment = cx.doc.parse_fragment(&replaced);
            cx.doc.append_child(cleanup, fragment)?;
            for el in cx
                .doc
                .query_selector_all(cleanup, r#"span[data-state="closed"]"#)?
            {
                cx.doc.remove(el);
            }
            let content = strip_empty_paragraphs(&cx.doc.inner_html(cleanup));
            messages.push(Message {
                author,
                content: trim(&content).to_string(),
                metadata: vec![(
                    "role",
                    if role.is_empty() {
                        "unknown".to_string()
                    } else {
                        role
                    },
                )],
            });
        }
        self.cached = Some(messages.clone());
        Ok(messages)
    }

    fn get_footnotes(&self) -> &[Footnote] {
        &self.footnotes
    }

    fn get_metadata(&mut self, cx: &mut Cx) -> Result<ConversationMeta, ExtractError> {
        let title = self.get_title(cx)?;
        let count = self.extract_messages(cx)?.len();
        Ok(ConversationMeta {
            title,
            site: "ChatGPT",
            description: format!("ChatGPT conversation with {count} messages"),
        })
    }
}

/// `.replace(/<p[^>]*>\s*<\/p>/g, '')`.
fn strip_empty_paragraphs(html: &str) -> String {
    use crate::web::extract::utils::js::WS;
    use regex::Regex;
    use std::sync::LazyLock;
    static EMPTY_P: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(&format!("<p[^>]*>{WS}*</p>")).expect("static pattern"));
    EMPTY_P.replace_all(html, "").into_owned()
}

impl Extractor for ChatGptExtractor {
    fn can_extract(&mut self, _cx: &mut Cx) -> Result<bool, ExtractError> {
        Ok(!self.turns.is_empty())
    }

    fn extract(&mut self, cx: &mut Cx) -> Result<Extracted, ExtractError> {
        extract_conversation(self, cx)
    }
}
