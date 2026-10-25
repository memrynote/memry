//! `serializeInlineContent` and the link and escape helpers of `htmlToMarkdown.ts`.

use super::blocks::longest_backtick_run;
use super::tag;
use crate::markdown::bn::dom::{Dom, NodeData, NodeId};
use crate::markdown::frontmatter::js::{is_js_whitespace, js_trim};

pub(super) fn escape_html_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(super) fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_link_destination(url: &str) -> String {
    let mut out = String::with_capacity(url.len());
    for c in url.chars() {
        if matches!(c, '\\' | '(' | ')') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `formatLink`: the bare URL when the label is empty or equals it.
pub(super) fn format_link(text: &str, href: &str) -> String {
    if text.is_empty() || text == href {
        return href.to_owned();
    }
    format!("[{text}]({})", escape_link_destination(href))
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `text.match(/^(.*?)(\s*)$/)`: `.` stops at a line terminator, so a
/// terminator before the trailing whitespace means no match.
fn extract_trailing_whitespace(text: &str) -> (&str, &str) {
    let content = text.trim_end_matches(is_js_whitespace);
    if content.chars().any(is_line_terminator) {
        return (text, "");
    }
    (content, &text[content.len()..])
}

fn emphasis(dom: &Dom, el: NodeId, delimiter: &str, out: &mut String) {
    let inner = serialize_inline_content(dom, el);
    let (content, trailing) = extract_trailing_whitespace(&inner);
    if content.is_empty() {
        out.push_str(trailing);
    } else {
        out.push_str(&format!("{delimiter}{content}{delimiter}{trailing}"));
    }
}

pub(super) fn serialize_inline_content(dom: &Dom, el: NodeId) -> String {
    let mut result = String::new();
    for child in dom.children(el).to_vec() {
        match dom.data(child) {
            NodeData::Text(text) => result.push_str(text),
            NodeData::Element(_) => inline_element(dom, child, &mut result),
            _ => {}
        }
    }
    result
}

fn inline_element(dom: &Dom, el: NodeId, result: &mut String) {
    match tag(dom, el).as_str() {
        "strong" | "b" => emphasis(dom, el, "**", result),
        "em" | "i" => emphasis(dom, el, "*", result),
        "s" | "del" => result.push_str(&format!("~~{}~~", serialize_inline_content(dom, el))),
        "code" => {
            let text = dom.text_content(el);
            let fence = "`".repeat(longest_backtick_run(&text) + 1);
            if text.starts_with('`') || text.ends_with('`') {
                result.push_str(&format!("{fence} {text} {fence}"));
            } else {
                result.push_str(&format!("{fence}{text}{fence}"));
            }
        }
        "a" => {
            let href = dom.attr(el, "href").unwrap_or("");
            let text = serialize_inline_content(dom, el);
            result.push_str(&format_link(&text, href));
        }
        "br" => result.push_str("\\\n"),
        "img" => {
            let src = dom.attr(el, "src").unwrap_or("");
            let alt = dom.attr(el, "alt").unwrap_or("");
            result.push_str(&format!("![{alt}]({src})"));
        }
        "video" => {
            let pick = |a: &str, b: &str| -> String {
                match dom.attr(el, a) {
                    Some(v) if !v.is_empty() => v.to_owned(),
                    _ => dom.attr(el, b).unwrap_or("").to_owned(),
                }
            };
            result.push_str(&format!(
                "![{}]({})",
                pick("data-name", "title"),
                pick("src", "data-url")
            ));
        }
        "input" => {}
        // u, span, p and every other element: the tag goes, the content stays.
        _ => result.push_str(&serialize_inline_content(dom, el)),
    }
}

/// A cell's trimmed inline content.
pub(super) fn cell_text(dom: &Dom, cell: NodeId) -> String {
    js_trim(&serialize_inline_content(dom, cell)).to_owned()
}
