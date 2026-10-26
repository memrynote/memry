//! BlockNote `nodeToBlock` (`api/nodeConversions/nodeToBlock.ts`) from a
//! ProseMirror node to a block as JSON, for the memry schema.
//!
//! Blocks are built as [`Json`] and canonicalised by [`canonical_blocks`]:
//! `id` dropped, object keys sorted, `null` object entries omitted. Block
//! ids are never part of a comparison (they are random in the TypeScript).

use serde_json::{Map, Value as Json, json};

use super::dom_parser::ParseError;
use crate::markdown::pm::model::any_to_json;
use crate::markdown::pm::{Mark, Node, Schema};

const INLINE_CONTENT_TYPES: &[&str] = &[
    "inlineImage",
    "inlineCheckbox",
    "wikiLink",
    "linkMention",
    "hashTag",
    "dateMention",
    "htmlComment",
];

/// The style a mark writes, as BlockNote's `styleSchema` declares it.
fn style_of(schema: &Schema, mark: &Mark) -> Result<Option<(String, Json)>, ParseError> {
    let name = schema.mark_ty(mark.ty).name;
    match name {
        "bold" | "italic" | "underline" | "strike" | "code" => {
            Ok(Some((name.to_owned(), Json::Bool(true))))
        }
        "textColor" | "backgroundColor" => {
            let value = mark
                .attrs
                .iter()
                .find(|(k, _)| k == "stringValue")
                .and_then(|(_, v)| any_to_json(v))
                .unwrap_or(Json::Null);
            Ok(Some((name.to_owned(), value)))
        }
        "link" => Ok(None),
        _ => Err(ParseError::Js("style not found in styleSchema")),
    }
}

fn attr_json(node: &Node, name: &str) -> Json {
    node.attrs
        .iter()
        .find(|(k, _)| k == name)
        .and_then(|(_, v)| any_to_json(v))
        .unwrap_or(Json::Null)
}

type Styles = Vec<(String, Json)>;

fn styles_json(styles: &Styles) -> Json {
    Json::Object(styles.iter().cloned().collect())
}

fn text_item(text: &str, styles: &Styles) -> Json {
    json!({"type": "text", "text": text, "styles": styles_json(styles)})
}

fn link_item(href: Json, text: &str, styles: &Styles) -> Json {
    json!({"type": "link", "href": href, "content": [text_item(text, styles)]})
}

fn append_text(item: &mut Json, extra: &str, in_link: bool) {
    let target = if in_link {
        item.get_mut("content")
            .and_then(Json::as_array_mut)
            .and_then(|c| c.last_mut())
    } else {
        Some(item)
    };
    if let Some(Json::Object(map)) = target
        && let Some(Json::String(text)) = map.get_mut("text")
    {
        text.push_str(extra);
    }
}

fn is_text_item(item: &Json) -> bool {
    item.get("type") == Some(&json!("text"))
}

fn is_link_item(item: &Json) -> bool {
    item.get("type") == Some(&json!("link"))
}

fn last_styles(item: &Json) -> Json {
    if is_link_item(item) {
        item["content"]
            .as_array()
            .and_then(|c| c.last())
            .map_or(Json::Null, |last| last["styles"].clone())
    } else {
        item["styles"].clone()
    }
}

/// `contentNodeToInlineContent`.
pub fn inline_content(schema: &Schema, content_node: &Node) -> Result<Vec<Json>, ParseError> {
    let mut content: Vec<Json> = Vec::new();
    let mut current: Option<Json> = None;
    for node in content_node.children() {
        let name = schema.node_ty(node.ty).name;
        if name == "hardBreak" {
            match &mut current {
                Some(item) => append_text(item, "\n", is_link_item(item)),
                None => current = Some(text_item("\n", &Vec::new())),
            }
            continue;
        }
        if name != "link" && name != "text" {
            if !INLINE_CONTENT_TYPES.contains(&name) {
                continue;
            }
            if let Some(item) = current.take() {
                content.push(item);
            }
            let props: Map<String, Json> = node
                .attrs
                .iter()
                .filter_map(|(k, v)| any_to_json(v).map(|j| (k.clone(), j)))
                .collect();
            content.push(json!({"type": name, "props": props}));
            continue;
        }
        let mut styles: Styles = Vec::new();
        let mut link: Option<Json> = None;
        for mark in &node.marks {
            if schema.mark_ty(mark.ty).name == "link" {
                link = Some(
                    mark.attrs
                        .iter()
                        .find(|(k, _)| k == "href")
                        .and_then(|(_, v)| any_to_json(v))
                        .unwrap_or(Json::Null),
                );
            } else if let Some(style) = style_of(schema, mark)? {
                styles.push(style);
            }
        }
        let text = node.text_content();
        current = Some(match current.take() {
            None => match link {
                None => text_item(&text, &styles),
                Some(href) => link_item(href, &text, &styles),
            },
            Some(mut item) if is_text_item(&item) => match link {
                None if item["styles"] == styles_json(&styles) => {
                    append_text(&mut item, &text, false);
                    item
                }
                None => {
                    content.push(item);
                    text_item(&text, &styles)
                }
                Some(href) => {
                    content.push(item);
                    link_item(href, &text, &styles)
                }
            },
            Some(mut item) => match link {
                Some(href) if item["href"] == href => {
                    if last_styles(&item) == styles_json(&styles) {
                        append_text(&mut item, &text, true);
                    } else if let Some(c) = item["content"].as_array_mut() {
                        c.push(text_item(&text, &styles));
                    }
                    item
                }
                Some(href) => {
                    content.push(item);
                    link_item(href, &text, &styles)
                }
                None => {
                    content.push(item);
                    text_item(&text, &styles)
                }
            },
        });
    }
    if let Some(item) = current {
        content.push(item);
    }
    Ok(content)
}

/// `contentNodeToTableContent`.
fn table_content(schema: &Schema, content_node: &Node) -> Result<Json, ParseError> {
    let mut column_widths: Vec<Json> = Vec::new();
    let mut rows: Vec<Json> = Vec::new();
    // `headerMatrix[rowIndex]` is a hole for a row without cells.
    let mut header_matrix: Vec<Option<Vec<bool>>> = Vec::new();
    for (row_index, row) in content_node.children().iter().enumerate() {
        if row_index == 0 {
            for cell in row.children() {
                match attr_json(cell, "colwidth") {
                    Json::Array(widths) => column_widths.extend(widths),
                    _ => {
                        let span = attr_json(cell, "colspan").as_f64().unwrap_or(1.0);
                        // `Array(span)` throws a RangeError on a negative or fractional length.
                        if span < 0.0 || span.fract() != 0.0 {
                            return Err(ParseError::Js("invalid array length"));
                        }
                        if span > crate::markdown::limits::MAX_TABLE_SPAN as f64 {
                            return Err(ParseError::Js("table cell span is too large"));
                        }
                        column_widths.extend((0..span.max(0.0) as usize).map(|_| Json::Null));
                    }
                }
            }
        }
        let mut cells = Vec::new();
        let mut headers: Vec<bool> = Vec::new();
        for cell in row.children() {
            headers.push(schema.node_ty(cell.ty).name == "tableHeader");
            let mut merged: Vec<Json> = Vec::new();
            for child in cell.children() {
                let part = inline_content(schema, child)?;
                if merged.is_empty() {
                    merged = part;
                    continue;
                }
                let mut part = part.into_iter();
                match part.next() {
                    Some(first)
                        if is_text_item(&first)
                            && merged.last().is_some_and(is_text_item)
                            && merged.last().map(|l| l["styles"].clone())
                                == Some(first["styles"].clone()) =>
                    {
                        let extra = format!("\n{}", first["text"].as_str().unwrap_or(""));
                        if let Some(last) = merged.last_mut() {
                            append_text(last, &extra, false);
                        }
                        merged.extend(part);
                    }
                    Some(first) => {
                        merged.push(first);
                        merged.extend(part);
                    }
                    None => {}
                }
            }
            let props: Map<String, Json> = [
                "colspan",
                "rowspan",
                "backgroundColor",
                "textColor",
                "textAlignment",
            ]
            .iter()
            .map(|k| ((*k).to_owned(), attr_json(cell, k)))
            .collect();
            cells.push(json!({"type": "tableCell", "content": merged, "props": props}));
        }
        if row.children().is_empty() {
            header_matrix.push(None);
        } else {
            header_matrix.push(Some(headers));
        }
        rows.push(json!({"cells": cells}));
    }
    let mut out = Map::new();
    out.insert("type".into(), json!("tableContent"));
    out.insert("columnWidths".into(), Json::Array(column_widths));
    let header_rows = header_matrix
        .iter()
        .filter(|r| r.as_ref().is_some_and(|r| r.iter().all(|h| *h)))
        .count();
    if header_rows > 0 {
        out.insert("headerRows".into(), json!(header_rows));
    }
    let first_len = header_matrix
        .first()
        .and_then(|r| r.as_ref())
        .map_or(0, Vec::len);
    let header_cols = (0..first_len)
        .filter(|i| {
            header_matrix
                .iter()
                .flatten()
                .all(|row| row.get(*i).copied().unwrap_or(false))
        })
        .count();
    if header_cols > 0 {
        out.insert("headerCols".into(), json!(header_cols));
    }
    out.insert("rows".into(), Json::Array(rows));
    Ok(Json::Object(out))
}

/// How the node's block holds its content (`blockConfig.content`).
fn content_kind(schema: &Schema, content_node: &Node) -> &'static str {
    match schema.node_ty(content_node.ty).spec.content {
        "inline*" => "inline",
        "text*" => "plain",
        "tableRow+" => "table",
        _ => "none",
    }
}

/// `nodeToBlock(node, doc)`: `node` is a `bnBlock` (a `blockContainer`, `column` or `columnList`).
pub fn node_to_block(schema: &Schema, node: &Node) -> Result<Json, ParseError> {
    let ty = schema.node_ty(node.ty);
    if !ty.is_in_group("bnBlock") {
        return Err(ParseError::Js("node should be a bnBlock"));
    }
    let (content_node, child_container, attrs): (Option<&Node>, Option<&Node>, Vec<&Node>) =
        if ty.name == "blockContainer" {
            let mut content = None;
            let mut group = None;
            for child in node.children() {
                let child_ty = schema.node_ty(child.ty);
                if child_ty.spec.group == "blockContent" {
                    content = Some(child);
                } else if child_ty.name == "blockGroup" {
                    group = Some(child);
                }
            }
            let content = content.ok_or(ParseError::Js("blockContainer without blockContent"))?;
            (Some(content), group, vec![node, content])
        } else {
            if !ty.is_in_group("childContainer") {
                return Err(ParseError::Js("bnBlock is not a childContainer"));
            }
            (None, Some(node), vec![node])
        };
    let block_type = schema.node_ty(content_node.map_or(node.ty, |c| c.ty)).name;
    let mut props = Map::new();
    for source in attrs {
        for (name, value) in &source.attrs {
            if name == "id" {
                continue;
            }
            if let Some(json) = prop_json(value) {
                props.insert(name.clone(), json);
            }
        }
    }
    let mut children = Vec::new();
    if let Some(container) = child_container {
        for child in container.children() {
            children.push(node_to_block(schema, child)?);
        }
    }
    let content = match content_node {
        None => Json::Null,
        Some(c) => match content_kind(schema, c) {
            "inline" => Json::Array(inline_content(schema, c)?),
            "table" => table_content(schema, c)?,
            "plain" => {
                let text = c.text_content();
                if text.is_empty() {
                    json!([])
                } else {
                    json!([{"type": "text", "text": text, "styles": {}}])
                }
            }
            _ => Json::Null,
        },
    };
    Ok(json!({"type": block_type, "props": props, "content": content, "children": children}))
}

/// A prop value. `NaN` is not dropped like `null` (the TypeScript drops `null`
/// before `JSON.stringify` turns `NaN` into `null`), so it travels as a marker
/// that [`canon`] turns into `null` last.
const NAN_MARKER: &str = "\u{0}NaN";

fn prop_json(value: &yrs::Any) -> Option<Json> {
    match value {
        yrs::Any::Number(n) if n.is_nan() => Some(Json::String(NAN_MARKER.into())),
        other => any_to_json(other),
    }
}

fn canon(value: &Json) -> Json {
    match canon_inner(value) {
        Json::String(s) if s == NAN_MARKER => Json::Null,
        other => other,
    }
}

fn canon_inner(value: &Json) -> Json {
    match value {
        Json::Array(items) => Json::Array(items.iter().map(canon).collect()),
        Json::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if !map[key].is_null() {
                    out.insert(key.clone(), canon(&map[key]));
                }
            }
            Json::Object(out)
        }
        other => other.clone(),
    }
}

/// The vectors' block JSON: `{type, props, content, children}` per block, ids dropped.
pub fn canonical_blocks(blocks: &[Json]) -> Json {
    Json::Array(
        blocks
            .iter()
            .map(|b| {
                json!({
                    "type": b["type"],
                    "props": canon(&b["props"]),
                    "content": canon(&b["content"]),
                    "children": canonical_blocks(b["children"].as_array().map_or(&[], Vec::as_slice)),
                })
            })
            .collect(),
    )
}
