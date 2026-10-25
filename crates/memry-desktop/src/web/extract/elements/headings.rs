//! Port of `dist/elements/headings.js`: permalink anchors and the heading rule of
//! `standardizeElements`.

use crate::web::extract::constants::ALLOWED_ATTRIBUTES;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::tag_lower;
use crate::web::extract::utils::js::{to_lower, trim};

/// `removePermalinkAnchors(element)`.
pub fn remove_permalink_anchors(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let links = doc.query_selector_all(
        element,
        "h1 a, h2 a, h3 a, h4 a, h5 a, h6 a, a.permalink, a.anchor-link, a.heading-anchor",
    )?;
    for link in links {
        if is_permalink_anchor(doc, link) {
            doc.remove(link);
        }
    }
    Ok(())
}

/// `isPermalinkAnchor(node)`. The JS symbol class `[#¶§🔗\uFEFF]` has no `u` flag, so the
/// emoji is two surrogate units that never form a one-unit text, and `\uFEFF` is trimmed away
/// before the test: only `#`, `¶` and `§` can match.
pub fn is_permalink_anchor(doc: &Document, node: NodeId) -> bool {
    if tag_lower(doc, node) != "a" {
        return false;
    }
    let href = doc.get_attribute(node, "href").unwrap_or_default();
    let title = to_lower(&doc.get_attribute(node, "title").unwrap_or_default());
    let class_name = to_lower(&doc.get_attribute(node, "class").unwrap_or_default());
    let text = doc.text_content(node).unwrap_or_default();
    if href.starts_with('#') || title.contains("permalink") {
        return true;
    }
    if class_name.contains("permalink")
        || class_name.contains("heading-anchor")
        || class_name.contains("anchor-link")
    {
        return true;
    }
    let mut chars = trim(&text).chars();
    matches!((chars.next(), chars.next()), (Some('#' | '¶' | '§'), None))
}

/// `isHeadingNavElement(node)`.
fn is_heading_nav_element(doc: &Document, node: NodeId) -> Result<bool, ExtractError> {
    let tag = tag_lower(doc, node);
    if tag == "button" || (tag == "a" && is_permalink_anchor(doc, node)) {
        return Ok(true);
    }
    if doc.class_list_contains(node, "anchor") || doc.class_list_contains(node, "permalink-widget")
    {
        return Ok(true);
    }
    if tag == "span" || tag == "div" {
        for a in doc.query_selector_all(node, "a")? {
            if is_permalink_anchor(doc, a) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// The `h1`-`h6` rule's `transform(el)`: a fresh heading of the same level that keeps the
/// allowed attributes and holds only the text left once navigation elements are gone.
pub fn clean_heading(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let tag = doc.tag_name(el).unwrap_or_default();
    let new_heading = doc.create_element(&tag);
    copy_allowed_attributes(doc, el, new_heading);
    // No child elements means no navigation elements to remove.
    if doc.children(el).is_empty() {
        let text = doc.text_content(el).unwrap_or_default();
        doc.set_text_content(new_heading, trim(&text))?;
        return Ok(new_heading);
    }
    let clone = doc.clone_node(el, true);
    // A `Map` keyed by element: re-setting a key keeps its first position.
    let mut navigation_text: Vec<(NodeId, String)> = Vec::new();
    let mut set_text =
        |key: NodeId, text: String| match navigation_text.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = text,
            None => navigation_text.push((key, text)),
        };
    let mut to_remove = Vec::new();
    for child in doc.query_selector_all(clone, "*")? {
        if !is_heading_nav_element(doc, child)? {
            continue;
        }
        let child_text = trim(&doc.text_content(child).unwrap_or_default()).to_string();
        set_text(child, child_text.clone());
        // An element that holds the only text of its parent hands that text to the parent.
        if let Some(parent) = doc.parent_element(child)
            && parent != clone
            && trim(&doc.text_content(parent).unwrap_or_default()) == child_text
        {
            set_text(parent, child_text);
        }
        to_remove.push(child);
    }
    for child in to_remove {
        doc.remove(child);
    }
    let mut text = trim(&doc.text_content(clone).unwrap_or_default()).to_string();
    // All text was navigation text: use the first of it.
    if text.is_empty()
        && let Some((_, first)) = navigation_text.first()
    {
        text = first.clone();
    }
    doc.set_text_content(new_heading, &text)?;
    Ok(new_heading)
}

/// Copies the attributes of `from` that `ALLOWED_ATTRIBUTES` lists onto `to`, in source order.
pub fn copy_allowed_attributes(doc: &mut Document, from: NodeId, to: NodeId) {
    let attrs: Vec<_> = doc.attributes(from).to_vec();
    for attr in attrs {
        if ALLOWED_ATTRIBUTES.contains(&attr.name.as_str()) {
            doc.set_attribute(to, &attr.name, &attr.value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_permalink_anchor;
    use crate::web::extract::dom::Document;

    fn anchor(html: &str) -> bool {
        let doc = Document::parse_html(html);
        let a = doc.query_selector(doc.root(), "a").unwrap().unwrap();
        is_permalink_anchor(&doc, a)
    }

    #[test]
    fn symbol_text_matches_as_the_js_class_does() {
        // `/^[#¶§🔗\uFEFF]$/.test(text)` in Node: true for `§`, false for the two-unit emoji.
        assert!(anchor("<a href=\"/x\">§</a>"));
        assert!(!anchor("<a href=\"/x\">\u{1f517}</a>"));
        assert!(!anchor("<a href=\"/x\">##</a>"));
        assert!(anchor("<a href=\"#x\">text</a>"));
        assert!(anchor("<a href=\"/x\" title=\"Permalink to this\">t</a>"));
    }
}
