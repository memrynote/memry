//! `collapseWhitespace` of turndown 7.2.4, with `isPre` set to `PRE` or `CODE`
//! (`preformattedCode: true`).

use super::parse::Dom;
use crate::web::extract::dom::NodeId;
use crate::web::extract::dom::node::node_type;

fn is_pre(dom: &Dom, node: NodeId) -> bool {
    dom.is_name(node, "PRE") || dom.is_name(node, "CODE")
}

/// `next(prev, current, isPre)`.
fn next(dom: &Dom, prev: Option<NodeId>, current: NodeId) -> Option<NodeId> {
    let doc = &dom.doc;
    if prev.is_some_and(|p| doc.parent_node(p) == Some(current)) || is_pre(dom, current) {
        return doc
            .next_sibling(current)
            .or_else(|| doc.parent_node(current));
    }
    doc.first_child(current)
        .or_else(|| doc.next_sibling(current))
        .or_else(|| doc.parent_node(current))
}

/// `remove(node)`: unlinks `node` and returns the node after it.
fn remove(dom: &mut Dom, node: NodeId) -> Option<NodeId> {
    let following = dom
        .doc
        .next_sibling(node)
        .or_else(|| dom.doc.parent_node(node));
    dom.doc.remove(node);
    following
}

fn data(dom: &Dom, node: NodeId) -> String {
    dom.doc.node_value(node).unwrap_or_default().to_string()
}

fn set_data(dom: &mut Dom, node: NodeId, text: &str) {
    dom.doc
        .set_text_content(node, text)
        .expect("character data accepts text");
}

/// `text.replace(/[ \r\n\t]+/g, ' ')`.
fn collapse_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if matches!(c, ' ' | '\r' | '\n' | '\t') {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            in_run = false;
            out.push(c);
        }
    }
    out
}

pub fn collapse_whitespace(dom: &mut Dom, element: NodeId) {
    if dom.doc.first_child(element).is_none() || is_pre(dom, element) {
        return;
    }
    let mut prev_text: Option<NodeId> = None;
    let mut keep_leading_ws = false;
    let mut prev: Option<NodeId> = None;
    let mut node = next(dom, prev, element);
    while let Some(current) = node {
        if current == element {
            break;
        }
        match dom.doc.node_type(current) {
            node_type::TEXT | node_type::CDATA_SECTION => {
                let mut text = collapse_runs(&data(dom, current));
                let prev_ends_with_space = prev_text.is_none_or(|p| data(dom, p).ends_with(' '));
                if prev_ends_with_space && !keep_leading_ws && text.starts_with(' ') {
                    text.remove(0);
                }
                if text.is_empty() {
                    node = remove(dom, current);
                    continue;
                }
                set_data(dom, current, &text);
                prev_text = Some(current);
            }
            node_type::ELEMENT => {
                if dom.is_block(current) || dom.is_name(current, "BR") {
                    if let Some(p) = prev_text {
                        let text = data(dom, p);
                        set_data(dom, p, text.strip_suffix(' ').unwrap_or(&text));
                    }
                    prev_text = None;
                    keep_leading_ws = false;
                } else if dom.is_void_node(current) || is_pre(dom, current) {
                    // Avoid trimming space around non-block, non-BR void elements and inline PRE.
                    prev_text = None;
                    keep_leading_ws = true;
                } else if prev_text.is_some() {
                    // Drop protection if set previously.
                    keep_leading_ws = false;
                }
            }
            _ => {
                node = remove(dom, current);
                continue;
            }
        }
        let following = next(dom, prev, current);
        prev = Some(current);
        node = following;
    }
    if let Some(p) = prev_text {
        let text = data(dom, p);
        let trimmed = text.strip_suffix(' ').unwrap_or(&text).to_string();
        set_data(dom, p, &trimmed);
        if trimmed.is_empty() {
            remove(dom, p);
        }
    }
}
