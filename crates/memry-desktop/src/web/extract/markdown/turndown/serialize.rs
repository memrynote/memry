//! Domino's HTML fragment serializer (`NodeUtils.serializeOne`): what `innerHTML` and
//! `outerHTML` return for a node of Turndown's document.
//!
//! It differs from linkedom's: attribute values escape `& " < > U+00A0`, text escapes
//! `& < > U+00A0` as `&nbsp;`, void elements print no end tag and foreign elements always get one,
//! and text directly inside `script`, `style`, `xmp`, `iframe`, `noembed`, `noframes`,
//! `plaintext` and `noscript` is written raw.

use super::parse::Dom;
use crate::web::extract::dom::NodeId;
use crate::web::extract::dom::node::NodeKind;

/// `emptyElements` of domino: HTML elements that print as a start tag only.
const EMPTY_ELEMENTS: &[&str] = &[
    "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input",
    "keygen", "link", "meta", "param", "source", "track", "wbr",
];

/// `hasRawContent` of domino, plus `NOSCRIPT`, which is raw because the document is scripting
/// enabled for serialization.
const RAW_PARENTS: &[&str] = &[
    "style",
    "script",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "plaintext",
    "noscript",
];

fn escape_text(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            _ => out.push(c),
        }
    }
}

fn escape_attribute(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&nbsp;"),
            _ => out.push(c),
        }
    }
}

/// `escapeMatchingClosingTag`: a `</tag` inside raw content becomes `&lt;/tag`.
fn escape_closing_tag(raw: &str, tag: &str) -> String {
    let closing = format!("</{tag}");
    let lower = raw.to_ascii_lowercase();
    if !lower.contains(&closing) {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut start = 0;
    while let Some(found) = lower[start..].find(&closing) {
        let at = start + found;
        out.push_str(&raw[start..at]);
        out.push_str("&lt;");
        start = at + 1;
    }
    out.push_str(&raw[start..]);
    out
}

/// `escapeClosingCommentTag`: `-->` and `--!>` lose their `>`.
fn escape_comment(data: &str) -> String {
    let mut out = String::with_capacity(data.len());
    let bytes = data.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if data[i..].starts_with("--!>") {
            out.push_str("--!&gt;");
            i += 4;
        } else if data[i..].starts_with("-->") {
            out.push_str("--&gt;");
            i += 3;
        } else {
            let c = data[i..].chars().next().expect("index is a char boundary");
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

impl Dom {
    /// `node.outerHTML`.
    pub fn outer_html(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.write_node(id, None, &mut out);
        out
    }

    /// `node.innerHTML`, for an element or a fragment.
    pub fn inner_html(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.write_children(id, &mut out);
        out
    }

    /// The children a serializer visits: a template's content fragment replaces its own.
    fn write_children(&self, id: NodeId, out: &mut String) {
        let source = self.templates.get(&id).copied().unwrap_or(id);
        let parent = self.html_tag(id);
        let mut child = self.doc.first_child(source);
        while let Some(c) = child {
            self.write_node(c, parent.as_deref(), out);
            child = self.doc.next_sibling(c);
        }
    }

    /// The lowercase local name of an HTML element, `None` for foreign elements and other nodes.
    fn html_tag(&self, id: NodeId) -> Option<String> {
        self.doc
            .element(id)
            .filter(|e| !e.svg)
            .map(|e| e.name.to_ascii_lowercase())
    }

    fn write_node(&self, id: NodeId, parent_tag: Option<&str>, out: &mut String) {
        match &self.doc.node(id).kind {
            NodeKind::Element(element) => {
                out.push('<');
                out.push_str(&element.name);
                for attr in &element.attrs {
                    out.push(' ');
                    out.push_str(&attr.name);
                    out.push_str("=\"");
                    escape_attribute(&attr.value, out);
                    out.push('"');
                }
                out.push('>');
                let html = !element.svg;
                if html && EMPTY_ELEMENTS.contains(&element.name.as_str()) {
                    return;
                }
                let mut inner = String::new();
                self.write_children(id, &mut inner);
                if matches!(
                    element.name.to_ascii_lowercase().as_str(),
                    "style" | "script" | "xmp" | "iframe" | "noembed" | "noframes" | "plaintext"
                ) {
                    inner = escape_closing_tag(&inner, &element.name);
                }
                out.push_str(&inner);
                out.push_str("</");
                out.push_str(&element.name);
                out.push('>');
            }
            NodeKind::Text(data) | NodeKind::CData(data) => {
                if parent_tag.is_some_and(|t| RAW_PARENTS.contains(&t)) {
                    out.push_str(data);
                } else {
                    escape_text(data, out);
                }
            }
            NodeKind::Comment(data) => {
                out.push_str("<!--");
                out.push_str(&escape_comment(data));
                out.push_str("-->");
            }
            NodeKind::Doctype(d) => {
                out.push_str("<!DOCTYPE ");
                out.push_str(&d.name);
                out.push('>');
            }
            NodeKind::Document | NodeKind::Fragment => self.write_children(id, out),
        }
    }
}
