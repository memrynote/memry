//! Element and character-data accessors: attributes, class list, names and text.

use std::borrow::Cow;

use super::node::{Attribute, NodeId, NodeKind};
use super::tree::Document;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::is_js_whitespace;

/// `value.split(/\s+/)` without the empty pieces, first occurrence wins: what `DOMTokenList`
/// keeps of a `class` value.
pub(super) fn class_tokens(value: &str) -> Vec<&str> {
    let mut tokens: Vec<&str> = Vec::new();
    for token in value.split(is_js_whitespace).filter(|t| !t.is_empty()) {
        if !tokens.contains(&token) {
            tokens.push(token);
        }
    }
    tokens
}

impl Document {
    /// `localName`.
    pub fn local_name(&self, id: NodeId) -> Option<&str> {
        self.element(id).map(|e| e.name.as_str())
    }

    /// `tagName` / `nodeName` of an element: the upper-cased local name.
    pub fn tag_name(&self, id: NodeId) -> Option<String> {
        self.element(id).map(|e| e.name.to_uppercase())
    }

    /// `nodeName` for every node kind.
    pub fn node_name(&self, id: NodeId) -> String {
        match &self.node(id).kind {
            NodeKind::Element(e) => e.name.to_uppercase(),
            NodeKind::Text(_) => "#text".into(),
            NodeKind::Comment(_) => "#comment".into(),
            NodeKind::CData(_) => "#cdatasection".into(),
            NodeKind::Document => "#document".into(),
            NodeKind::Fragment => "#document-fragment".into(),
            NodeKind::Doctype(_) => "#document-type".into(),
        }
    }

    pub fn attributes(&self, id: NodeId) -> &[Attribute] {
        self.element(id).map_or(&[], |e| e.attrs.as_slice())
    }

    pub fn has_attribute(&self, id: NodeId, name: &str) -> bool {
        self.attributes(id).iter().any(|a| a.name == name)
    }

    /// `getAttribute(name)` on an HTML element. Names match exactly, so `HREF` is not `href`.
    /// `class` is the normalised class list and is `""`, never `null`, when the element has no
    /// class attribute.
    pub fn get_attribute(&self, id: NodeId, name: &str) -> Option<Cow<'_, str>> {
        let element = self.element(id)?;
        if name == "class" {
            return Some(match element.attrs.iter().find(|a| a.name == "class") {
                Some(attr) => Cow::Owned(class_tokens(&attr.value).join(" ")),
                None => Cow::Borrowed(""),
            });
        }
        element
            .attrs
            .iter()
            .find(|a| a.name == name)
            .map(|a| Cow::Borrowed(a.value.as_str()))
    }

    /// `setAttribute(name, value)`. An attribute that did not exist is inserted before the
    /// others, not after them, because linkedom links it right behind the element.
    pub fn set_attribute(&mut self, id: NodeId, name: &str, value: &str) {
        let value = if name == "class" {
            class_tokens(value).join(" ")
        } else {
            value.to_string()
        };
        let Some(element) = self.element_mut(id) else {
            return;
        };
        match element.attrs.iter_mut().find(|a| a.name == name) {
            Some(attr) => attr.value = value,
            None => element.attrs.insert(
                0,
                Attribute {
                    name: name.to_string(),
                    value,
                },
            ),
        }
    }

    /// `removeAttribute(name)`.
    pub fn remove_attribute(&mut self, id: NodeId, name: &str) {
        if let Some(element) = self.element_mut(id)
            && let Some(pos) = element.attrs.iter().position(|a| a.name == name)
        {
            element.attrs.remove(pos);
        }
    }

    /// `element.id`.
    pub fn id_attr(&self, id: NodeId) -> String {
        self.get_attribute(id, "id")
            .map(Cow::into_owned)
            .unwrap_or_default()
    }

    /// `element.className`.
    pub fn class_name(&self, id: NodeId) -> String {
        self.get_attribute(id, "class")
            .map(Cow::into_owned)
            .unwrap_or_default()
    }

    /// `[...element.classList]`.
    pub fn class_list(&self, id: NodeId) -> Vec<String> {
        self.get_attribute(id, "class")
            .map(|v| class_tokens(&v).into_iter().map(str::to_string).collect())
            .unwrap_or_default()
    }

    pub fn class_list_contains(&self, id: NodeId, token: &str) -> bool {
        self.class_list(id).iter().any(|t| t == token)
    }

    /// `classList.add(...tokens)`. Empty tokens are skipped; a token holding whitespace stays one
    /// token.
    pub fn class_list_add(&mut self, id: NodeId, tokens: &[&str]) {
        let mut list = self.class_list(id);
        for token in tokens.iter().filter(|t| !t.is_empty()) {
            if !list.iter().any(|t| t == token) {
                list.push((*token).to_string());
            }
        }
        self.write_class_list(id, &list);
    }

    /// `classList.remove(...tokens)`. The class attribute is written even if nothing changed.
    pub fn class_list_remove(&mut self, id: NodeId, tokens: &[&str]) {
        let mut list = self.class_list(id);
        list.retain(|t| !tokens.contains(&t.as_str()));
        self.write_class_list(id, &list);
    }

    /// `classList.toggle(token, force)`; the result is whether the token is present afterwards.
    pub fn class_list_toggle(&mut self, id: NodeId, token: &str, force: Option<bool>) -> bool {
        let mut list = self.class_list(id);
        if let Some(pos) = list.iter().position(|t| t == token) {
            if force == Some(true) {
                return true;
            }
            list.remove(pos);
            self.write_class_list(id, &list);
            return false;
        }
        if force.unwrap_or(true) {
            list.push(token.to_string());
            self.write_class_list(id, &list);
            return true;
        }
        false
    }

    fn write_class_list(&mut self, id: NodeId, list: &[String]) {
        let value = list.join(" ");
        let Some(element) = self.element_mut(id) else {
            return;
        };
        match element.attrs.iter_mut().find(|a| a.name == "class") {
            Some(attr) => attr.value = value,
            None => element.attrs.insert(
                0,
                Attribute {
                    name: "class".into(),
                    value,
                },
            ),
        }
    }

    /// `element.getElementsByClassName(name)` in document order.
    pub fn get_elements_by_class_name(&self, root: NodeId, class_name: &str) -> Vec<NodeId> {
        self.descendants(root)
            .into_iter()
            .filter(|&n| self.has_attribute(n, "class") && self.class_list_contains(n, class_name))
            .collect()
    }

    /// `getElementsByTagName(tag)`: matches the stored name or its upper-cased form, so both
    /// `div` and `DIV` work and `*` matches nothing.
    pub fn get_elements_by_tag_name(&self, root: NodeId, tag: &str) -> Vec<NodeId> {
        self.descendants(root)
            .into_iter()
            .filter(|&n| {
                self.element(n)
                    .is_some_and(|e| e.name == tag || e.name.to_uppercase() == tag)
            })
            .collect()
    }

    /// `getElementById(id)` on a document or fragment. `element.id` is `""` for an element
    /// without one, so an empty `id` finds the first element.
    pub fn get_element_by_id(&self, root: NodeId, id: &str) -> Option<NodeId> {
        self.descendants(root)
            .into_iter()
            .find(|&n| self.is_element(n) && self.id_attr(n) == id)
    }

    /// `textContent`: `None` for documents, fragments and doctypes, which linkedom gives `null`.
    pub fn text_content(&self, id: NodeId) -> Option<String> {
        match &self.node(id).kind {
            NodeKind::Text(t) | NodeKind::Comment(t) | NodeKind::CData(t) => Some(t.clone()),
            NodeKind::Element(_) => {
                let mut out = String::new();
                self.walk(id, false, &mut |n| {
                    if let NodeKind::Text(t) | NodeKind::CData(t) = &self.node(n).kind {
                        out.push_str(t);
                    }
                });
                Some(out)
            }
            _ => None,
        }
    }

    /// `textContent = text`. An element loses its children and gains one text node unless `text`
    /// is empty.
    pub fn set_text_content(&mut self, id: NodeId, text: &str) -> Result<(), ExtractError> {
        match &mut self.node_mut(id).kind {
            NodeKind::Text(t) | NodeKind::Comment(t) | NodeKind::CData(t) => {
                *t = text.to_string();
                Ok(())
            }
            NodeKind::Element(_) => {
                let nodes = if text.is_empty() {
                    vec![]
                } else {
                    vec![self.create_text_node(text)]
                };
                self.replace_children(id, &nodes)
            }
            _ => Ok(()),
        }
    }

    /// `nodeValue`: the data of character-data nodes.
    pub fn node_value(&self, id: NodeId) -> Option<&str> {
        match &self.node(id).kind {
            NodeKind::Text(t) | NodeKind::Comment(t) | NodeKind::CData(t) => Some(t),
            _ => None,
        }
    }

    /// `document.documentElement`: the first element child of the document.
    pub fn document_element(&self) -> Option<NodeId> {
        self.document_element_of(self.root())
    }

    /// `documentElement` of the document node `root`: the main document or a `cloneNode` of it.
    pub fn document_element_of(&self, root: NodeId) -> Option<NodeId> {
        self.first_element_child(root)
    }

    /// `document.head`, which linkedom creates inside the document element when it is not the
    /// first element child. `None` when the document has no element at all (JS throws).
    pub fn head(&mut self) -> Option<NodeId> {
        self.head_of(self.root())
    }

    /// `head` of the document node `root`.
    pub fn head_of(&mut self, root: NodeId) -> Option<NodeId> {
        let html = self.document_element_of(root)?;
        if let Some(first) = self.first_element_child(html)
            && self.tag_name(first).as_deref() == Some("HEAD")
        {
            return Some(first);
        }
        let head = self.create_element("head");
        self.prepend(html, head).ok()?;
        Some(head)
    }

    /// `document.body`, created after `head` when missing.
    pub fn body(&mut self) -> Option<NodeId> {
        self.body_of(self.root())
    }

    /// `body` of the document node `root`.
    pub fn body_of(&mut self, root: NodeId) -> Option<NodeId> {
        let head = self.head_of(root)?;
        if let Some(next) = self.next_element_sibling(head)
            && self.tag_name(next).as_deref() == Some("BODY")
        {
            return Some(next);
        }
        let body = self.create_element("body");
        self.after(head, &[body]).ok()?;
        Some(body)
    }
}
