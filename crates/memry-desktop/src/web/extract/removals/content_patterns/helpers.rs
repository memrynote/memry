//! The small functions `content-patterns.js` shares between its passes.

use crate::web::extract::constants::CONTENT_ELEMENT_SELECTOR;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::js::{split_whitespace_runs, trim};
use crate::web::extract::utils::text::count_words;

use super::regexes::{NEWSLETTER_PATTERN, SHALLOW_PATH_PATTERN, expand_astral, split_camel_case};

pub(super) const HEADING_SELECTOR: &str = "h1, h2, h3, h4, h5, h6";

/// `el.textContent`.
pub(super) fn text(doc: &Document, el: NodeId) -> String {
    doc.text_content(el).unwrap_or_default()
}

/// `el.textContent?.trim() || ''`.
pub(super) fn trimmed(doc: &Document, el: NodeId) -> String {
    trim(&text(doc, el)).to_string()
}

pub(super) fn words(doc: &Document, el: NodeId) -> usize {
    count_words(&text(doc, el))
}

pub(super) fn is_heading_tag(doc: &Document, el: NodeId) -> bool {
    matches!(
        doc.tag_name(el).as_deref().map(str::as_bytes),
        Some([b'H', b'1'..=b'6'])
    )
}

/// `isOrContainsHeading(el)`.
pub(super) fn is_or_contains_heading(doc: &Document, el: NodeId) -> Result<bool, ExtractError> {
    Ok(is_heading_tag(doc, el) || doc.query_selector(el, HEADING_SELECTOR)?.is_some())
}

/// `isNewsletterElement(el, maxWords)`.
pub(super) fn is_newsletter_element(
    doc: &Document,
    el: NodeId,
    max_words: usize,
) -> Result<bool, ExtractError> {
    let text = trimmed(doc, el);
    let count = count_words(&text);
    if count < 2 || count > max_words {
        return Ok(false);
    }
    if doc.query_selector(el, &CONTENT_ELEMENT_SELECTOR)?.is_some() {
        return Ok(false);
    }
    let normalized = split_camel_case(&text).replace(['\u{2018}', '\u{2019}'], "'");
    Ok(NEWSLETTER_PATTERN.is_match(&expand_astral(&normalized)))
}

/// `walkUpToWrapper(el, text, mainContent)`: the outermost ancestor with the same text.
pub(super) fn walk_up_to_wrapper(doc: &Document, el: NodeId, text: &str, main: NodeId) -> NodeId {
    let mut target = el;
    while let Some(parent) = doc.parent_element(target) {
        if parent == main || trimmed(doc, parent) != text {
            break;
        }
        target = parent;
    }
    target
}

/// `removeTrailingSiblings(element, removeSelf)`: everything after `element`, except the
/// standardized footnotes container.
pub(super) fn remove_trailing_siblings(doc: &mut Document, element: NodeId, remove_self: bool) {
    let mut sibling = doc.next_element_sibling(element);
    while let Some(current) = sibling {
        let next = doc.next_element_sibling(current);
        if doc.id_attr(current) != "footnotes" {
            doc.remove(current);
        }
        sibling = next;
    }
    if remove_self {
        doc.remove(element);
    }
}

/// `removeTrailingWithCascade(target, mainContent)`: `target` and its following siblings, then
/// the following siblings of each ancestor up to the content.
pub(super) fn remove_trailing_with_cascade(doc: &mut Document, target: NodeId, main: NodeId) {
    let mut ancestors = Vec::new();
    let mut anc = doc.parent_element(target);
    while let Some(a) = anc {
        if a == main {
            break;
        }
        ancestors.push(a);
        anc = doc.parent_element(a);
    }
    remove_trailing_siblings(doc, target, true);
    for ancestor in ancestors {
        remove_trailing_siblings(doc, ancestor, false);
    }
}

/// `walkUpIsolated(el, mainContent)`: the highest ancestor with 10 words or fewer before it.
pub(super) fn walk_up_isolated(doc: &Document, el: NodeId, main: NodeId) -> NodeId {
    let mut target = el;
    while let Some(parent) = doc.parent_element(target) {
        if parent == main {
            break;
        }
        let mut preceding_words = 0;
        let mut sib = doc.previous_element_sibling(target);
        while let Some(s) = sib {
            preceding_words += words(doc, s);
            if preceding_words > 10 {
                break;
            }
            sib = doc.previous_element_sibling(s);
        }
        if preceding_words > 10 {
            break;
        }
        target = parent;
    }
    target
}

/// `removeThinPrecedingSection(target)`: a CTA or promo block (under 50 words, no content
/// elements) right before a related-posts section.
pub(super) fn remove_thin_preceding_section(
    doc: &mut Document,
    target: NodeId,
) -> Result<(), ExtractError> {
    let Some(prev) = doc.previous_element_sibling(target) else {
        return Ok(());
    };
    if words(doc, prev) >= 50 {
        return Ok(());
    }
    if doc
        .query_selector(prev, &CONTENT_ELEMENT_SELECTOR)?
        .is_some()
    {
        return Ok(());
    }
    // Preceded by a heading: the body of a named section, not a CTA.
    if let Some(before) = doc.previous_element_sibling(prev)
        && is_or_contains_heading(doc, before)?
    {
        return Ok(());
    }
    doc.remove(prev);
    Ok(())
}

/// `isBreadcrumbList(list)`: internal-only links, at least one to the site root or a shallow
/// path, and short labels.
pub(super) fn is_breadcrumb_list(doc: &Document, list: NodeId) -> Result<bool, ExtractError> {
    let list_items = doc.query_selector_all(list, "li")?;
    if list_items.len() < 2 || list_items.len() > 8 {
        return Ok(false);
    }
    let list_links = doc.query_selector_all(list, "a")?;
    if list_links.is_empty() || list_links.len() >= list_items.len() {
        return Ok(false);
    }
    if doc
        .query_selector(list, "img, p, figure, blockquote")?
        .is_some()
    {
        return Ok(false);
    }
    // Breadcrumb items are short labels.
    for item in &list_items {
        if words(doc, *item) > 8 {
            return Ok(false);
        }
    }
    let mut all_internal = true;
    let mut has_breadcrumb_link = false;
    let mut short_link_texts = true;
    for a in list_links {
        let href = doc.get_attribute(a, "href").unwrap_or_default();
        if href.starts_with("http") || href.starts_with("//") {
            all_internal = false;
            break;
        }
        if &*href == "/" || SHALLOW_PATH_PATTERN.is_match(&href) {
            has_breadcrumb_link = true;
        }
        let label = trimmed(doc, a);
        if split_whitespace_runs(&label)
            .iter()
            .filter(|w| !w.is_empty())
            .count()
            > 5
        {
            short_link_texts = false;
        }
    }
    Ok(all_internal && has_breadcrumb_link && short_link_texts)
}
