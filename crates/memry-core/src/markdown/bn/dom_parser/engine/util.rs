//! String and tree helpers of the parse engine.

use yrs::Any;

use super::is_pm_ws;
use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::pm::Attrs;

pub(super) fn attrs_to_any(attrs: Option<&Attrs>) -> Any {
    match attrs {
        Some(a) => Any::Map(
            a.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<std::collections::HashMap<_, _>>()
                .into(),
        ),
        None => Any::Undefined,
    }
}

pub(super) fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if is_pm_ws(c) {
            if !in_run {
                out.push(' ');
                in_run = true;
            }
        } else {
            in_run = false;
            out.push(c);
        }
    }
    out
}

/// `split(/\r?\n|\r/)`.
pub(super) fn split_lines(text: &str) -> Vec<String> {
    let mut lines = vec![String::new()];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                lines.push(String::new());
            }
            '\n' => lines.push(String::new()),
            c => lines.last_mut().expect("non-empty").push(c),
        }
    }
    lines
}

/// `normalizeList`: a list directly after another list item moves into it.
pub(super) fn normalize_list(dom: &mut Dom, parent: NodeId) {
    let mut prev_item: Option<NodeId> = None;
    let mut child = dom.first_child(parent);
    while let Some(mut c) = child {
        let name = dom.is_element(c).then(|| dom.node_name_lower(c));
        match name.as_deref() {
            Some("ul" | "ol") if prev_item.is_some() => {
                let item = prev_item.expect("checked");
                dom.append_child(item, c);
                c = item;
            }
            Some("li") => prev_item = Some(c),
            Some(_) => prev_item = None,
            None => {}
        }
        child = dom.next_sibling(c);
    }
}
