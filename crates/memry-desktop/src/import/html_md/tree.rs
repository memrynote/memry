//! Iterative walks over the arena DOM for the converter and the importers: depth costs no
//! stack.

use crate::web::extract::dom::{Document, NodeId};

/// Pre-order walk of the descendants of `root`, not entering a node `skip` accepts. Stops when
/// `visit` returns true. Iterative, so depth costs no stack.
pub fn walk(
    doc: &Document,
    root: NodeId,
    skip: &mut dyn FnMut(NodeId) -> bool,
    visit: &mut dyn FnMut(NodeId) -> bool,
) {
    let mut current = doc.first_child(root);
    while let Some(node) = current {
        let skipped = skip(node);
        if !skipped && visit(node) {
            return;
        }
        current = match doc.first_child(node) {
            Some(child) if !skipped => Some(child),
            _ => next_in_order(doc, node, root),
        };
    }
}

fn next_in_order(doc: &Document, mut node: NodeId, root: NodeId) -> Option<NodeId> {
    loop {
        if let Some(next) = doc.next_sibling(node) {
            return Some(next);
        }
        node = doc.parent_node(node)?;
        if node == root {
            return None;
        }
    }
}

/// `querySelectorAll` for a predicate: matching descendants in document order.
pub fn select(doc: &Document, root: NodeId, mut test: impl FnMut(NodeId) -> bool) -> Vec<NodeId> {
    let mut found = Vec::new();
    walk(doc, root, &mut |_| false, &mut |n| {
        if test(n) {
            found.push(n);
        }
        false
    });
    found
}
