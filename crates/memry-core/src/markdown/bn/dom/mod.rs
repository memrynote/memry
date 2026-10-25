//! An arena DOM and the HTML fragment parser that fills it.
//!
//! BlockNote's HTML path runs on jsdom: `div.innerHTML = html` (parse5's
//! fragment algorithm with a `div` context), then tree edits
//! (`nestedListsToBlockNoteStructure`), then ProseMirror's `DOMParser` reading
//! the result. This module is the slice of the DOM those steps use: nodes in a
//! `Vec` addressed by index, html5ever as the tree builder (also a WHATWG
//! parser, so the same tree for the same input), the selector subset the parse
//! rules need and a CSS declaration reader for `element.style`.

mod build;
mod select;
mod style;

use std::fmt::Write as _;

pub use build::parse_fragment_in_div;
pub use select::Selector;
pub use style::Style;

pub type NodeId = usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ns {
    Html,
    Svg,
    MathMl,
}

#[derive(Debug, Clone)]
pub struct Element {
    /// The local name as parsed: lower case for HTML elements.
    pub name: String,
    pub ns: Ns,
    pub attrs: Vec<(String, String)>,
    /// A `<template>`'s content is a separate fragment, not a child list.
    pub template_content: Option<NodeId>,
}

#[derive(Debug, Clone)]
pub enum NodeData {
    Document,
    Element(Element),
    Text(String),
    Comment(String),
}

#[derive(Debug, Clone)]
struct Node {
    data: NodeData,
    parent: Option<NodeId>,
    children: Vec<NodeId>,
}

#[derive(Debug, Default, Clone)]
pub struct Dom {
    nodes: Vec<Node>,
}

impl Dom {
    pub fn new() -> Dom {
        Dom::default()
    }

    fn alloc(&mut self, data: NodeData) -> NodeId {
        self.nodes.push(Node {
            data,
            parent: None,
            children: Vec::new(),
        });
        self.nodes.len() - 1
    }

    pub fn create_document(&mut self) -> NodeId {
        self.alloc(NodeData::Document)
    }

    pub fn create_element(&mut self, name: &str) -> NodeId {
        self.alloc(NodeData::Element(Element {
            name: name.to_ascii_lowercase(),
            ns: Ns::Html,
            attrs: Vec::new(),
            template_content: None,
        }))
    }

    pub fn create_text(&mut self, text: &str) -> NodeId {
        self.alloc(NodeData::Text(text.to_owned()))
    }

    pub fn data(&self, id: NodeId) -> &NodeData {
        &self.nodes[id].data
    }

    pub fn element(&self, id: NodeId) -> Option<&Element> {
        match &self.nodes[id].data {
            NodeData::Element(el) => Some(el),
            _ => None,
        }
    }

    pub fn is_element(&self, id: NodeId) -> bool {
        self.element(id).is_some()
    }

    /// `Node.nodeName`: upper case for an HTML element, the local name otherwise.
    pub fn node_name(&self, id: NodeId) -> String {
        match &self.nodes[id].data {
            NodeData::Element(el) if el.ns == Ns::Html => el.name.to_ascii_uppercase(),
            NodeData::Element(el) => el.name.clone(),
            NodeData::Text(_) => "#text".into(),
            NodeData::Comment(_) => "#comment".into(),
            NodeData::Document => "#document".into(),
        }
    }

    /// `nodeName.toLowerCase()`.
    pub fn node_name_lower(&self, id: NodeId) -> String {
        self.node_name(id).to_lowercase()
    }

    /// True for an HTML element called `name` (lower case).
    pub fn is_html(&self, id: NodeId, name: &str) -> bool {
        self.element(id)
            .is_some_and(|el| el.ns == Ns::Html && el.name == name)
    }

    pub fn parent(&self, id: NodeId) -> Option<NodeId> {
        self.nodes[id].parent
    }

    pub fn parent_element(&self, id: NodeId) -> Option<NodeId> {
        self.parent(id).filter(|p| self.is_element(*p))
    }

    pub fn children(&self, id: NodeId) -> &[NodeId] {
        &self.nodes[id].children
    }

    pub fn first_child(&self, id: NodeId) -> Option<NodeId> {
        self.nodes[id].children.first().copied()
    }

    fn sibling_at(&self, id: NodeId, delta: isize) -> Option<NodeId> {
        let parent = self.parent(id)?;
        let siblings = &self.nodes[parent].children;
        let at = siblings.iter().position(|c| *c == id)? as isize + delta;
        usize::try_from(at)
            .ok()
            .and_then(|i| siblings.get(i).copied())
    }

    pub fn next_sibling(&self, id: NodeId) -> Option<NodeId> {
        self.sibling_at(id, 1)
    }

    pub fn previous_sibling(&self, id: NodeId) -> Option<NodeId> {
        self.sibling_at(id, -1)
    }

    pub fn previous_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let mut at = self.previous_sibling(id);
        while let Some(n) = at {
            if self.is_element(n) {
                return Some(n);
            }
            at = self.previous_sibling(n);
        }
        None
    }

    pub fn next_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let mut at = self.next_sibling(id);
        while let Some(n) = at {
            if self.is_element(n) {
                return Some(n);
            }
            at = self.next_sibling(n);
        }
        None
    }

    pub fn first_element_child(&self, id: NodeId) -> Option<NodeId> {
        self.children(id)
            .iter()
            .copied()
            .find(|c| self.is_element(*c))
    }

    pub fn child_element_count(&self, id: NodeId) -> usize {
        self.children(id)
            .iter()
            .filter(|c| self.is_element(**c))
            .count()
    }

    pub fn detach(&mut self, id: NodeId) {
        if let Some(parent) = self.nodes[id].parent.take() {
            self.nodes[parent].children.retain(|c| *c != id);
        }
    }

    pub fn append_child(&mut self, parent: NodeId, child: NodeId) {
        self.detach(child);
        self.nodes[child].parent = Some(parent);
        self.nodes[parent].children.push(child);
    }

    /// `insertAdjacentElement("afterend")`: `node` becomes the next sibling of `anchor`.
    pub fn insert_after(&mut self, anchor: NodeId, node: NodeId) {
        let parent = self.nodes[anchor].parent.expect("anchor has a parent");
        self.detach(node);
        let at = self.nodes[parent]
            .children
            .iter()
            .position(|c| *c == anchor)
            .expect("anchor is a child of its parent");
        self.nodes[parent].children.insert(at + 1, node);
        self.nodes[node].parent = Some(parent);
    }

    pub fn attr(&self, id: NodeId, name: &str) -> Option<&str> {
        self.element(id)?
            .attrs
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn has_attr(&self, id: NodeId, name: &str) -> bool {
        self.attr(id, name).is_some()
    }

    pub fn set_attr(&mut self, id: NodeId, name: &str, value: &str) {
        if let NodeData::Element(el) = &mut self.nodes[id].data {
            match el.attrs.iter_mut().find(|(n, _)| n == name) {
                Some((_, v)) => *v = value.to_owned(),
                None => el.attrs.push((name.to_owned(), value.to_owned())),
            }
        }
    }

    pub fn text_value(&self, id: NodeId) -> Option<&str> {
        match &self.nodes[id].data {
            NodeData::Text(t) => Some(t),
            _ => None,
        }
    }

    pub fn set_text_value(&mut self, id: NodeId, value: String) {
        if let NodeData::Text(t) = &mut self.nodes[id].data {
            *t = value;
        }
    }

    pub fn comment_value(&self, id: NodeId) -> Option<&str> {
        match &self.nodes[id].data {
            NodeData::Comment(t) => Some(t),
            _ => None,
        }
    }

    /// `Node.textContent`: the text of every descendant text node.
    pub fn text_content(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.collect_text(id, &mut out);
        out
    }

    fn collect_text(&self, id: NodeId, out: &mut String) {
        match &self.nodes[id].data {
            NodeData::Text(t) => out.push_str(t),
            NodeData::Comment(_) => {}
            _ => {
                for child in &self.nodes[id].children {
                    self.collect_text(*child, out);
                }
            }
        }
    }

    /// Every node under `root` in document order, `root` excluded.
    pub fn descendants(&self, root: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut stack: Vec<NodeId> = self.nodes[root].children.iter().rev().copied().collect();
        while let Some(id) = stack.pop() {
            out.push(id);
            stack.extend(self.nodes[id].children.iter().rev().copied());
        }
        out
    }

    /// `Node.contains`.
    pub fn contains(&self, root: NodeId, node: NodeId) -> bool {
        let mut at = Some(node);
        while let Some(n) = at {
            if n == root {
                return true;
            }
            at = self.parent(n);
        }
        false
    }

    /// `Node.cloneNode(true)`: a deep copy, detached.
    pub fn clone_deep(&mut self, id: NodeId) -> NodeId {
        let data = self.nodes[id].data.clone();
        let copy = self.alloc(data);
        for child in self.nodes[id].children.clone() {
            let child_copy = self.clone_deep(child);
            self.append_child(copy, child_copy);
        }
        copy
    }

    /// `Element.matches`.
    pub fn matches(&self, id: NodeId, selector: &Selector) -> bool {
        selector.matches(self, id, None)
    }

    /// `Element.querySelector`: the first descendant of `root` that matches.
    pub fn query_selector(&self, root: NodeId, selector: &Selector) -> Option<NodeId> {
        self.descendants(root)
            .into_iter()
            .find(|d| self.is_element(*d) && selector.matches(self, *d, Some(root)))
    }

    /// `Element.querySelectorAll`, in document order.
    pub fn query_selector_all(&self, root: NodeId, selector: &Selector) -> Vec<NodeId> {
        self.descendants(root)
            .into_iter()
            .filter(|d| self.is_element(*d) && selector.matches(self, *d, Some(root)))
            .collect()
    }

    /// `Element.closest`: the element itself or its nearest matching ancestor.
    pub fn closest(&self, id: NodeId, selector: &Selector) -> Option<NodeId> {
        let mut at = Some(id);
        while let Some(n) = at {
            if self.is_element(n) && selector.matches(self, n, None) {
                return Some(n);
            }
            at = self.parent(n);
        }
        None
    }

    /// `element.style`.
    pub fn style(&self, id: NodeId) -> Style {
        Style::parse(self.attr(id, "style").unwrap_or(""))
    }

    /// The tree as HTML, for debugging and tests.
    pub fn outer_html(&self, id: NodeId) -> String {
        let mut out = String::new();
        self.write_html(id, &mut out);
        out
    }

    pub fn inner_html(&self, id: NodeId) -> String {
        let mut out = String::new();
        for child in &self.nodes[id].children {
            self.write_html(*child, &mut out);
        }
        out
    }

    fn write_html(&self, id: NodeId, out: &mut String) {
        match &self.nodes[id].data {
            NodeData::Text(t) => out.push_str(&escape_text(t)),
            NodeData::Comment(c) => {
                let _ = write!(out, "<!--{c}-->");
            }
            NodeData::Document => {
                for child in &self.nodes[id].children {
                    self.write_html(*child, out);
                }
            }
            NodeData::Element(el) => {
                let _ = write!(out, "<{}", el.name);
                for (name, value) in &el.attrs {
                    let _ = write!(out, " {name}=\"{}\"", escape_attr(value));
                }
                out.push('>');
                if el.ns == Ns::Html && VOID.contains(&el.name.as_str()) {
                    return;
                }
                for child in &self.nodes[id].children {
                    self.write_html(*child, out);
                }
                let _ = write!(out, "</{}>", el.name);
            }
        }
    }
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr",
];

fn escape_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('\u{a0}', "&nbsp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('\u{a0}', "&nbsp;")
        .replace('"', "&quot;")
}
