//! `resolveStreamedContent` (`dist/defuddle.js`): React streaming SSR.

use std::sync::LazyLock;

use regex::Regex;

use crate::web::extract::dom::{Document, NodeId, NodeKind};
use crate::web::extract::error::ExtractError;

/// `/\$RC\("(B:\d+)","(S:\d+)"\)/g`.
static SWAP_CALL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\$RC\("(B:[0-9]+)","(S:[0-9]+)"\)"#).expect("static pattern"));

/// React places streamed content in hidden divs (`id="S:0"`) beside template placeholders
/// (`id="B:0"`) and swaps them with `$RC` scripts. Scripts do not run here, so the swap happens
/// by hand: everything after the template up to the `<!--/$-->` marker goes, the hidden div's
/// children take its place.
pub(super) fn resolve_streamed_content(
    doc: &mut Document,
    root: NodeId,
) -> Result<(), ExtractError> {
    let mut swaps: Vec<(String, String)> = Vec::new();
    for script in doc.query_selector_all(root, "script")? {
        let text = doc.text_content(script).unwrap_or_default();
        if !text.contains("$RC(") {
            continue;
        }
        for call in SWAP_CALL.captures_iter(&text) {
            swaps.push((call[1].to_string(), call[2].to_string()));
        }
    }
    for (template_id, content_id) in swaps {
        let (Some(template), Some(content)) = (
            doc.get_element_by_id(root, &template_id),
            doc.get_element_by_id(root, &content_id),
        ) else {
            continue;
        };
        let Some(parent) = doc.parent_node(template) else {
            continue;
        };
        let mut found_marker = false;
        let mut next = doc.next_sibling(template);
        while let Some(node) = next {
            let following = doc.next_sibling(node);
            let is_marker = matches!(&doc.node(node).kind, NodeKind::Comment(data) if data == "/$");
            doc.remove(node);
            if is_marker {
                found_marker = true;
                break;
            }
            next = following;
        }
        // Malformed streaming output: leave the template alone.
        if !found_marker {
            continue;
        }
        while let Some(child) = doc.first_child(content) {
            doc.insert_before(parent, child, Some(template))?;
        }
        doc.remove(template);
        doc.remove(content);
    }
    Ok(())
}
