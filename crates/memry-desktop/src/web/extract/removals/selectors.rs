//! Port of `dist/removals/selectors.js`: removal of known clutter by tag, class and id.

use std::collections::HashSet;

use crate::web::extract::constants::{
    EXACT_SELECTORS_JOINED, FOOTNOTE_LIST_SELECTORS, HIDDEN_EXACT_SELECTOR,
    HIDDEN_EXACT_SKIP_SELECTOR, TEST_ATTRIBUTES_SELECTOR, partial_selectors_anchored_match,
    partial_selectors_match,
};
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::has_responsive_show_class;
use crate::web::extract::utils::js::{is_js_whitespace, to_lower, trim};

const HEADING_SELECTOR: &str = "h1, h2, h3, h4, h5, h6";

/// `removeBySelector(doc, debug, removeExact, removePartial, mainContent, _, skipHiddenExact)`.
pub fn remove_by_selector(
    doc: &mut Document,
    root: NodeId,
    remove_exact: bool,
    remove_partial: bool,
    main: Option<NodeId>,
    skip_hidden_exact_selectors: bool,
) -> Result<(), ExtractError> {
    // A JS `Map` keyed by element: insertion order decides removal order.
    let mut to_remove: Vec<NodeId> = Vec::new();
    let mut marked: HashSet<NodeId> = HashSet::new();

    if remove_exact {
        for el in doc.query_selector_all(root, &EXACT_SELECTORS_JOINED)? {
            if doc.parent_node(el).is_none() {
                continue;
            }
            if skip_hidden_exact_selectors {
                let hidden_ancestor = doc.closest(el, &HIDDEN_EXACT_SKIP_SELECTOR)?;
                let role = to_lower(&doc.get_attribute(el, "role").unwrap_or_default());
                if doc.matches(el, &HIDDEN_EXACT_SELECTOR)?
                    || (hidden_ancestor.is_some() && role == "dialog")
                {
                    continue;
                }
            }
            // Syntax highlighting spans.
            if doc.closest(el, "pre, code")?.is_some() {
                continue;
            }
            // "hidden sm:flex": visible at some breakpoints.
            if doc.matches(el, &HIDDEN_EXACT_SELECTOR)?
                && has_responsive_show_class(&doc.class_name(el))
            {
                continue;
            }
            if marked.insert(el) {
                to_remove.push(el);
            }
        }
    }

    if remove_partial {
        // linkedom's document-level query can miss elements after earlier mutations, so
        // Defuddle also queries the content element; the union keeps the first occurrence.
        let mut candidates = doc.query_selector_all(root, &TEST_ATTRIBUTES_SELECTOR)?;
        if let Some(main) = main {
            candidates.extend(doc.query_selector_all(main, &TEST_ATTRIBUTES_SELECTOR)?);
        }
        let mut seen: HashSet<NodeId> = HashSet::new();
        for el in candidates {
            if !seen.insert(el) || marked.contains(&el) {
                continue;
            }
            if doc.closest(el, "[data-defuddle]")?.is_some() {
                continue;
            }
            // Code: class names there name a language or a syntax token, not page structure.
            let tag = doc.tag_name(el).unwrap_or_default();
            if tag == "CODE"
                || tag == "PRE"
                || doc.query_selector(el, "pre")?.is_some()
                || doc.closest(el, "code, pre")?.is_some()
            {
                continue;
            }
            // Heading ids are auto-slugs and data-testid values cause false positives.
            let is_heading = matches!(tag.as_bytes(), [b'H', b'1'..=b'6']);
            let attr = |name: &str| doc.get_attribute(el, name).unwrap_or_default().into_owned();
            let attrs = if is_heading {
                doc.class_name(el)
            } else {
                format!(
                    "{} {} {} {} {} {} {}",
                    doc.class_name(el),
                    attr("data-component"),
                    attr("data-test"),
                    attr("data-testid"),
                    attr("data-test-id"),
                    attr("data-qa"),
                    attr("data-cy")
                )
            };
            let attrs = to_lower(&attrs);
            let id = if is_heading {
                String::new()
            } else {
                to_lower(&doc.id_attr(el))
            };
            let has_attrs = !trim(&attrs).is_empty();
            if !has_attrs && id.is_empty() {
                continue;
            }
            // A delimited id is substring-matched like the other attributes. A delimiter-less
            // id is usually a content anchor concatenated from heading words, so it must equal
            // a selector token outright.
            let attrs_match = has_attrs && partial_selectors_match(&attrs);
            let id_has_delimiter = !id.is_empty()
                && id
                    .chars()
                    .any(|c| is_js_whitespace(c) || matches!(c, '_' | '-' | ':' | '.'));
            let id_match = if id.is_empty() {
                false
            } else if id_has_delimiter {
                partial_selectors_match(&id)
            } else {
                partial_selectors_anchored_match(&id)
            };
            if (attrs_match || id_match) && marked.insert(el) {
                to_remove.push(el);
            }
        }
    }

    for el in to_remove {
        if let Some(main) = main
            && doc.contains(el, main)
        {
            continue;
        }
        if doc.tag_name(el).as_deref() == Some("A") && doc.closest(el, HEADING_SELECTOR)?.is_some()
        {
            continue;
        }
        if is_footnote_protected(doc, el) {
            continue;
        }
        let is_button = doc.tag_name(el).as_deref() == Some("BUTTON");
        // Buttons that wrap media (image zoom overlays): keep the media, drop the chrome.
        if is_button && doc.query_selector(el, "img, picture, video")?.is_some() {
            if let Some(parent) = doc.parent_element(el) {
                for media in doc.query_selector_all(el, "img, picture, video")? {
                    doc.insert_before(parent, media, Some(el))?;
                }
                doc.remove(el);
            }
            continue;
        }
        // Inline buttons keep their text (LeetCode tooltip terms).
        if is_button
            && doc
                .closest(el, "p, li, td, th, span, h1, h2, h3, h4, h5, h6")?
                .is_some()
        {
            let children = doc.child_nodes(el);
            doc.replace_with(el, &children)?;
            continue;
        }
        doc.remove(el);
    }
    Ok(())
}

/// The `try { ... } catch (e) {}` block of the removal loop: footnote lists, their parents'
/// immediate children and the backlinks `standardizeFootnotes` writes stay. A selector error
/// ends the block unprotected, as the empty `catch` does.
fn is_footnote_protected(doc: &Document, el: NodeId) -> bool {
    fn check(doc: &Document, el: NodeId) -> Result<bool, ExtractError> {
        if doc.matches(el, &FOOTNOTE_LIST_SELECTORS)?
            || doc.query_selector(el, &FOOTNOTE_LIST_SELECTORS)?.is_some()
        {
            return Ok(true);
        }
        if let Some(parent) = doc.parent_element(el)
            && doc.matches(parent, &FOOTNOTE_LIST_SELECTORS)?
        {
            return Ok(true);
        }
        Ok(doc.class_list_contains(el, "footnote-backref")
            && doc.closest(el, "#footnotes")?.is_some())
    }
    check(doc, el).unwrap_or(false)
}
