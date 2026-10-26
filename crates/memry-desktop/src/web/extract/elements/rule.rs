//! One `ELEMENT_STANDARDIZATION_RULES` entry (`{ selector, fastCheck, transform }`) of the
//! element handlers that `standardizeElements` applies.

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;

/// `transform(el, doc)`: the element that replaces `el`.
pub type Transform = fn(&mut Document, NodeId) -> Result<NodeId, ExtractError>;

pub struct Rule {
    pub selector: &'static str,
    /// Skips the rule when `element.querySelector(fastCheck)` finds nothing.
    pub fast_check: Option<&'static str>,
    pub transform: Transform,
}

/// `getAttribute(name)` as an owned string, `null` read as `None`.
pub fn attr(doc: &Document, el: NodeId, name: &str) -> Option<String> {
    doc.get_attribute(el, name)
        .map(std::borrow::Cow::into_owned)
}

/// `getAttribute(name) || ''`.
pub fn attr_or_empty(doc: &Document, el: NodeId, name: &str) -> String {
    attr(doc, el, name).unwrap_or_default()
}
