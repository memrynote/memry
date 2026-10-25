//! `stripUnwantedAttributes`: only the attributes `ALLOWED_ATTRIBUTES` lists survive, plus the
//! few class and id values later steps read.

use crate::web::extract::constants::ALLOWED_ATTRIBUTES;
use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::{is_svg_element, tag_lower};
use crate::web::extract::utils::js::to_lower;

/// `/^callout(?:-|$)/`.
fn is_callout_class(value: &str) -> bool {
    value
        .strip_prefix("callout")
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
}

fn strip_element(doc: &mut Document, el: NodeId) -> Result<(), ExtractError> {
    // SVG keeps every rendering attribute; its classes mean nothing without the page's CSS.
    if is_svg_element(doc, el)? {
        if doc.has_attribute(el, "class") {
            doc.remove_attribute(el, "class");
        }
        return Ok(());
    }
    let tag = tag_lower(doc, el);
    for attr in doc.attributes(el).to_vec() {
        let name = to_lower(&attr.name);
        let value = attr.value.as_str();
        let preserved = (name == "id"
            && (value.starts_with("fnref:") || value.starts_with("fn:") || value == "footnotes"))
            || (name == "class"
                && ((tag == "code" && value.starts_with("language-"))
                    || value == "footnote-backref"
                    || is_callout_class(value)));
        if preserved {
            continue;
        }
        if !ALLOWED_ATTRIBUTES.contains(&name.as_str()) {
            doc.remove_attribute(el, &attr.name);
        }
    }
    Ok(())
}

/// `stripUnwantedAttributes(element, false)`.
pub fn strip_unwanted_attributes(doc: &mut Document, element: NodeId) -> Result<(), ExtractError> {
    strip_element(doc, element)?;
    for el in doc.query_selector_all(element, "*")? {
        strip_element(doc, el)?;
    }
    Ok(())
}
