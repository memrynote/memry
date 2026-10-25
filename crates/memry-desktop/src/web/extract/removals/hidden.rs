//! Port of `dist/removals/hidden.js`: elements hidden by an inline style or a utility class.
//!
//! Defuddle also asks `getComputedStyle` in a real browser. linkedom is never a browser
//! (`window` is undefined), so that branch is not reachable and is not ported.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId};
use crate::web::extract::error::ExtractError;
use crate::web::extract::utils::dom::has_responsive_show_class;
use crate::web::extract::utils::js::{WS, is_js_whitespace};

/// `hiddenStylePattern`.
static HIDDEN_STYLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        "(?:^|;{WS}*)(?:(?i-u:display){WS}*:{WS}*(?i-u:none)|(?i-u:visibility){WS}*:{WS}*(?i-u:hidden)|(?i-u:opacity){WS}*:{WS}*0)(?:{WS}*;|{WS}*$)"
    ))
    .expect("static pattern")
});

/// `removeHiddenElements(doc)`.
pub fn remove_hidden_elements(doc: &mut Document, root: NodeId) -> Result<(), ExtractError> {
    let mut to_remove: Vec<NodeId> = Vec::new();
    for element in doc.query_selector_all(root, "*")? {
        // Wikipedia wraps MathML in display:none spans; math extraction needs them.
        if doc
            .query_selector(element, "math, [data-mathml], .katex-mathml")?
            .is_some()
            || doc.tag_name(element).as_deref() == Some("MATH")
        {
            continue;
        }
        if let Some(style) = doc.get_attribute(element, "style")
            && !style.is_empty()
            && HIDDEN_STYLE.is_match(&style)
        {
            to_remove.push(element);
            continue;
        }
        let class_name = doc
            .get_attribute(element, "class")
            .map(|c| c.into_owned())
            .unwrap_or_default();
        if class_name.is_empty() {
            continue;
        }
        if has_responsive_show_class(&class_name) {
            continue;
        }
        for token in class_name.split(is_js_whitespace) {
            // Tailwind arbitrary variants contain "[" and are conditional, not unconditional.
            let exact = token == "hidden" || token == "invisible";
            let variant = !token.contains('[')
                && (token.ends_with(":hidden") || token.ends_with(":invisible"));
            if exact || variant {
                to_remove.push(element);
                break;
            }
        }
    }
    for element in to_remove {
        doc.remove(element);
    }
    Ok(())
}
