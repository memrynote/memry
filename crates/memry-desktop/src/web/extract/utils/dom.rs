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

/// `isDangerousUrl(url)`: `javascript:` and `data:text/html`, whitespace and control characters
/// stripped first.
pub fn is_dangerous_url(url: &str) -> bool {
    let normalized: String = url
        .chars()
        .filter(|&c| !is_js_whitespace(c) && c > '\u{1f}')
        .collect::<String>()
        .to_lowercase();
    normalized.starts_with("javascript:") || normalized.starts_with("data:text/html")
}

/// `escapeHtml(text)`: `&`, `<`, `>` and `"`.
pub fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

/// `document.title` of linkedom: the text of the first `<title>` under `head`, or empty.
pub fn document_title(doc: &mut Document, root: NodeId) -> String {
    let Some(head) = doc.head_of(root) else {
        return String::new();
    };
    doc.get_elements_by_tag_name(head, "title")
        .first()
        .and_then(|&t| doc.text_content(t))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dangerous_urls() {
        assert!(is_dangerous_url(" java\tscript:alert(1)"));
        assert!(is_dangerous_url("DATA:text/html;base64,xx"));
        assert!(!is_dangerous_url("data:image/png;base64,xx"));
        assert!(!is_dangerous_url("https://a.com"));
    }

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
