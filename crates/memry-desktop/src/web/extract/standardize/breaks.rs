//! Steps that remove what holds no content: empty elements, extra `<br>`, orphaned `<hr>` and
//! trailing headings.

use crate::web::extract::constants::{ALLOWED_EMPTY_ELEMENTS, BLOCK_LEVEL_ELEMENTS};
use crate::web::extract::dom::node::node_type;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::tag_lower;
use crate::web::extract::utils::js::trim;

fn text_of(doc: &Document, node: NodeId) -> String {
    doc.text_content(node).unwrap_or_default()
}

/// `skipWhitespace(node, direction)`: the neighbor sibling that is not a whitespace-only text.
fn skip_whitespace(doc: &Document, node: NodeId, previous: bool) -> Option<NodeId> {
    let step = |n: NodeId| {
        if previous {
            doc.previous_sibling(n)
        } else {
            doc.next_sibling(n)
        }
    };
    let mut sibling = step(node);
    while let Some(s) = sibling {
        if doc.node_type(s) == node_type::TEXT && trim(&text_of(doc, s)).is_empty() {
            sibling = step(s);
        } else {
            break;
        }
    }
    sibling
}

fn is_br(doc: &Document, node: NodeId) -> bool {
    doc.is_element(node) && tag_lower(doc, node) == "br"
}

/// `removeEmptyElements(element)`: deepest first, so a parent emptied by its children goes too.
pub fn remove_empty_elements(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let mut all = doc.query_selector_all(element, "*")?;
    all.reverse();
    for el in all {
        if doc.parent_node(el).is_some() && is_empty_element(doc, el) {
            doc.remove(el);
        }
    }
    Ok(())
}

fn is_empty_element(doc: &Document, el: NodeId) -> bool {
    if ALLOWED_EMPTY_ELEMENTS.contains(&tag_lower(doc, el).as_str()) {
        return false;
    }
    // A div that only holds spans of commas.
    if doc.tag_name(el).as_deref() == Some("DIV") {
        let children = doc.children(el);
        if !children.is_empty()
            && children.iter().all(|&child| {
                doc.tag_name(child).as_deref() == Some("SPAN") && {
                    let content = text_of(doc, child);
                    let content = trim(&content);
                    content == "," || content.is_empty()
                }
            })
        {
            return true;
        }
    }
    let text = text_of(doc, el);
    if !trim(&text).is_empty() || text.contains('\u{a0}') {
        return false;
    }
    // No meaningful child: only `<br>` spacers and whitespace text.
    doc.child_nodes(el).into_iter().all(|node| {
        if is_br(doc, node) {
            return true;
        }
        if doc.node_type(node) != node_type::TEXT {
            return false;
        }
        let text = text_of(doc, node);
        trim(&text).is_empty() && !text.contains('\u{a0}')
    })
}

/// `stripExtraBrElements(element)`: runs of more than two `<br>` shrink to two, then `<br>`
/// between blocks and trailing in a block go.
pub fn strip_extra_br_elements(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let mut run: Vec<NodeId> = Vec::new();
    let process = |doc: &mut Document, run: &mut Vec<NodeId>| {
        if run.len() > 2 {
            for &br in &run[2..] {
                doc.remove(br);
            }
        }
        run.clear();
    };
    for current in doc.get_elements_by_tag_name(element, "br") {
        let consecutive = run
            .last()
            .is_some_and(|&last| skip_whitespace(doc, current, true) == Some(last));
        if consecutive {
            run.push(current);
        } else {
            process(doc, &mut run);
            run.push(current);
        }
    }
    process(doc, &mut run);

    for br in doc.get_elements_by_tag_name(element, "br") {
        let Some(parent) = doc.parent_element(br) else {
            continue;
        };
        if doc.closest(br, "pre, code")?.is_some() {
            continue;
        }
        let parent_tag = tag_lower(doc, parent);
        // A `<br>` (or group of them) between block siblings: `</p><br><p>`.
        if BLOCK_LEVEL_ELEMENTS.contains(&parent_tag.as_str()) || parent_tag == "body" {
            let mut group = vec![br];
            let mut scan = skip_whitespace(doc, br, false);
            while let Some(s) = scan.filter(|&s| is_br(doc, s)) {
                group.push(s);
                scan = skip_whitespace(doc, s, false);
            }
            let prev = skip_whitespace(doc, group[0], true);
            let next = skip_whitespace(doc, group[group.len() - 1], false);
            let is_block = |n: Option<NodeId>| {
                n.is_some_and(|n| {
                    doc.is_element(n) && BLOCK_LEVEL_ELEMENTS.contains(&tag_lower(doc, n).as_str())
                })
            };
            let (prev_is_block, next_is_block) = (is_block(prev), is_block(next));
            if (prev_is_block && next_is_block)
                || (prev_is_block && next.is_none())
                || prev.is_none()
            {
                for b in group {
                    doc.remove(b);
                }
                continue;
            }
        }
        // A trailing `<br>` in a block: `<p>Some text. <br></p>`.
        if BLOCK_LEVEL_ELEMENTS.contains(&parent_tag.as_str())
            && skip_whitespace(doc, br, false).is_none()
        {
            doc.remove(br);
        }
    }
    Ok(())
}

/// `removeOrphanedDividers(element)`: leading and trailing `<hr>` go, and runs of `<hr>` collapse.
pub fn remove_orphaned_dividers(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for previous in [false, true] {
        loop {
            let edge = if previous {
                doc.last_child(element)
            } else {
                doc.first_child(element)
            };
            let mut node = edge;
            while let Some(n) = node {
                if doc.node_type(n) == node_type::TEXT && trim(&text_of(doc, n)).is_empty() {
                    node = if previous {
                        doc.previous_sibling(n)
                    } else {
                        doc.next_sibling(n)
                    };
                } else {
                    break;
                }
            }
            match node.filter(|&n| doc.is_element(n) && tag_lower(doc, n) == "hr") {
                Some(hr) => doc.remove(hr),
                None => break,
            }
        }
    }
    for hr in doc.query_selector_all(element, "hr")? {
        if doc.parent_node(hr).is_none() {
            continue;
        }
        let mut node = doc.next_sibling(hr);
        while let Some(n) = node {
            if doc.node_type(n) == node_type::TEXT && trim(&text_of(doc, n)).is_empty() {
                node = doc.next_sibling(n);
            } else if doc.tag_name(n).as_deref() == Some("HR") {
                node = doc.next_sibling(n);
                doc.remove(n);
            } else {
                break;
            }
        }
    }
    Ok(())
}

/// `removeTrailingHeadings(element)`: headings with no content after them, from the bottom up,
/// until one has content after it.
pub fn remove_trailing_headings(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let mut headings = doc.query_selector_all(element, "h1, h2, h3, h4, h5, h6")?;
    headings.reverse();
    for heading in headings {
        if has_content_after(doc, element, heading) {
            break;
        }
        doc.remove(heading);
    }
    Ok(())
}

/// `hasContentAfter(el)`: text after `el` at its level or, failing that, after its parents.
fn has_content_after(doc: &Document, element: NodeId, el: NodeId) -> bool {
    let mut next_content = String::new();
    let mut sibling = doc.next_sibling(el);
    while let Some(s) = sibling {
        if doc.node_type(s) == node_type::TEXT || doc.is_element(s) {
            next_content.push_str(&text_of(doc, s));
        }
        sibling = doc.next_sibling(s);
    }
    if !trim(&next_content).is_empty() {
        return true;
    }
    match doc.parent_element(el) {
        Some(parent) if parent != element => has_content_after(doc, element, parent),
        _ => false,
    }
}
