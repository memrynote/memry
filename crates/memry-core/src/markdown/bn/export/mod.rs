//! BlockNote 0.54.2's external HTML exporter (`createExternalHTMLExporter`,
//! `serializeBlocksExternalHTML.ts`) over the memry server specs: blocks to the
//! HTML string `htmlToMarkdown` reads.
//!
//! Only the structure and the attributes `html_to_md` reads are built (tag
//! names, text, `src`, `alt`, `href`, `start`, `checked`, `colspan`, `rowspan`,
//! `data-language`): style attributes, classes and `data-*` carry no markdown.

mod blocks;
mod inline;
mod table;

use serde_json::Value as Json;

use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::convert::ConvertError;
use crate::markdown::frontmatter::js::number_to_string;

/// One block's DOM: the element, where its inline content goes, and where its
/// children go when the block names a place (`childrenDOM`).
pub(super) struct Ret {
    pub dom: NodeId,
    pub content: Option<NodeId>,
    pub children: Option<NodeId>,
}

impl Ret {
    pub fn leaf(dom: NodeId) -> Ret {
        Ret {
            dom,
            content: None,
            children: None,
        }
    }

    pub fn with_content(dom: NodeId, content: NodeId) -> Ret {
        Ret {
            dom,
            content: Some(content),
            children: None,
        }
    }
}

pub(super) fn err(message: impl Into<String>) -> ConvertError {
    ConvertError::Serialize(message.into())
}

/// A JavaScript truthiness test of a JSON value.
pub(super) fn truthy(value: Option<&Json>) -> bool {
    match value {
        None | Some(Json::Null) => false,
        Some(Json::Bool(b)) => *b,
        Some(Json::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Json::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `exportBlocks` of the external HTML exporter: blocks to an HTML string.
pub fn export_blocks_html(blocks: &[Json]) -> Result<String, ConvertError> {
    let mut dom = Dom::new();
    let fragment = dom.create_document();
    for block in blocks {
        serialize_block(&mut dom, fragment, block)?;
    }
    Ok(dom.inner_html(fragment))
}

fn move_children(dom: &mut Dom, from: NodeId, to: NodeId) {
    for child in dom.children(from).to_vec() {
        dom.append_child(to, child);
    }
}

fn last_child_name(dom: &Dom, id: NodeId) -> Option<String> {
    dom.children(id).last().map(|c| dom.node_name(*c))
}

/// Block types of the `blockContent` group, which flatten their children.
fn is_block_content(ty: &str) -> bool {
    !matches!(ty, "columnList" | "column")
}

/// Types whose node is `inlineContent` and not `code`: an empty one gets the
/// placeholder character.
fn takes_placeholder(ty: &str) -> bool {
    matches!(
        ty,
        "paragraph"
            | "heading"
            | "quote"
            | "bulletListItem"
            | "numberedListItem"
            | "checkListItem"
            | "toggleListItem"
            | "callout"
    )
}

fn serialize_block(dom: &mut Dom, fragment: NodeId, block: &Json) -> Result<(), ConvertError> {
    let ty = block
        .get("type")
        .and_then(Json::as_str)
        .ok_or_else(|| err("block without a type"))?;
    let props = block.get("props").cloned().unwrap_or(Json::Null);
    let ret = blocks::block_dom(dom, ty, &props, block)?;

    let element_fragment = dom.create_document();
    dom.append_child(element_fragment, ret.dom);

    if let Some(content_dom) = ret.content {
        if truthy(block.get("content")) {
            let nodes = inline::serialize_content(dom, &block["content"], ty)?;
            for node in nodes {
                dom.append_child(content_dom, node);
            }
        }
        if takes_placeholder(ty) && dom.children(content_dom).is_empty() {
            let placeholder = dom.create_text(super::html_to_md::EMPTY_BLOCK_PLACEHOLDER);
            dom.append_child(content_dom, placeholder);
        }
    }

    let list_type = match ty {
        "numberedListItem" => Some("OL"),
        "bulletListItem" | "checkListItem" | "toggleListItem" => Some("UL"),
        _ => None,
    };
    if let Some(list_type) = list_type {
        if last_child_name(dom, fragment).as_deref() != Some(list_type) {
            let list = dom.create_element(list_type);
            if list_type == "OL"
                && let Some(start) = props.get("start")
                && truthy(Some(start))
                && start.as_f64() != Some(1.0)
            {
                let text = start
                    .as_f64()
                    .map_or_else(|| start.to_string(), number_to_string);
                dom.set_attr(list, "start", &text);
            }
            dom.append_child(fragment, list);
        }
        let list = *dom.children(fragment).last().expect("list just ensured");
        move_children(dom, element_fragment, list);
    } else {
        move_children(dom, element_fragment, fragment);
    }

    let children = block
        .get("children")
        .and_then(Json::as_array)
        .filter(|c| !c.is_empty());
    if let Some(children) = children {
        let child_fragment = dom.create_document();
        for child in children {
            serialize_block(dom, child_fragment, child)?;
        }
        let is_list = |dom: &Dom, id: Option<NodeId>| {
            id.is_some_and(|n| matches!(dom.node_name(n).as_str(), "UL" | "OL"))
        };
        let last = dom.children(fragment).last().copied();
        if is_list(dom, last) {
            // Nested lists go into the last list item.
            while let Some(first) = dom.children(child_fragment).first().copied()
                && is_list(dom, Some(first))
            {
                let list = last.expect("checked above");
                match dom.children(list).last().copied() {
                    Some(item) => dom.append_child(item, first),
                    None => return Err(err("a list without items")),
                }
            }
        }
        if let Some(children_dom) = ret.children {
            move_children(dom, child_fragment, children_dom);
        } else if is_block_content(ty) {
            move_children(dom, child_fragment, fragment);
        } else if let Some(content_dom) = ret.content {
            move_children(dom, child_fragment, content_dom);
        }
    }
    Ok(())
}
