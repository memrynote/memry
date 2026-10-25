//! The arena document: node creation, tree edits and traversal.
//!
//! Every method names the linkedom 0.18.12 call it ports. Edits that linkedom performs without a
//! check but that would corrupt its linked list (inserting a node into its own subtree, using a
//! reference node of another parent) return an error instead of building a broken tree.

use super::node::{DoctypeData, ElementData, Node, NodeId, NodeKind};
use crate::web::extract::error::ExtractError;

pub struct Document {
    pub(super) nodes: Vec<Node>,
}

impl Default for Document {
    fn default() -> Self {
        Self::new()
    }
}

fn dom_error(message: &str) -> ExtractError {
    ExtractError::Dom(message.to_string())
}

impl Document {
    /// An empty `HTMLDocument`.
    pub fn new() -> Self {
        Document {
            nodes: vec![Node::new(NodeKind::Document)],
        }
    }

    pub fn root(&self) -> NodeId {
        NodeId(0)
    }

    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id.index()]
    }

    pub(super) fn node_mut(&mut self, id: NodeId) -> &mut Node {
        &mut self.nodes[id.index()]
    }

    fn alloc(&mut self, kind: NodeKind) -> NodeId {
        self.nodes.push(Node::new(kind));
        NodeId(u32::try_from(self.nodes.len() - 1).expect("arena holds fewer than 2^32 nodes"))
    }

    // Creation (document.createElement and friends).

    /// `document.createElement(name)` on an HTML document: the name is kept as given.
    pub fn create_element(&mut self, name: &str) -> NodeId {
        self.alloc(NodeKind::Element(ElementData {
            name: name.to_string(),
            attrs: Vec::new(),
            svg: false,
        }))
    }

    /// `document.createElementNS(SVG_NAMESPACE, name)`.
    pub fn create_svg_element(&mut self, name: &str) -> NodeId {
        self.alloc(NodeKind::Element(ElementData {
            name: name.to_string(),
            attrs: Vec::new(),
            svg: true,
        }))
    }

    pub fn create_text_node(&mut self, data: &str) -> NodeId {
        self.alloc(NodeKind::Text(data.to_string()))
    }

    pub fn create_comment(&mut self, data: &str) -> NodeId {
        self.alloc(NodeKind::Comment(data.to_string()))
    }

    pub fn create_cdata_section(&mut self, data: &str) -> NodeId {
        self.alloc(NodeKind::CData(data.to_string()))
    }

    pub fn create_document_fragment(&mut self) -> NodeId {
        self.alloc(NodeKind::Fragment)
    }

    pub(super) fn create_doctype(&mut self, data: DoctypeData) -> NodeId {
        self.alloc(NodeKind::Doctype(data))
    }

    // Reading the tree.

    pub fn node_type(&self, id: NodeId) -> u8 {
        self.node(id).node_type()
    }

    pub fn is_element(&self, id: NodeId) -> bool {
        matches!(self.node(id).kind, NodeKind::Element(_))
    }

    pub fn element(&self, id: NodeId) -> Option<&ElementData> {
        match &self.node(id).kind {
            NodeKind::Element(data) => Some(data),
            _ => None,
        }
    }

    pub(super) fn element_mut(&mut self, id: NodeId) -> Option<&mut ElementData> {
        match &mut self.node_mut(id).kind {
            NodeKind::Element(data) => Some(data),
            _ => None,
        }
    }

    pub fn parent_node(&self, id: NodeId) -> Option<NodeId> {
        self.node(id).parent
    }

    /// `parentElement`: the parent unless it is the document or a fragment.
    pub fn parent_element(&self, id: NodeId) -> Option<NodeId> {
        self.node(id).parent.filter(|&p| self.is_element(p))
    }

    pub fn first_child(&self, id: NodeId) -> Option<NodeId> {
        self.node(id).first_child
    }

    pub fn last_child(&self, id: NodeId) -> Option<NodeId> {
        self.node(id).last_child
    }

    pub fn next_sibling(&self, id: NodeId) -> Option<NodeId> {
        self.node(id).next
    }

    /// `previousSibling`. linkedom answers `null` when the node before is a doctype, because its
    /// helper only recognises elements and character data.
    pub fn previous_sibling(&self, id: NodeId) -> Option<NodeId> {
        self.node(id)
            .prev
            .filter(|&p| !matches!(self.node(p).kind, NodeKind::Doctype(_)))
    }

    pub fn next_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let mut next = self.next_sibling(id);
        while let Some(n) = next {
            if self.is_element(n) {
                return Some(n);
            }
            next = self.next_sibling(n);
        }
        None
    }

    pub fn previous_element_sibling(&self, id: NodeId) -> Option<NodeId> {
        let mut prev = self.previous_sibling(id);
        while let Some(p) = prev {
            if self.is_element(p) {
                return Some(p);
            }
            prev = self.previous_sibling(p);
        }
        None
    }

    pub fn child_nodes(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        let mut child = self.first_child(id);
        while let Some(c) = child {
            out.push(c);
            child = self.next_sibling(c);
        }
        out
    }

    /// `children`: the element children.
    pub fn children(&self, id: NodeId) -> Vec<NodeId> {
        self.child_nodes(id)
            .into_iter()
            .filter(|&c| self.is_element(c))
            .collect()
    }

    pub fn first_element_child(&self, id: NodeId) -> Option<NodeId> {
        let mut child = self.first_child(id);
        while let Some(c) = child {
            if self.is_element(c) {
                return Some(c);
            }
            child = self.next_sibling(c);
        }
        None
    }

    pub fn last_element_child(&self, id: NodeId) -> Option<NodeId> {
        let mut child = self.last_child(id);
        while let Some(c) = child {
            if self.is_element(c) {
                return Some(c);
            }
            child = self.previous_sibling(c);
        }
        None
    }

    pub fn child_element_count(&self, id: NodeId) -> usize {
        self.children(id).len()
    }

    pub fn has_child_nodes(&self, id: NodeId) -> bool {
        self.first_child(id).is_some()
    }

    /// Every descendant in document order, `id` itself excluded.
    pub fn descendants(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        self.walk(id, false, &mut |n| out.push(n));
        out
    }

    /// Pre-order walk below `id`. With `skip_template` an element named `template` is visited
    /// but not entered, as linkedom's `querySelector` does.
    pub(super) fn walk(&self, id: NodeId, skip_template: bool, visit: &mut dyn FnMut(NodeId)) {
        self.walk_until(id, skip_template, &mut |n| {
            visit(n);
            false
        });
    }

    /// Like `walk`, but stops when `visit` returns true.
    pub(super) fn walk_until(
        &self,
        id: NodeId,
        skip_template: bool,
        visit: &mut dyn FnMut(NodeId) -> bool,
    ) {
        let mut current = self.first_child(id);
        while let Some(n) = current {
            if visit(n) {
                return;
            }
            let enter = !(skip_template && self.element(n).is_some_and(|e| e.name == "template"));
            current = if enter && self.first_child(n).is_some() {
                self.first_child(n)
            } else {
                self.next_in_order(n, id)
            };
        }
    }

    /// The next node after `n` once its subtree is finished, staying inside `root`.
    fn next_in_order(&self, n: NodeId, root: NodeId) -> Option<NodeId> {
        let mut cur = n;
        loop {
            if let Some(next) = self.next_sibling(cur) {
                return Some(next);
            }
            cur = self.parent_node(cur)?;
            if cur == root {
                return None;
            }
        }
    }

    /// `contains`: true for the node itself. Character data and doctypes contain nothing.
    pub fn contains(&self, this: NodeId, node: NodeId) -> bool {
        if !matches!(
            self.node(this).kind,
            NodeKind::Element(_) | NodeKind::Document | NodeKind::Fragment
        ) {
            return false;
        }
        let mut cur = Some(node);
        while let Some(c) = cur {
            if c == this {
                return true;
            }
            cur = self.parent_node(c);
        }
        false
    }

    // Editing.

    fn is_inclusive_ancestor(&self, ancestor: NodeId, node: NodeId) -> bool {
        let mut cur = Some(node);
        while let Some(c) = cur {
            if c == ancestor {
                return true;
            }
            cur = self.parent_node(c);
        }
        false
    }

    /// Unlinks `id` from its parent and siblings (`ChildNode.remove`).
    pub fn remove(&mut self, id: NodeId) {
        let (parent, prev, next) = {
            let n = self.node(id);
            (n.parent, n.prev, n.next)
        };
        if let Some(p) = prev {
            self.node_mut(p).next = next;
        }
        if let Some(n) = next {
            self.node_mut(n).prev = prev;
        }
        if let Some(parent) = parent {
            if self.node(parent).first_child == Some(id) {
                self.node_mut(parent).first_child = next;
            }
            if self.node(parent).last_child == Some(id) {
                self.node_mut(parent).last_child = prev;
            }
        }
        let n = self.node_mut(id);
        n.parent = None;
        n.prev = None;
        n.next = None;
    }

    /// Links a detached `node` under `parent` before `before` (the end when `None`).
    pub(super) fn link(&mut self, parent: NodeId, node: NodeId, before: Option<NodeId>) {
        let prev = match before {
            Some(b) => self.node(b).prev,
            None => self.node(parent).last_child,
        };
        {
            let n = self.node_mut(node);
            n.parent = Some(parent);
            n.prev = prev;
            n.next = before;
        }
        match prev {
            Some(p) => self.node_mut(p).next = Some(node),
            None => self.node_mut(parent).first_child = Some(node),
        }
        match before {
            Some(b) => self.node_mut(b).prev = Some(node),
            None => self.node_mut(parent).last_child = Some(node),
        }
    }

    /// `parent.insertBefore(node, before)`.
    pub fn insert_before(
        &mut self,
        parent: NodeId,
        node: NodeId,
        before: Option<NodeId>,
    ) -> Result<NodeId, ExtractError> {
        if Some(node) == before {
            return Ok(node);
        }
        if node == parent {
            return Err(dom_error("unable to append a node to itself"));
        }
        if let Some(b) = before
            && self.node(b).parent != Some(parent)
        {
            return Err(dom_error("the reference node is not a child of this node"));
        }
        match self.node(node).kind {
            NodeKind::Fragment => {
                for child in self.child_nodes(node) {
                    self.remove(child);
                    self.link(parent, child, before);
                }
            }
            NodeKind::Document => return Err(dom_error("a document cannot be inserted")),
            NodeKind::Element(_) => {
                if self.is_inclusive_ancestor(node, parent) {
                    return Err(dom_error("the new child contains the parent"));
                }
                self.remove(node);
                self.link(parent, node, before);
            }
            _ => {
                self.remove(node);
                self.link(parent, node, before);
            }
        }
        Ok(node)
    }

    pub fn append_child(&mut self, parent: NodeId, node: NodeId) -> Result<NodeId, ExtractError> {
        self.insert_before(parent, node, None)
    }

    pub fn prepend(&mut self, parent: NodeId, node: NodeId) -> Result<NodeId, ExtractError> {
        let first = self.first_child(parent);
        self.insert_before(parent, node, first)
    }

    /// `parent.removeChild(node)`.
    pub fn remove_child(&mut self, parent: NodeId, node: NodeId) -> Result<NodeId, ExtractError> {
        if self.node(node).parent != Some(parent) {
            return Err(dom_error("node is not a child"));
        }
        self.remove(node);
        Ok(node)
    }

    /// `parent.replaceChild(node, replaced)`.
    pub fn replace_child(
        &mut self,
        parent: NodeId,
        node: NodeId,
        replaced: NodeId,
    ) -> Result<NodeId, ExtractError> {
        if self.node(replaced).parent != Some(parent) {
            return Err(dom_error("node is not a child"));
        }
        let next = self.next_sibling(replaced);
        self.remove(replaced);
        self.insert_before(parent, node, next)?;
        Ok(replaced)
    }

    /// `parent.replaceChildren(...nodes)`.
    pub fn replace_children(
        &mut self,
        parent: NodeId,
        nodes: &[NodeId],
    ) -> Result<(), ExtractError> {
        for child in self.child_nodes(parent) {
            self.remove(child);
        }
        for &node in nodes {
            self.insert_before(parent, node, None)?;
        }
        Ok(())
    }

    fn as_fragment(&mut self, nodes: &[NodeId]) -> Result<NodeId, ExtractError> {
        let fragment = self.create_document_fragment();
        for &node in nodes {
            self.append_child(fragment, node)?;
        }
        Ok(fragment)
    }

    /// `node.before(...nodes)`.
    pub fn before(&mut self, node: NodeId, nodes: &[NodeId]) -> Result<(), ExtractError> {
        if let Some(parent) = self.parent_node(node) {
            let fragment = self.as_fragment(nodes)?;
            self.insert_before(parent, fragment, Some(node))?;
        }
        Ok(())
    }

    /// `node.after(...nodes)`.
    pub fn after(&mut self, node: NodeId, nodes: &[NodeId]) -> Result<(), ExtractError> {
        if let Some(parent) = self.parent_node(node) {
            let fragment = self.as_fragment(nodes)?;
            let next = self.next_sibling(node);
            self.insert_before(parent, fragment, next)?;
        }
        Ok(())
    }

    /// `node.replaceWith(...nodes)`. When `nodes` holds `node` itself, linkedom first swaps in a
    /// shallow clone so that the node can be re-inserted from the list.
    pub fn replace_with(&mut self, node: NodeId, nodes: &[NodeId]) -> Result<(), ExtractError> {
        let Some(parent) = self.parent_node(node) else {
            return Ok(());
        };
        let mut node = node;
        if nodes.contains(&node) {
            let clone = self.clone_node(node, false);
            self.replace_with(node, &[clone])?;
            node = clone;
        }
        let fragment = self.as_fragment(nodes)?;
        self.insert_before(parent, fragment, Some(node))?;
        self.remove(node);
        Ok(())
    }

    /// `node.cloneNode(deep)`. Attributes are always copied, children only when `deep`.
    pub fn clone_node(&mut self, id: NodeId, deep: bool) -> NodeId {
        let kind = self.node(id).kind.clone();
        let clone = self.alloc(kind);
        if deep
            && matches!(
                self.node(id).kind,
                NodeKind::Element(_) | NodeKind::Fragment
            )
        {
            for child in self.child_nodes(id) {
                let child_clone = self.clone_node(child, true);
                self.link(clone, child_clone, None);
            }
        }
        clone
    }

    /// `parent.normalize()`: merges adjacent text nodes and drops empty ones.
    pub fn normalize(&mut self, parent: NodeId) {
        for id in self.descendants(parent) {
            if !matches!(self.node(id).kind, NodeKind::Text(_)) {
                continue;
            }
            let empty = matches!(&self.node(id).kind, NodeKind::Text(t) if t.is_empty());
            if empty {
                self.remove(id);
                continue;
            }
            if let Some(prev) = self.node(id).prev
                && matches!(self.node(prev).kind, NodeKind::Text(_))
            {
                let tail = match &self.node(id).kind {
                    NodeKind::Text(t) => t.clone(),
                    _ => unreachable!("checked above"),
                };
                if let NodeKind::Text(t) = &mut self.node_mut(prev).kind {
                    t.push_str(&tail);
                }
                self.remove(id);
            }
        }
    }
}
