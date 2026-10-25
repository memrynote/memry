//! `parseFromString` of linkedom 0.18.12 for HTML: the tree builder that listens to the
//! htmlparser2 port and the `innerHTML` setter that drives it.

mod entities;
mod events;
mod parser;
mod tables;
mod tokenizer;

use parser::TreeHandler;

use super::node::{Attribute, DoctypeData, NodeId, NodeKind};
use super::serialize::is_text_element;
use super::tree::Document;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{is_js_whitespace, trim};

/// The doctype grammar of linkedom's `document.doctype` setter:
/// `/^([a-z:]+)(\s+system|\s+public(\s+"([^"]+)")?)?(\s+"([^"]+)")?/i`. `None` when the name is
/// missing and the setter does nothing.
fn parse_doctype(value: &str) -> Option<DoctypeData> {
    let name_len = value
        .find(|c: char| !(c.is_ascii_alphabetic() || c == ':'))
        .unwrap_or(value.len());
    if name_len == 0 {
        return None;
    }
    let mut rest = &value[name_len..];
    let mut public_id = String::new();
    let skip_ws = |s: &str| -> usize { s.len() - s.trim_start_matches(is_js_whitespace).len() };

    let ws = skip_ws(rest);
    let after_ws = &rest[ws..];
    let word_len = |word: &str| -> Option<usize> {
        let head = after_ws.get(..word.len())?;
        head.eq_ignore_ascii_case(word).then_some(word.len())
    };
    if ws > 0
        && let Some(len) = word_len("system")
    {
        rest = &after_ws[len..];
    } else if ws > 0
        && let Some(len) = word_len("public")
    {
        rest = &after_ws[len..];
        if let Some((quoted, tail)) = quoted_value(rest, skip_ws) {
            public_id = quoted.to_string();
            rest = tail;
        }
    }
    let system_id = quoted_value(rest, skip_ws).map(|(quoted, _)| quoted.to_string());
    Some(DoctypeData {
        name: value[..name_len].to_string(),
        public_id,
        system_id: system_id.unwrap_or_default(),
    })
}

/// `(\s+"([^"]+)")`: whitespace, then a non-empty quoted string.
fn quoted_value(s: &str, skip_ws: impl Fn(&str) -> usize) -> Option<(&str, &str)> {
    let ws = skip_ws(s);
    let after = &s[ws..];
    if ws == 0 || !after.starts_with('"') {
        return None;
    }
    let close = after[1..].find('"')?;
    if close == 0 {
        return None;
    }
    Some((&after[1..=close], &after[close + 2..]))
}

/// Builds nodes under `container` as `parseFromString` does.
struct Builder<'d> {
    doc: &'d mut Document,
    container: NodeId,
    /// The node being filled; `None` once the stack has closed past the container.
    node: Option<NodeId>,
    /// The outermost `<svg>` while inside one.
    owner_svg: Option<NodeId>,
}

impl Builder<'_> {
    fn append(&mut self, child: NodeId) {
        if let Some(parent) = self.node {
            self.doc.link(parent, child, None);
        }
    }
}

impl TreeHandler for Builder<'_> {
    fn processing_instruction(&mut self, name: &str, data: &str) {
        if name.to_lowercase() != "!doctype" {
            return;
        }
        let name_len = name.chars().count();
        let tail: String = data.chars().skip(name_len).collect();
        if let Some(doctype) = parse_doctype(trim(&tail)) {
            let id = self.doc.create_doctype(doctype);
            // The setter links the doctype ahead of everything already parsed.
            let first = self.doc.first_child(self.container);
            self.doc.link(self.container, id, first);
        }
    }

    fn open_tag(&mut self, name: &str, attributes: Vec<(String, String)>) {
        let element = if self.owner_svg.is_some() {
            self.doc.create_svg_element(name)
        } else if name == "svg" {
            let svg = self.doc.create_svg_element(name);
            self.owner_svg = Some(svg);
            svg
        } else {
            self.doc.create_element(name)
        };
        self.append(element);
        self.node = Some(element);
        if let Some(data) = self.doc.element_mut(element) {
            data.attrs = attributes
                .into_iter()
                .map(|(name, value)| {
                    // `className = value` rewrites the class attribute as its token list.
                    let value = if name == "class" {
                        super::element::class_tokens(&value).join(" ")
                    } else {
                        value
                    };
                    Attribute { name, value }
                })
                .collect();
        }
    }

    fn comment(&mut self, data: &str) {
        let id = self.doc.create_comment(data);
        self.append(id);
    }

    fn text(&mut self, data: &str) {
        let id = self.doc.create_text_node(data);
        self.append(id);
    }

    fn close_tag(&mut self) {
        if self.node.is_some() && self.node == self.owner_svg {
            self.owner_svg = None;
        }
        self.node = self.node.and_then(|n| self.doc.parent_node(n));
    }
}

impl Document {
    /// `parseHTML(html).document`.
    pub fn parse_html(html: &str) -> Document {
        let mut doc = Document::new();
        let root = doc.root();
        doc.parse_into(root, html);
        doc
    }

    fn parse_into(&mut self, container: NodeId, html: &str) {
        let mut builder = Builder {
            doc: self,
            container,
            node: Some(container),
            owner_svg: None,
        };
        parser::parse(html, &mut builder);
    }

    /// `element.innerHTML = html`. The text elements (script, style, textarea, title) keep it as
    /// text.
    pub fn set_inner_html(&mut self, node: NodeId, html: &str) -> Result<(), ExtractError> {
        match self.node(node).kind {
            NodeKind::Element(ref e) if is_text_element(e) => self.set_text_content(node, html),
            NodeKind::Element(_) => {
                let fragment = self.create_document_fragment();
                self.parse_into(fragment, html);
                let children = self.child_nodes(fragment);
                self.replace_children(node, &children)
            }
            _ => Ok(()),
        }
    }
}
