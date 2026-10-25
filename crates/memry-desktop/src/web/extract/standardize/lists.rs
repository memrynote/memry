//! The ARIA role rules of `standardizeElements`: `div[role=paragraph]`, `div[role=list]` and
//! `div[role=listitem]` become `p`, `ul`/`ol` and `li`.

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::elements::headings::copy_allowed_attributes;
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::transfer_content;
use crate::web::extract::utils::js::trim;

pub const PARAGRAPH_SELECTOR: &str = "div[data-testid^=\"paragraph\"], div[role=\"paragraph\"]";
pub const LIST_SELECTOR: &str = "div[role=\"list\"]";
pub const LIST_ITEM_SELECTOR: &str = "div[role=\"listitem\"]";

/// The paragraph rule's `transform`.
pub fn paragraph(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let p = doc.create_element("p");
    transfer_content(doc, el, p)?;
    copy_allowed_attributes(doc, el, p);
    Ok(p)
}

/// `label.match(/^\d+\)/)`: ASCII digits, then `)`.
fn is_ordered_label(label: &str) -> bool {
    let rest = label.trim_start_matches(|c: char| c.is_ascii_digit());
    rest.len() < label.len() && rest.starts_with(')')
}

/// Whether the first item label of `list` reads `1)`, `2)`, ...
fn is_ordered(doc: &Document, list: NodeId) -> Result<bool, ExtractError> {
    let label = doc
        .query_selector(list, "div[role=\"listitem\"] .label")?
        .and_then(|l| doc.text_content(l))
        .unwrap_or_default();
    Ok(is_ordered_label(trim(&label)))
}

/// Replaces every `div[role=paragraph]` below `container` with a `p`.
fn convert_paragraphs(doc: &mut Document, container: NodeId) -> Result<(), ExtractError> {
    for div in doc.query_selector_all(container, "div[role=\"paragraph\"]")? {
        let p = doc.create_element("p");
        transfer_content(doc, div, p)?;
        doc.replace_with(div, &[p])?;
    }
    Ok(())
}

/// One nested list: a fresh `ol`/`ul` with an `li` per item, replacing the original.
fn convert_nested_list(doc: &mut Document, nested: NodeId) -> Result<(), ExtractError> {
    let list = doc.create_element(if is_ordered(doc, nested)? { "ol" } else { "ul" });
    for item in doc.query_selector_all(nested, LIST_ITEM_SELECTOR)? {
        let li = doc.create_element("li");
        if let Some(content) = doc.query_selector(item, ".content")? {
            convert_paragraphs(doc, content)?;
            transfer_content(doc, content, li)?;
        }
        doc.append_child(list, li)?;
    }
    doc.replace_with(nested, &[list])
}

/// The list rule's `transform`. Items are gathered from every depth, so an item of a nested
/// list also becomes an item of this list, as Defuddle does.
pub fn list(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let list = doc.create_element(if is_ordered(doc, el)? { "ol" } else { "ul" });
    for item in doc.query_selector_all(el, LIST_ITEM_SELECTOR)? {
        let li = doc.create_element("li");
        if let Some(content) = doc.query_selector(item, ".content")? {
            convert_paragraphs(doc, content)?;
            for nested in doc.query_selector_all(content, LIST_SELECTOR)? {
                convert_nested_list(doc, nested)?;
            }
            transfer_content(doc, content, li)?;
        }
        doc.append_child(list, li)?;
    }
    Ok(list)
}

/// The list item rule's `transform`: the `.content` element stands in for the item.
pub fn list_item(doc: &mut Document, el: NodeId) -> Result<NodeId, ExtractError> {
    let Some(content) = doc.query_selector(el, ".content")? else {
        return Ok(el);
    };
    convert_paragraphs(doc, content)?;
    Ok(content)
}
