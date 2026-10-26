//! `toString`, `outerHTML` and `innerHTML` as linkedom 0.18.12 produces them.
//!
//! Text is escaped for `& < > U+00A0` only, attribute values only for `"`, and script, style,
//! textarea and title content is written raw. Those are linkedom's rules, not the HTML
//! fragment serialization algorithm.

use super::node::{Attribute, ElementData, NodeId, NodeKind};
use super::tree::Document;

/// `emptyAttributes` in `shared/attributes.js`: these print as a bare name when their value is
/// empty.
const EMPTY_ATTRIBUTES: &[&str] = &[
    "allowfullscreen",
    "allowpaymentrequest",
    "async",
    "autofocus",
    "autoplay",
    "checked",
    "class",
    "contenteditable",
    "controls",
    "default",
    "defer",
    "disabled",
    "draggable",
    "formnovalidate",
    "hidden",
    "id",
    "ismap",
    "itemscope",
    "loop",
    "multiple",
    "muted",
    "nomodule",
    "novalidate",
    "open",
    "playsinline",
    "readonly",
    "required",
    "reversed",
    "selected",
    "style",
    "truespeed",
];

/// `Mime['text/html'].voidElements`, tested case-insensitively.
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "menuitem",
    "meta", "param", "source", "track", "wbr",
];

/// The HTML elements linkedom builds from `TextElement`: their `toString` writes `textContent`
/// between the tags.
pub(super) fn is_text_element(element: &ElementData) -> bool {
    !element.svg
        && matches!(
            element.name.as_str(),
            "script" | "style" | "textarea" | "title"
        )
}

fn is_void(name: &str) -> bool {
    VOID_ELEMENTS.iter().any(|v| v.eq_ignore_ascii_case(name))
}

/// `escape` of `shared/text-escaper.js`.
pub fn escape_text(text: &str, out: &mut String) {
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\u{a0}' => out.push_str("&#160;"),
            _ => out.push(c),
        }
    }
}

/// `Attr.toString()` and the `id`, `class`, `style` filter of `Element.toString`.
fn write_attribute(attr: &Attribute, out: &mut String) {
    let bare = attr.value.is_empty() && EMPTY_ATTRIBUTES.contains(&attr.name.as_str());
    if bare {
        if !matches!(attr.name.as_str(), "id" | "class" | "style") {
            out.push(' ');
            out.push_str(&attr.name);
        }
        return;
    }
    out.push(' ');
    out.push_str(&attr.name);
    out.push_str("=\"");
    out.push_str(&attr.value.replace('"', "&quot;"));
    out.push('"');
}

impl Document {
    /// `node.toString()`.
    pub fn serialize(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.write_node(id, &mut out);
        out
    }

    /// `element.outerHTML`.
    pub fn outer_html(&self, id: NodeId) -> String {
        self.serialize(id)
    }

    /// `element.innerHTML`: the child nodes joined. For script, style, textarea and title it is
    /// the raw text content.
    pub fn inner_html(&self, id: NodeId) -> String {
        if let Some(element) = self.element(id)
            && is_text_element(element)
        {
            return self.text_content(id).unwrap_or_default();
        }
        let mut out = String::new();
        for child in self.child_nodes(id) {
            self.write_node(child, &mut out);
        }
        out
    }

    fn write_node(&self, id: NodeId, out: &mut String) {
        match &self.node(id).kind {
            NodeKind::Element(element) => self.write_element(id, element, out),
            NodeKind::Text(t) => escape_text(t, out),
            NodeKind::Comment(t) => {
                out.push_str("<!--");
                out.push_str(t);
                out.push_str("-->");
            }
            NodeKind::CData(t) => {
                out.push_str("<![CDATA[");
                out.push_str(t);
                out.push_str("]]>");
            }
            NodeKind::Doctype(d) => {
                out.push_str("<!DOCTYPE ");
                out.push_str(&d.name);
                let has_public = !d.public_id.is_empty();
                if has_public {
                    out.push_str(" PUBLIC \"");
                    out.push_str(&d.public_id);
                    out.push('"');
                }
                if !d.system_id.is_empty() {
                    if !has_public {
                        out.push_str(" SYSTEM");
                    }
                    out.push_str(" \"");
                    out.push_str(&d.system_id);
                    out.push('"');
                }
                out.push('>');
            }
            NodeKind::Document => {
                for child in self.child_nodes(id) {
                    self.write_node(child, out);
                }
            }
            NodeKind::Fragment => {
                out.push_str("<#document-fragment>");
                for child in self.child_nodes(id) {
                    self.write_node(child, out);
                }
                out.push_str("</#document-fragment>");
            }
        }
    }

    fn write_element(&self, id: NodeId, element: &ElementData, out: &mut String) {
        let mut open = String::new();
        open.push('<');
        open.push_str(&element.name);
        for attr in &element.attrs {
            write_attribute(attr, &mut open);
        }
        if is_text_element(element) {
            // `toString.call(this.cloneNode()).replace('><', () => '>' + textContent + '<')`.
            let mut shell = open;
            shell.push_str("></");
            shell.push_str(&element.name);
            shell.push('>');
            let text = self.text_content(id).unwrap_or_default();
            out.push_str(&shell.replacen("><", &format!(">{text}<"), 1));
            return;
        }
        // A doctype among the children writes nothing and does not close the start tag.
        let content: Vec<NodeId> = self
            .child_nodes(id)
            .into_iter()
            .filter(|&c| !matches!(self.node(c).kind, NodeKind::Doctype(_)))
            .collect();
        out.push_str(&open);
        if content.is_empty() {
            if element.svg {
                out.push_str(" />");
            } else if is_void(&element.name) {
                out.push('>');
            } else {
                out.push_str("></");
                out.push_str(&element.name);
                out.push('>');
            }
            return;
        }
        out.push('>');
        for child in content {
            self.write_node(child, out);
        }
        out.push_str("</");
        out.push_str(&element.name);
        out.push('>');
    }
}
