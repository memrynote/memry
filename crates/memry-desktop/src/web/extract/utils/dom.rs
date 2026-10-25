//! DOM helpers of `dist/utils/dom.js` and `dist/utils.js`.

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;

/// `el.tagName.toLowerCase()`: `localName` as parsed or created, lower-cased.
pub fn tag_lower(doc: &Document, el: NodeId) -> String {
    doc.local_name(el)
        .map(str::to_lowercase)
        .unwrap_or_default()
}

/// `isSVGElement(el)` of `dist/utils.js`: inside an `<svg>` (or one itself), or an SVG-namespace
/// element.
pub fn is_svg_element(doc: &Document, el: NodeId) -> Result<bool, ExtractError> {
    Ok(doc.closest(el, "svg")?.is_some() || doc.element(el).is_some_and(|e| e.svg))
}

/// `transferContent(source, target)`: empties `target`, then moves every child of `source` into
/// it.
pub fn transfer_content(
    doc: &mut Document,
    source: NodeId,
    target: NodeId,
) -> Result<(), ExtractError> {
    doc.replace_children(target, &[])?;
    while let Some(child) = doc.first_child(source) {
        doc.append_child(target, child)?;
    }
    Ok(())
}

/// `isDirectTableChild(el, ancestor)`: `el` belongs to `ancestor` itself, not to a table nested
/// between them.
pub fn is_direct_table_child(doc: &Document, el: NodeId, ancestor: NodeId) -> bool {
    let mut parent = doc.parent_node(el);
    while let Some(p) = parent {
        if p == ancestor {
            return true;
        }
        if doc.node_name(p) == "TABLE" {
            return false;
        }
        parent = doc.parent_node(p);
    }
    false
}

/// `unwrapElement` of `dist/standardize.js`: the children move in front of `el`, then `el` goes.
pub fn unwrap_element(doc: &mut Document, el: NodeId) -> Result<(), ExtractError> {
    if let Some(parent) = doc.parent_node(el) {
        while let Some(child) = doc.first_child(el) {
            doc.insert_before(parent, child, Some(el))?;
        }
    }
    doc.remove(el);
    Ok(())
}

/// `decodeHTMLEntities(doc, text)`: assigns `text` to a `<textarea>`'s `innerHTML` and reads its
/// `value`. linkedom's `TextElement` implements both as `textContent`, so no entity is decoded
/// and the text comes back unchanged (pinned by `schema_org` vectors that hold entities).
pub fn decode_html_entities(text: &str) -> String {
    text.to_string()
}

use std::sync::LazyLock;

use regex::Regex;

use super::js::is_js_whitespace;

/// `RESPONSIVE_SHOW_RE`: a Tailwind breakpoint prefix on a show utility.
static RESPONSIVE_SHOW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:sm|md|lg|xl|2xl|min-\[|max-\[):(?:block|flex|grid|inline|table|contents)")
        .expect("static pattern")
});

/// `hasResponsiveShowClass(className)`: some `className.split(/\s+/)` token is a responsive show
/// utility such as `sm:block`, so the element is visible at some breakpoints.
pub fn has_responsive_show_class(class_name: &str) -> bool {
    class_name
        .split(is_js_whitespace)
        .any(|token| RESPONSIVE_SHOW_RE.is_match(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responsive_show_classes() {
        assert!(has_responsive_show_class("hidden sm:flex"));
        assert!(has_responsive_show_class("x  min-[:grid"));
        // The pattern has no room for the bracket content, so real arbitrary breakpoints miss.
        assert!(!has_responsive_show_class("min-[100px]:grid"));
        assert!(!has_responsive_show_class("hidden sm:hidden lg:invisible"));
        assert!(!has_responsive_show_class("xs:block"));
        assert!(!has_responsive_show_class(""));
    }
}
