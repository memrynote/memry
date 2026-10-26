//! Span steps of `standardizeContent`: drop caps, `data-as` spans, block-styled spans and spans
//! without attributes.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::{transfer_content, unwrap_element};
use crate::web::extract::utils::js::{WS, to_lower, trim};

/// `standardizeDropCaps(element)`: `<span data-caps="initial">T</span><small>HE</small>`
/// becomes the text `THE`.
pub fn standardize_drop_caps(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let caps = doc.query_selector_all(element, "span[data-caps=\"initial\"]")?;
    let mut count = 0;
    for span in caps {
        let Some(parent) = doc.parent_node(span) else {
            continue;
        };
        match doc
            .next_element_sibling(span)
            .filter(|&n| doc.tag_name(n).as_deref() == Some("SMALL"))
        {
            Some(next) => {
                let initial = doc.text_content(span).unwrap_or_default();
                let rest = doc.text_content(next).unwrap_or_default();
                let merged = doc.create_text_node(&format!("{initial}{rest}"));
                doc.insert_before(parent, merged, Some(span))?;
                doc.remove(next);
                doc.remove(span);
            }
            None => unwrap_element(doc, span)?,
        }
        count += 1;
    }
    if count > 0 {
        doc.normalize(element);
    }
    Ok(())
}

const DATA_AS_ALLOWED: &[&str] = &["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote"];

/// `convertDataAsSpans(element, doc)`: `<span data-as="p">` becomes a real `<p>`.
pub fn convert_data_as_spans(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for span in doc.query_selector_all(element, "span[data-as]")? {
        if doc.parent_node(span).is_none() {
            continue;
        }
        let target = to_lower(&doc.get_attribute(span, "data-as").unwrap_or_default());
        if !DATA_AS_ALLOWED.contains(&target.as_str()) {
            continue;
        }
        let replacement = doc.create_element(&target);
        transfer_content(doc, span, replacement)?;
        doc.replace_with(span, &[replacement])?;
    }
    Ok(())
}

/// `TW_BLOCK_RE`: the class token `block`.
static TW_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?:^|{WS})block(?:{WS}|$)")).expect("static pattern"));
/// `DISPLAY_BLOCK_RE`.
static DISPLAY_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?i-u:display){WS}*:{WS}*(?i-u:block)")).expect("static pattern")
});

/// `convertBlockSpans(element, doc)`: a span styled as a block becomes a `<p>`.
pub fn convert_block_spans(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    for span in doc.query_selector_all(element, "span[class*=\"block\"], span[style*=\"block\"]")? {
        if doc.parent_node(span).is_none() {
            continue;
        }
        let is_block = TW_BLOCK.is_match(&doc.class_name(span))
            || DISPLAY_BLOCK.is_match(&doc.get_attribute(span, "style").unwrap_or_default());
        if !is_block || trim(&doc.text_content(span).unwrap_or_default()).is_empty() {
            continue;
        }
        let p = doc.create_element("p");
        transfer_content(doc, span, p)?;
        doc.replace_with(span, &[p])?;
    }
    Ok(())
}

/// `unwrapBareSpans(element)`: spans without attributes give way to their children, innermost
/// first.
pub fn unwrap_bare_spans(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    let mut spans = doc.query_selector_all(element, "span")?;
    spans.reverse();
    let mut count = 0;
    for span in spans {
        let Some(parent) = doc.parent_node(span) else {
            continue;
        };
        if !doc.attributes(span).is_empty() {
            continue;
        }
        while let Some(child) = doc.first_child(span) {
            doc.insert_before(parent, child, Some(span))?;
        }
        doc.remove(span);
        count += 1;
    }
    if count > 0 {
        doc.normalize(element);
    }
    Ok(())
}
