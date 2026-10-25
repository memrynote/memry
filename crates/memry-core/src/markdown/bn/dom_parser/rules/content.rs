//! The `getContent` functions of the rules: BlockNote parses the content of a
//! matched element itself, by cloning parts of the tree and running a nested
//! `DOMParser.parse` over them.

use super::super::{DomParser, ParseError, ParseOptions};
use super::blocks::tag_is;
use crate::markdown::bn::dom::{Dom, NodeId, Selector};
use crate::markdown::frontmatter::js::js_trim;
use crate::markdown::pm::{Fragment, Node};

/// `mergeParagraphs(element)` with its default `<br>` separator (the `\n` one
/// is for plain content, whose `parseContent` never falls through here): the
/// paragraphs below `element` fold into the first.
///
/// The TypeScript does it with `first.innerHTML += separator + other.innerHTML`,
/// which parses the markup again. Moving the nodes gives the same tree.
fn merge_paragraphs(dom: &mut Dom, element: NodeId) {
    let paragraphs = dom.query_selector_all(element, &Selector::new("p"));
    if paragraphs.len() <= 1 {
        return;
    }
    let first = paragraphs[0];
    for paragraph in &paragraphs[1..] {
        let br = dom.create_element("br");
        dom.append_child(first, br);
        for child in dom.children(*paragraph).to_vec() {
            dom.append_child(first, child);
        }
        dom.detach(*paragraph);
    }
}

fn empty_node(parser: &DomParser, name: &str) -> Result<Node, ParseError> {
    let schema = parser.schema;
    let ty = schema
        .node_type(name)
        .expect("a node type of the memry schema");
    Ok(schema.create(ty, &[], Fragment::default(), Vec::new())?)
}

/// `parser.parse(element, { topNode: schema.nodes[top].create(), preserveWhitespace })`.
fn parse_into(
    dom: &mut Dom,
    parser: &DomParser,
    element: NodeId,
    top: &str,
    preserve_whitespace: Option<bool>,
    preserve_full: bool,
) -> Result<Node, ParseError> {
    let options = ParseOptions {
        top_node: Some(empty_node(parser, top)?),
        preserve_whitespace,
        preserve_full,
    };
    parser.parse(dom, element, &options)
}

/// The default of `getParseRules` for an `inline` block: the element's
/// children as the inline content of a paragraph.
fn inline_content_of(
    dom: &mut Dom,
    parser: &DomParser,
    element: NodeId,
) -> Result<Fragment, ParseError> {
    let clone = dom.clone_deep(element);
    merge_paragraphs(dom, clone);
    Ok(parse_into(dom, parser, clone, "paragraph", Some(true), false)?.content)
}

pub fn inline_content(
    dom: &mut Dom,
    parser: &DomParser,
    id: NodeId,
) -> Result<Fragment, ParseError> {
    inline_content_of(dom, parser, id)
}

/// A block of `content: "none"` has no content to parse, and no `parseContent`.
pub fn no_content(_: &mut Dom, _: &DomParser, _: NodeId) -> Result<Fragment, ParseError> {
    Ok(Fragment::default())
}

/// The heading's `parseContent`: a toggle heading is a `<details>`, any other
/// heading falls through to the inline default.
pub fn heading_content(
    dom: &mut Dom,
    parser: &DomParser,
    id: NodeId,
) -> Result<Fragment, ParseError> {
    if tag_is(dom, id, "DETAILS") {
        return details_content(dom, parser, id);
    }
    inline_content_of(dom, parser, id)
}

/// `getDetailsContent`: the summary as inline content, then everything after
/// it as a `blockGroup` that the parser lifts out as the block's children.
pub fn details_content(
    dom: &mut Dom,
    parser: &DomParser,
    details: NodeId,
) -> Result<Fragment, ParseError> {
    let schema = parser.schema;
    let inline = match dom.query_selector(details, &Selector::new(":scope > summary")) {
        Some(summary) => {
            let clone = dom.clone_deep(summary);
            merge_paragraphs(dom, clone);
            parse_into(dom, parser, clone, "paragraph", Some(true), false)?.content
        }
        None => Fragment::default(),
    };
    let container = dom.create_element("div");
    dom.set_attr(container, "data-node-type", "blockGroup");
    let mut has_children = false;
    for child in dom.children(details).to_vec() {
        if dom.node_name(child) == "SUMMARY" {
            continue;
        }
        // Whitespace-only text from HTML formatting would become empty paragraphs.
        if dom.text_value(child).is_some_and(|t| js_trim(t).is_empty()) {
            continue;
        }
        has_children = true;
        let clone = dom.clone_deep(child);
        dom.append_child(container, clone);
    }
    if !has_children {
        return Ok(inline);
    }
    let block_group = parse_into(dom, parser, container, "blockGroup", None, false)?;
    if schema.fragment_size(&block_group.content) > 0 {
        Ok(schema.add_to_end(&inline, block_group))
    } else {
        Ok(inline)
    }
}

/// `getListItemContent`: the first text block of the item's children becomes
/// its content and the rest nested children.
pub fn list_item_content(
    dom: &mut Dom,
    parser: &DomParser,
    li: NodeId,
) -> Result<Fragment, ParseError> {
    let schema = parser.schema;
    let container = dom.create_element("div");
    dom.set_attr(container, "data-node-type", "blockGroup");
    for child in dom.children(li).to_vec() {
        let clone = dom.clone_deep(child);
        dom.append_child(container, clone);
    }
    let mut block_group = parse_into(dom, parser, container, "blockGroup", None, false)?;

    // A `<input>` in the item can read as a checkListItem: skip that first block.
    let first_content = |group: &Node| {
        group
            .content
            .nodes()
            .first()
            .and_then(|container| container.content.nodes().first())
            .cloned()
    };
    if let Some(inner) = first_content(&block_group)
        && schema.node_ty(inner.ty).name == "checkListItem"
    {
        let cut = schema.cut_fragment_from(&block_group.content, schema.node_size(&inner) + 2);
        block_group = Node {
            content: cut,
            ..block_group
        };
    }

    let Some(first) = first_content(&block_group).filter(|n| schema.is_textblock(n)) else {
        return Ok(Fragment::from_array(vec![block_group]));
    };
    let remaining = schema.cut_fragment_from(&block_group.content, schema.node_size(&first) + 2);
    if schema.fragment_size(&remaining) > 0 {
        let children = Node {
            content: remaining,
            ..block_group
        };
        return Ok(schema.add_to_end(&first.content, children));
    }
    Ok(first.content)
}

/// `parsePreCodeContent`: the `<code>`'s children as the block's text.
/// `preserveWhitespace: "full"` of the TypeScript; `ParseOptions::preserve_full`.
fn pre_code_content(
    dom: &mut Dom,
    parser: &DomParser,
    pre: NodeId,
    block: &str,
) -> Result<Fragment, ParseError> {
    let code = dom
        .first_element_child(pre)
        .ok_or(ParseError::Js("pre without a code element"))?;
    Ok(parse_into(dom, parser, code, block, None, true)?.content)
}

pub fn code_block_content(
    dom: &mut Dom,
    parser: &DomParser,
    id: NodeId,
) -> Result<Fragment, ParseError> {
    pre_code_content(dom, parser, id, "codeBlock")
}

pub fn diagram_content(
    dom: &mut Dom,
    parser: &DomParser,
    id: NodeId,
) -> Result<Fragment, ParseError> {
    pre_code_content(dom, parser, id, "diagram")
}

/// `parseTableContent`: a cell's content as one run of inline nodes, however
/// many blocks it holds.
pub fn table_cell_content(
    dom: &mut Dom,
    parser: &DomParser,
    id: NodeId,
) -> Result<Fragment, ParseError> {
    let schema = parser.schema;
    let parsed = parse_into(dom, parser, id, "blockGroup", None, false)?;
    fn collect(schema: &crate::markdown::pm::Schema, fragment: &Fragment, out: &mut Vec<Node>) {
        for child in fragment.nodes() {
            if schema.node_ty(child.ty).is_inline {
                out.push(child.clone());
            } else {
                collect(schema, &child.content, out);
            }
        }
    }
    let mut extracted = Vec::new();
    collect(schema, &parsed.content, &mut extracted);
    Ok(Fragment::from_array(extracted))
}
