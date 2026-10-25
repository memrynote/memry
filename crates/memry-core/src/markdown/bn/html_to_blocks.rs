//! BlockNote `HTMLToBlocks` and `markdownToBlocks` (`parsers/html/parseHTML.ts`,
//! `parsers/markdown/parseMarkdown.ts`): the BlockNote parse path without the
//! memry layers.

use serde_json::Value as Json;

use super::dom::parse_fragment_in_div;
use super::dom_parser::{DomParser, ParseError, ParseOptions};
use super::html_tree::{nested_lists_to_blocknote_structure, preprocess_html_whitespace};
use super::md_to_html::markdown_to_html;
use super::node_to_block::{canonical_blocks, node_to_block};
use crate::markdown::pm::Fragment;

/// `EMPTY_BLOCK_PLACEHOLDER`: the exporter's guard against empty blocks being
/// dropped, stripped again on the way back.
const EMPTY_BLOCK_PLACEHOLDER: char = '\u{FFFC}';

fn strip_placeholder(content: &[Json]) -> Vec<Json> {
    let mut out = Vec::new();
    for item in content {
        if item["type"] == "text" {
            let text: String = item["text"]
                .as_str()
                .unwrap_or("")
                .chars()
                .filter(|c| *c != EMPTY_BLOCK_PLACEHOLDER)
                .collect();
            if !text.is_empty() {
                let mut kept = item.clone();
                kept["text"] = Json::String(text);
                out.push(kept);
            }
        } else if let Some(inner) = item["content"].as_array() {
            let mut kept = item.clone();
            kept["content"] = Json::Array(strip_placeholder(inner));
            out.push(kept);
        } else {
            out.push(item.clone());
        }
    }
    out
}

fn strip_blocks(blocks: &mut [Json]) {
    for block in blocks {
        if let Some(content) = block["content"].as_array() {
            block["content"] = Json::Array(strip_placeholder(content));
        }
        if let Some(children) = block["children"].as_array_mut() {
            strip_blocks(children);
        }
    }
}

/// `HTMLToBlocks(html, schema)`: canonical block JSON.
pub fn html_to_blocks(html: &str) -> Result<Json, ParseError> {
    let parser = DomParser::memry();
    let schema = parser.schema;
    let (mut dom, root) = parse_fragment_in_div(html);
    nested_lists_to_blocknote_structure(&mut dom, root)?;
    preprocess_html_whitespace(&mut dom, root);
    let top = schema.create(
        schema
            .node_type("blockGroup")
            .ok_or(ParseError::Js("no blockGroup"))?,
        &[],
        Fragment::default(),
        Vec::new(),
    )?;
    let parent = parser.parse(
        &mut dom,
        root,
        &ParseOptions {
            top_node: Some(top),
            preserve_whitespace: None,
            preserve_full: false,
        },
    )?;
    let mut blocks = Vec::new();
    for child in parent.children() {
        blocks.push(node_to_block(schema, child)?);
    }
    strip_blocks(&mut blocks);
    Ok(canonical_blocks(&blocks))
}

/// `markdownToBlocks(markdown, schema)`: BlockNote's own markdown parse.
pub fn markdown_to_blocks(markdown: &str) -> Result<Json, ParseError> {
    html_to_blocks(&markdown_to_html(markdown))
}
