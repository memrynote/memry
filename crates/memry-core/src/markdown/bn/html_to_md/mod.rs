//! BlockNote 0.54.2 `htmlToMarkdown` (`exporters/markdown/htmlToMarkdown.ts`):
//! the external HTML of the exporter to GFM markdown, over the arena DOM.
//!
//! Only the structure the TypeScript reads is read here: tag names, text, and
//! the attributes `src`, `alt`, `href`, `start`, `checked`, `colspan`,
//! `rowspan`, `data-language`, `data-name`, `data-url` and `title`.

mod blocks;
mod inline;
mod lists;
mod table;

use crate::markdown::bn::dom::{Dom, NodeData, NodeId, parse_fragment_in_div};
use crate::markdown::frontmatter::js::js_trim;

/// The exporter's placeholder for an empty inline-content block (U+FFFC),
/// stripped by `cleanHTMLToMarkdown` before the conversion.
pub const EMPTY_BLOCK_PLACEHOLDER: &str = "\u{FFFC}";

/// `cleanHTMLToMarkdown`.
pub fn clean_html_to_markdown(html: &str) -> String {
    html_to_markdown(&html.replace(EMPTY_BLOCK_PLACEHOLDER, ""))
}

/// `htmlToMarkdown`: `container.innerHTML = html`, serialize, trim, add `\n`.
pub fn html_to_markdown(html: &str) -> String {
    let (dom, container) = parse_fragment_in_div(html);
    let ctx = Ctx {
        indent: String::new(),
        in_list_item: false,
    };
    let result = serialize_children(&dom, container, &ctx);
    format!("{}\n", js_trim(&result))
}

/// `SerializeContext`.
pub(super) struct Ctx {
    pub indent: String,
    /// The node is continuation content of a list item: no trailing blank
    /// lines, which would make the parent list loose.
    pub in_list_item: bool,
}

pub(super) fn tag(dom: &Dom, id: NodeId) -> String {
    dom.node_name_lower(id)
}

pub(super) fn element_children(dom: &Dom, id: NodeId) -> Vec<NodeId> {
    dom.children(id)
        .iter()
        .copied()
        .filter(|c| dom.is_element(*c))
        .collect()
}

/// `el.querySelector(tag)` for a bare tag name: the first descendant in document order.
pub(super) fn query_tag(dom: &Dom, root: NodeId, name: &str) -> Option<NodeId> {
    dom.descendants(root)
        .into_iter()
        .find(|d| *d != root && dom.is_html(*d, name))
}

pub(super) fn query_tag_all(dom: &Dom, root: NodeId, names: &[&str]) -> Vec<NodeId> {
    dom.descendants(root)
        .into_iter()
        .filter(|d| *d != root && names.iter().any(|n| dom.is_html(*d, n)))
        .collect()
}

pub(super) fn serialize_children(dom: &Dom, node: NodeId, ctx: &Ctx) -> String {
    let mut result = String::new();
    for child in dom.children(node).to_vec() {
        result.push_str(&serialize_node(dom, child, ctx));
    }
    result
}

pub(super) fn serialize_node(dom: &Dom, node: NodeId, ctx: &Ctx) -> String {
    match dom.data(node) {
        NodeData::Text(text) => return text.clone(),
        NodeData::Element(_) => {}
        _ => return String::new(),
    }
    match tag(dom, node).as_str() {
        "p" => blocks::paragraph(dom, node, ctx),
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => blocks::heading(dom, node, ctx),
        "blockquote" => blocks::blockquote(dom, node, ctx),
        "pre" => blocks::code_block(dom, node, ctx),
        "ul" => lists::unordered(dom, node, ctx),
        "ol" => lists::ordered(dom, node, ctx),
        "table" => table::table(dom, node, ctx),
        "hr" => format!("{}***\n\n", ctx.indent),
        "img" => blocks::image(dom, node, ctx),
        "video" => blocks::video(dom, node, ctx),
        "audio" => blocks::audio(dom, node, ctx),
        "embed" => blocks::embed(dom, node, ctx),
        "figure" => blocks::figure(dom, node, ctx),
        "a" => blocks::block_link(dom, node, ctx),
        "details" => blocks::details(dom, node, ctx),
        "br" => String::new(),
        _ => serialize_children(dom, node, ctx),
    }
}
