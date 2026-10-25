//! `unwrapSpecialLinks`: links that markdown cannot express are unwrapped or restructured.

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::unwrap_element;

/// `/^H[1-6]$/.test(nodeName)`.
fn is_heading_name(name: &str) -> bool {
    matches!(name.as_bytes(), [b'H', b'1'..=b'6'])
}

pub fn unwrap_special_links(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    // Links inside inline code: markdown cannot render links in backticks.
    for link in doc.query_selector_all(element, "code a")? {
        unwrap_element(doc, link)?;
    }
    for link in doc.query_selector_all(element, "a[href^=\"javascript:\"]")? {
        unwrap_element(doc, link)?;
    }
    // A link that wraps a block with a heading (an article card) moves into the heading:
    // `<a href><h2>T</h2><p>d</p></a>` becomes `<h2><a href>T</a></h2><p>d</p>`.
    for link in doc.query_selector_all(element, "a")? {
        let href = doc
            .get_attribute(link, "href")
            .unwrap_or_default()
            .into_owned();
        if href.is_empty() || href.starts_with('#') {
            continue;
        }
        let Some(heading) = doc
            .children(link)
            .into_iter()
            .find(|&c| is_heading_name(&doc.node_name(c)))
        else {
            continue;
        };
        let inner = doc.create_element("a");
        doc.set_attribute(inner, "href", &href);
        while let Some(child) = doc.first_child(heading) {
            doc.append_child(inner, child)?;
        }
        doc.append_child(heading, inner)?;
        unwrap_element(doc, link)?;
    }
    // Anchor links that wrap headings (clickable section headers).
    for link in doc.query_selector_all(element, "a[href^=\"#\"]")? {
        if doc
            .query_selector(link, "h1, h2, h3, h4, h5, h6")?
            .is_some()
        {
            unwrap_element(doc, link)?;
        }
    }
    Ok(())
}
