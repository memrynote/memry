//! Turndown's view of a node: `nodeName`, the block, void and blank predicates and the flanking
//! whitespace that `new Node(node, options)` attaches (`lib/turndown.cjs.js:17-300`).

use super::parse::Dom;
use crate::web::extract::dom::NodeId;
use crate::web::extract::dom::node::{NodeKind, node_type};
use crate::web::extract::utils::js::is_js_whitespace;

const BLOCK_ELEMENTS: &[&str] = &[
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "AUDIO",
    "BLOCKQUOTE",
    "BODY",
    "CANVAS",
    "CENTER",
    "DD",
    "DIR",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "FRAMESET",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HGROUP",
    "HR",
    "HTML",
    "ISINDEX",
    "LI",
    "MAIN",
    "MENU",
    "NAV",
    "NOFRAMES",
    "NOSCRIPT",
    "OL",
    "OUTPUT",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
];

const VOID_ELEMENTS: &[&str] = &[
    "AREA", "BASE", "BR", "COL", "COMMAND", "EMBED", "HR", "IMG", "INPUT", "KEYGEN", "LINK",
    "META", "PARAM", "SOURCE", "TRACK", "WBR",
];

const MEANINGFUL_WHEN_BLANK: &[&str] = &[
    "A", "TABLE", "THEAD", "TBODY", "TFOOT", "TH", "TD", "IFRAME", "SCRIPT", "AUDIO", "VIDEO",
];

/// The flags `Node()` computes for a child before its rule runs.
pub struct NodeInfo {
    pub is_block: bool,
    pub is_blank: bool,
    pub leading: String,
    pub trailing: String,
}

impl Dom {
    /// `node.nodeName`: upper case for HTML elements, as parsed for SVG and MathML ones.
    pub fn node_name(&self, id: NodeId) -> String {
        match &self.doc.node(id).kind {
            NodeKind::Element(e) if e.svg => e.name.clone(),
            NodeKind::Element(e) => e.name.to_ascii_uppercase(),
            NodeKind::Text(_) => "#text".into(),
            NodeKind::CData(_) => "#cdata-section".into(),
            NodeKind::Comment(_) => "#comment".into(),
            NodeKind::Document => "#document".into(),
            NodeKind::Fragment => "#document-fragment".into(),
            NodeKind::Doctype(d) => d.name.clone(),
        }
    }

    /// `node.nodeName.toLowerCase()`, the form string filters compare.
    pub fn lower_name(&self, id: NodeId) -> String {
        self.node_name(id).to_lowercase()
    }

    pub fn is_name(&self, id: NodeId, name: &str) -> bool {
        self.node_name(id) == name
    }

    pub fn is_element(&self, id: NodeId) -> bool {
        self.doc.is_element(id)
    }

    /// `getAttribute(name)`: the stored value, with `class` as written rather than normalised.
    pub fn attr(&self, id: NodeId, name: &str) -> Option<&str> {
        self.doc
            .attributes(id)
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.value.as_str())
    }

    pub fn text(&self, id: NodeId) -> String {
        self.doc.text_content(id).unwrap_or_default()
    }

    /// `parent.children`: the element children.
    pub fn children(&self, id: NodeId) -> Vec<NodeId> {
        self.doc.children(id)
    }

    /// `root.querySelectorAll('a, b')` for type selectors, which zest matches on the local
    /// name: the descendants named one of `names` (lower case), in document order.
    pub fn query_names(&self, root: NodeId, names: &[&str]) -> Vec<NodeId> {
        self.doc
            .descendants(root)
            .into_iter()
            .filter(|&d| {
                self.doc
                    .element(d)
                    .is_some_and(|e| names.contains(&e.name.as_str()))
            })
            .collect()
    }

    /// `root.querySelector('a, b')` for type selectors.
    pub fn query_name(&self, root: NodeId, names: &[&str]) -> Option<NodeId> {
        self.query_names(root, names).into_iter().next()
    }

    /// `root.querySelectorAll('.name')`: zest's `~=` on the raw `class` value, which separates
    /// tokens by U+0020 only.
    pub fn query_class(&self, root: NodeId, name: &str) -> Vec<NodeId> {
        self.doc
            .descendants(root)
            .into_iter()
            .filter(|&d| self.has_class_token(d, name))
            .collect()
    }

    pub fn has_class_token(&self, id: NodeId, name: &str) -> bool {
        let Some(class) = self.attr(id, "class") else {
            return false;
        };
        let mut start = 0;
        while let Some(found) = class[start..].find(name) {
            let at = start + found;
            let before = class[..at].chars().next_back();
            let after = class[at + name.len()..].chars().next();
            if before.is_none_or(|c| c == ' ') && after.is_none_or(|c| c == ' ') {
                return true;
            }
            start = at + class[at..].chars().next().map_or(1, char::len_utf8);
        }
        false
    }

    /// `classList.contains(name)`: tokens are separated by ASCII whitespace.
    pub fn class_contains(&self, id: NodeId, name: &str) -> bool {
        self.attr(id, "class").is_some_and(|class| {
            class
                .split([' ', '\t', '\n', '\u{c}', '\r'])
                .any(|token| token == name)
        })
    }

    /// `node.getElementsByTagName(tag)` for an upper-case `tag`, as Turndown's `has` calls it:
    /// an HTML element looks for HTML descendants by lower-cased name, a foreign element for
    /// local names that equal the argument, which are never upper case.
    fn has_any(&self, id: NodeId, tags: &[&str]) -> bool {
        let Some(context) = self.doc.element(id) else {
            return false;
        };
        if context.svg {
            return false;
        }
        self.doc.descendants(id).into_iter().any(|d| {
            self.doc
                .element(d)
                .is_some_and(|e| !e.svg && tags.iter().any(|t| e.name == t.to_ascii_lowercase()))
        })
    }

    pub fn is_block(&self, id: NodeId) -> bool {
        BLOCK_ELEMENTS.contains(&self.node_name(id).as_str())
    }

    fn is_void(&self, id: NodeId) -> bool {
        VOID_ELEMENTS.contains(&self.node_name(id).as_str())
    }

    pub fn is_void_node(&self, id: NodeId) -> bool {
        self.is_void(id)
    }

    fn is_blank(&self, id: NodeId) -> bool {
        !self.is_void(id)
            && !MEANINGFUL_WHEN_BLANK.contains(&self.node_name(id).as_str())
            && self.text(id).chars().all(is_js_whitespace)
            && !self.has_any(id, VOID_ELEMENTS)
            && !self.has_any(id, MEANINGFUL_WHEN_BLANK)
    }

    /// `node.isCode`: the node or an ancestor below the root is a `CODE` element.
    pub fn is_code(&self, id: NodeId, root: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(c) = current {
            if c == root {
                return false;
            }
            if self.is_name(c, "CODE") {
                return true;
            }
            current = self.doc.parent_node(c);
        }
        false
    }

    /// `new Node(node, options)` for an element child of the root `root`.
    pub fn node_info(&self, id: NodeId, root: NodeId) -> NodeInfo {
        let is_block = self.is_block(id);
        let is_blank = self.is_blank(id);
        let (leading, trailing) = if is_block || self.is_code(id, root) {
            (String::new(), String::new())
        } else {
            self.flanking_whitespace(id)
        };
        NodeInfo {
            is_block,
            is_blank,
            leading,
            trailing,
        }
    }

    fn flanking_whitespace(&self, id: NodeId) -> (String, String) {
        let text = self.text(id);
        let edges = edge_whitespace(&text);
        let mut leading = edges.leading.to_string();
        let mut trailing = edges.trailing.to_string();
        // abandon leading ASCII WS if left-flanked by ASCII WS
        if !edges.leading_ascii.is_empty() && self.is_flanked_by_whitespace(true, id) {
            leading = edges.leading_non_ascii.to_string();
        }
        // abandon trailing ASCII WS if right-flanked by ASCII WS
        if !edges.trailing_ascii.is_empty() && self.is_flanked_by_whitespace(false, id) {
            trailing = edges.trailing_non_ascii.to_string();
        }
        (leading, trailing)
    }

    fn is_flanked_by_whitespace(&self, left: bool, id: NodeId) -> bool {
        let sibling = if left {
            self.doc.previous_sibling(id)
        } else {
            self.doc.next_sibling(id)
        };
        let Some(sibling) = sibling else {
            return false;
        };
        let test = |s: &str| {
            if left {
                s.ends_with(' ')
            } else {
                s.starts_with(' ')
            }
        };
        match self.doc.node_type(sibling) {
            node_type::TEXT => test(self.doc.node_value(sibling).unwrap_or_default()),
            node_type::ELEMENT if self.is_name(sibling, "CODE") => false,
            node_type::ELEMENT if !self.is_block(sibling) => test(&self.text(sibling)),
            _ => false,
        }
    }
}

struct Edges<'a> {
    leading: &'a str,
    leading_ascii: &'a str,
    leading_non_ascii: &'a str,
    trailing: &'a str,
    trailing_non_ascii: &'a str,
    trailing_ascii: &'a str,
}

fn is_ascii_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\r' | '\n')
}

/// `edgeWhitespace(string)`: the match of
/// `^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$`.
fn edge_whitespace(s: &str) -> Edges<'_> {
    let body_start = s.find(|c| !is_js_whitespace(c));
    let Some(start) = body_start else {
        // Whitespace only: the first group takes it all.
        let ascii_end = s.find(|c| !is_ascii_ws(c)).unwrap_or(s.len());
        return Edges {
            leading: s,
            leading_ascii: &s[..ascii_end],
            leading_non_ascii: &s[ascii_end..],
            trailing: "",
            trailing_non_ascii: "",
            trailing_ascii: "",
        };
    };
    let leading = &s[..start];
    let ascii_end = leading.find(|c| !is_ascii_ws(c)).unwrap_or(leading.len());
    let body_end = s
        .rfind(|c| !is_js_whitespace(c))
        .map(|i| i + s[i..].chars().next().map_or(1, char::len_utf8))
        .unwrap_or(start);
    let trailing = &s[body_end..];
    let ascii_start = trailing
        .rfind(|c| !is_ascii_ws(c))
        .map(|i| i + trailing[i..].chars().next().map_or(1, char::len_utf8))
        .unwrap_or(0);
    Edges {
        leading,
        leading_ascii: &leading[..ascii_end],
        leading_non_ascii: &leading[ascii_end..],
        trailing,
        trailing_non_ascii: &trailing[..ascii_start],
        trailing_ascii: &trailing[ascii_start..],
    }
}

#[cfg(test)]
mod tests {
    use super::edge_whitespace;

    // Expected values come from running `edgeWhitespace` of turndown 7.2.4 in Node.
    #[test]
    fn edges_split_ascii_and_other_whitespace() {
        let e = edge_whitespace(" \u{a0} a b \u{a0}\n");
        assert_eq!(
            (e.leading, e.leading_ascii, e.leading_non_ascii),
            (" \u{a0} ", " ", "\u{a0} ")
        );
        assert_eq!(
            (e.trailing, e.trailing_non_ascii, e.trailing_ascii),
            (" \u{a0}\n", " \u{a0}", "\n")
        );
    }

    #[test]
    fn whitespace_only_is_all_leading() {
        let e = edge_whitespace("  \u{a0}\t");
        assert_eq!(e.leading, "  \u{a0}\t");
        assert_eq!((e.leading_ascii, e.leading_non_ascii), ("  ", "\u{a0}\t"));
        assert_eq!(e.trailing, "");
    }
}
