//! The `citations`, `footnotesList` and `removals` (footnote backlink) rules.

use crate::web::extract::dom::NodeId;
use crate::web::extract::markdown::turndown::NodeInfo;
use crate::web::extract::markdown::turndown::parse::Dom;
use crate::web::extract::utils::js::{is_js_whitespace, to_lower, trim};

pub fn is_backref(dom: &Dom, node: NodeId) -> bool {
    dom.is_element(node)
        && (dom.attr(node, "href").is_some_and(|h| h.contains("#fnref"))
            || dom.class_contains(node, "footnote-backref"))
}

pub fn backref(_: &mut Dom, _: NodeId, _: &str, _: &NodeInfo) -> String {
    String::new()
}

pub fn is_citation(dom: &Dom, node: NodeId) -> bool {
    dom.is_name(node, "SUP")
        && dom
            .attr(node, "id")
            .is_some_and(|id| id.starts_with("fnref:"))
}

pub fn citation(dom: &mut Dom, node: NodeId, content: &str, _: &NodeInfo) -> String {
    let Some(id) = dom.attr(node, "id") else {
        return content.to_string();
    };
    let rest = id.replacen("fnref:", "", 1);
    format!("[^{}]", rest.split('-').next().unwrap_or_default())
}

pub fn is_footnotes_list(dom: &Dom, node: NodeId) -> bool {
    dom.is_name(node, "OL")
        && dom
            .doc
            .parent_node(node)
            .is_some_and(|p| dom.attr(p, "id") == Some("footnotes"))
}

/// `/cite_note-(.+)/` on `id.split('/').pop()`: the text after the first `cite_note-` that has
/// at least one non-terminator character after it, up to the line end.
fn cite_note_id(id: &str) -> Option<String> {
    let last = id.rsplit('/').next().unwrap_or(id);
    let terminator = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let mut start = 0;
    while let Some(found) = last[start..].find("cite_note-") {
        let after = start + found + "cite_note-".len();
        let rest: String = last[after..]
            .chars()
            .take_while(|&c| !terminator(c))
            .collect();
        if !rest.is_empty() {
            return Some(rest);
        }
        start += found + 1;
    }
    None
}

pub fn footnotes_list(dom: &mut Dom, node: NodeId, _: &str, _: &NodeInfo) -> String {
    let references: Vec<String> = dom
        .children(node)
        .into_iter()
        .map(|li| {
            let id = dom
                .attr(li, "id")
                .map(|li_id| match li_id.strip_prefix("fn:") {
                    Some(_) => li_id.replacen("fn:", "", 1),
                    None => cite_note_id(li_id).unwrap_or_else(|| li_id.to_string()),
                });
            // The leading sup goes when its text is the footnote id.
            if let Some(sup) = dom.query_name(li, &["sup"])
                && id.as_deref().is_some_and(|id| trim(&dom.text(sup)) == id)
            {
                dom.doc.remove(sup);
            }
            let reference = dom.turndown(&dom.inner_html(li));
            let cleaned = trim(strip_backlink(&reference)).to_string();
            let name = id.map_or("undefined".to_string(), |id| to_lower(&id));
            format!("[^{name}]: {cleaned}")
        })
        .collect();
    format!("\n\n{}\n\n", references.join("\n\n"))
}

/// `.replace(/\s*↩︎$/, '')`.
fn strip_backlink(text: &str) -> &str {
    match text.strip_suffix("\u{21a9}\u{fe0e}") {
        Some(rest) => rest.trim_end_matches(is_js_whitespace),
        None => text,
    }
}
