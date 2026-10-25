//! BlockNote's tree edits between the HTML parse and the ProseMirror
//! `DOMParser`: `nestedListsToBlockNoteStructure` and `preprocessHTMLWhitespace`
//! (`parsers/html/util/{nestedLists,normalizeWhitespace}.ts`).

use super::dom::{Dom, NodeData, NodeId, Selector};
use crate::markdown::frontmatter::js::is_js_whitespace;

/// A tree edit the TypeScript code performs on a node that is not there; the
/// oracle sees a thrown `TypeError` and the conversion fails.
#[derive(Debug, PartialEq, thiserror::Error)]
#[error("html tree edit hit a missing node: {0}")]
pub struct TreeError(pub &'static str);

fn is_whitespace_node(dom: &Dom, id: NodeId) -> bool {
    dom.text_value(id)
        .is_some_and(|t| t.chars().all(is_js_whitespace))
}

/// Step 1: a list nested in a list item becomes a sibling of that item, and
/// whatever followed it in the item becomes list items of their own.
fn lift_nested_lists_to_parent(dom: &mut Dom, root: NodeId) -> Result<(), TreeError> {
    let lists = dom.query_selector_all(root, &Selector::new("li > ul, li > ol"));
    for list in lists {
        let item = dom
            .parent_element(list)
            .ok_or(TreeError("nested list has no parent"))?;
        let index = dom
            .children(item)
            .iter()
            .position(|c| *c == list)
            .ok_or(TreeError("nested list is not a child of its parent"))?;
        let after: Vec<NodeId> = dom.children(item)[index + 1..].to_vec();
        dom.detach(list);
        for sibling in &after {
            dom.detach(*sibling);
        }
        // `insertAdjacentElement("afterend")` on a parentless item does nothing.
        if dom.parent(item).is_some() {
            dom.insert_after(item, list);
        }
        for sibling in after.into_iter().rev() {
            if is_whitespace_node(dom, sibling) {
                continue;
            }
            let container = dom.create_element("li");
            dom.append_child(container, sibling);
            if dom.parent(list).is_some() {
                dom.insert_after(list, container);
            }
        }
        if dom.children(item).is_empty() {
            dom.detach(item);
        }
    }
    Ok(())
}

/// Step 2: a list that follows an item moves, with the lists after it, into a
/// `blockGroup` div beside that item inside a wrapping div.
fn create_groups(dom: &mut Dom, root: NodeId) -> Result<(), TreeError> {
    let lists = dom.query_selector_all(root, &Selector::new("li + ul, li + ol"));
    for list in lists {
        let item = dom
            .previous_element_sibling(list)
            .ok_or(TreeError("list has no previous element sibling"))?;
        let container = dom.create_element("div");
        if dom.parent(item).is_some() {
            dom.insert_after(item, container);
        }
        dom.append_child(container, item);
        let group = dom.create_element("div");
        dom.set_attr(group, "data-node-type", "blockGroup");
        dom.append_child(container, group);
        while let Some(next) = dom.next_element_sibling(container) {
            if !(dom.is_html(next, "ul") || dom.is_html(next, "ol")) {
                break;
            }
            dom.append_child(group, next);
        }
    }
    Ok(())
}

pub fn nested_lists_to_blocknote_structure(dom: &mut Dom, root: NodeId) -> Result<(), TreeError> {
    lift_nested_lists_to_parent(dom, root)?;
    create_groups(dom, root)
}

/// `<!-- notionvc: ... -->` marks HTML from Notion, whose `\n` is a hard break.
fn is_notion_html(dom: &Dom, root: NodeId) -> bool {
    dom.descendants(root).into_iter().any(|id| {
        dom.comment_value(id).is_some_and(|c| {
            c.trim_start_matches(is_js_whitespace)
                .starts_with("notionvc:")
        })
    })
}

/// Collapses runs of whitespace that contain a line break in every text node
/// outside `pre` and `code`, as CSS `white-space: normal` does.
pub fn preprocess_html_whitespace(dom: &mut Dom, root: NodeId) {
    if is_notion_html(dom, root) {
        return;
    }
    let texts: Vec<NodeId> = dom
        .descendants(root)
        .into_iter()
        .filter(|id| matches!(dom.data(*id), NodeData::Text(_)))
        .filter(|id| {
            let mut parent = dom.parent_element(*id);
            while let Some(p) = parent.filter(|p| *p != root) {
                if dom.is_html(p, "pre") || dom.is_html(p, "code") {
                    return false;
                }
                parent = dom.parent_element(p);
            }
            true
        })
        .collect();
    for id in texts {
        let value = dom.text_value(id).unwrap_or_default();
        if value.contains(['\r', '\n']) {
            let collapsed = collapse_ascii_whitespace(value);
            dom.set_text_value(id, collapsed);
        }
    }
}

/// `replace(/[ \t\r\n\f]+/g, " ")`.
fn collapse_ascii_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if matches!(c, ' ' | '\t' | '\r' | '\n' | '\u{0C}') {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::bn::dom::parse_fragment_in_div;

    fn structure(html: &str) -> String {
        let (mut dom, root) = parse_fragment_in_div(html);
        nested_lists_to_blocknote_structure(&mut dom, root).unwrap();
        dom.inner_html(root)
    }

    #[test]
    fn a_nested_list_leaves_its_item_and_groups_under_it() {
        assert_eq!(
            structure("<ul><li>a<ul><li>b</li></ul></li></ul>"),
            "<ul><div><li>a</li><div data-node-type=\"blockGroup\"><ul><li>b</li></ul></div></div></ul>"
        );
    }

    #[test]
    fn text_after_a_nested_list_becomes_a_list_item() {
        assert_eq!(
            structure("<ul><li>a<ul><li>b</li></ul>tail</li></ul>"),
            "<ul><div><li>a</li><div data-node-type=\"blockGroup\"><ul><li>b</li></ul></div></div><li>tail</li></ul>"
        );
    }

    #[test]
    fn an_item_holding_only_a_list_disappears() {
        assert_eq!(
            structure("<ul><li><ul><li>b</li></ul></li></ul>"),
            "<ul><ul><li>b</li></ul></ul>"
        );
    }

    #[test]
    fn whitespace_with_a_line_break_collapses_outside_pre() {
        let (mut dom, root) = parse_fragment_in_div("<p>a \n b</p><pre>c \n d</pre><p>e  f</p>");
        preprocess_html_whitespace(&mut dom, root);
        assert_eq!(
            dom.inner_html(root),
            "<p>a b</p><pre>c \n d</pre><p>e  f</p>"
        );
    }

    #[test]
    fn notion_html_keeps_its_line_breaks() {
        let (mut dom, root) = parse_fragment_in_div("<!-- notionvc: 1 --><p>a\nb</p>");
        preprocess_html_whitespace(&mut dom, root);
        assert_eq!(dom.inner_html(root), "<!-- notionvc: 1 --><p>a\nb</p>");
    }
}
