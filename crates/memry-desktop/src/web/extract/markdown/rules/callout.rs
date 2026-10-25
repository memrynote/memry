//! The `callout` rule: `div.callout[data-callout]` as an Obsidian callout.

use crate::web::extract::dom::NodeId;
use crate::web::extract::markdown::turndown::NodeInfo;
use crate::web::extract::markdown::turndown::parse::Dom;
use crate::web::extract::utils::js::trim;

pub fn is_callout(dom: &Dom, node: NodeId) -> bool {
    dom.attr(node, "data-callout")
        .is_some_and(|c| !c.is_empty())
        && dom.class_contains(node, "callout")
}

/// `type.charAt(0).toUpperCase() + type.slice(1)`: a first character outside the BMP is half a
/// surrogate pair in JS, which has no case.
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if first.len_utf16() == 1 => first.to_uppercase().chain(chars).collect(),
        _ => text.to_string(),
    }
}

pub fn callout(dom: &mut Dom, node: NodeId, _: &str, _: &NodeInfo) -> String {
    let kind = dom
        .attr(node, "data-callout")
        .filter(|c| !c.is_empty())
        .unwrap_or("note")
        .to_string();
    // data-callout-fold: "-" is collapsed, "+" collapsible but open, absent is not foldable.
    let fold = match dom.attr(node, "data-callout-fold") {
        Some(f @ ("-" | "+")) => f.to_string(),
        _ => String::new(),
    };
    let title = dom
        .query_class(node, "callout-title-inner")
        .first()
        .map(|&inner| trim(&dom.text(inner)).to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| capitalize(&kind));
    // The title leaves the DOM so that it does not reappear in the content.
    if let Some(&title_div) = dom.query_class(node, "callout-title").first() {
        dom.doc.remove(title_div);
    }
    let converted = match dom.query_class(node, "callout-content").first() {
        Some(&content) => dom.turndown(&dom.inner_html(content)),
        None => dom.turndown(&dom.inner_html(node)),
    };
    let quoted: Vec<String> = trim(&converted)
        .split('\n')
        .map(|line| format!("> {line}"))
        .collect();
    format!("\n\n> [!{kind}]{fold} {title}\n{}\n\n", quoted.join("\n"))
}
