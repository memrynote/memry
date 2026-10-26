//! `blocksToMarkdownPreserving` (`blocknote-converter.ts:1371`) and the walks
//! it owns: toggles, structured quotes, callouts with children, columns,
//! task blocks, nesting markers and blank-line gaps. This, not
//! [`super::serialize::serialize_blocks`], is the vault write path for a block
//! list; the latter serializes one flat run of blocks.

use serde_json::{Value as Json, json};

use super::ConvertError;
use super::serialize::serialize_blocks;
use crate::markdown::frontmatter::js::js_trim;
use crate::markdown::schema::blocks::callout::serialize_callout_block;
use crate::markdown::schema::blocks::file::{FileBlockProps, serialize_file_block};
use crate::markdown::schema::blocks::math::serialize_math_block;
use crate::markdown::schema::blocks::toggle::serialize_toggle_block;
use crate::markdown::schema::columns::serialize_column_list_block;
use crate::markdown::schema::quote::serialize_quote_block;
use crate::markdown::shared::block_colors::{
    has_non_default_colors, serialize_block_colors_marker,
};
use crate::markdown::shared::block_copy::clone_without;
use crate::markdown::shared::block_markers::sidecar_marker_lines;
use crate::markdown::shared::block_nesting::create_block_nesting_marker;
use crate::markdown::shared::empty_lines::{MarkdownSegment, assemble_markdown_with_blanks};
use crate::markdown::shared::task_block::serialize_task_block_tree;

const PORTAL_BLOCK_LANGUAGE: &str = "memry-portal";

fn fail(what: impl Into<String>) -> ConvertError {
    ConvertError::Serialize(what.into())
}

fn type_of(block: &Json) -> &str {
    block.get("type").and_then(Json::as_str).unwrap_or("")
}

fn children_of(block: &Json) -> &[Json] {
    block
        .get("children")
        .and_then(Json::as_array)
        .map_or(&[], Vec::as_slice)
}

fn props_of(block: &Json) -> &Json {
    block.get("props").unwrap_or(&Json::Null)
}

fn is_empty_paragraph(block: &Json) -> bool {
    if type_of(block) != "paragraph" || !children_of(block).is_empty() {
        return false;
    }
    match block.get("content") {
        None | Some(Json::Null) => true,
        Some(Json::Array(items)) => items.is_empty(),
        Some(_) => false,
    }
}

/// A whiteboard pointing at no canvas, which the vault gets no line for.
fn is_empty_whiteboard(block: &Json) -> bool {
    if type_of(block) != "whiteboard" || !children_of(block).is_empty() {
        return false;
    }
    match props_of(block).get("canvasId") {
        None | Some(Json::Null) => true,
        Some(Json::String(s)) => s.is_empty(),
        Some(_) => false,
    }
}

fn is_list_type(ty: &str) -> bool {
    matches!(ty, "bulletListItem" | "numberedListItem" | "checkListItem")
}

fn has_marker_serialized_children(block: &Json) -> bool {
    let parent = type_of(block);
    children_of(block).iter().any(|child| {
        !(is_list_type(parent) && is_list_type(type_of(child)))
            || has_marker_serialized_children(child)
    })
}

fn file_props(props: &Json) -> FileBlockProps {
    let text = |key: &str| {
        props
            .get(key)
            .and_then(Json::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let number = |key: &str| props.get(key).and_then(Json::as_f64);
    FileBlockProps {
        url: text("url"),
        name: text("name"),
        size: number("size").unwrap_or(0.0),
        mime_type: text("mimeType"),
        width: number("width"),
        height: number("height"),
        align: props.get("align").and_then(Json::as_str).map(str::to_owned),
        display: props
            .get("display")
            .and_then(Json::as_str)
            .map(str::to_owned),
    }
}

fn latex_of(block: &Json) -> &str {
    props_of(block)
        .get("latex")
        .and_then(Json::as_str)
        .unwrap_or("")
}

fn serialized_trimmed(blocks: &[Json]) -> Result<String, ConvertError> {
    Ok(js_trim(&serialize_blocks(blocks)?).to_owned())
}

/// A copy of `block` as a bare paragraph: same content, `props`, no children.
fn as_paragraph(block: &Json, props: Json) -> Json {
    let mut copy = clone_without(block, &["children", "props"]);
    if let Some(map) = copy.as_object_mut() {
        map.insert("type".into(), json!("paragraph"));
        map.insert("props".into(), props);
        map.insert("children".into(), json!([]));
    }
    copy
}

/// `serializeBlocksWithNestingMarkers`.
fn serialize_with_nesting_markers(blocks: &[Json]) -> Result<String, ConvertError> {
    fn append(
        block: &Json,
        level: usize,
        current: &mut usize,
        parts: &mut Vec<String>,
    ) -> Result<(), ConvertError> {
        if level != *current {
            parts.push(create_block_nesting_marker(level as f64));
            *current = level;
        }
        let markdown = match type_of(block) {
            "file" => serialize_file_block(&file_props(props_of(block))),
            "mathBlock" => serialize_math_block(latex_of(block)),
            _ => {
                let mut shallow = clone_without(block, &["children"]);
                if let Some(map) = shallow.as_object_mut() {
                    map.insert("children".into(), json!([]));
                }
                serialized_trimmed(&[shallow])?
            }
        };
        if !markdown.is_empty() {
            parts.push(markdown);
        }
        for child in children_of(block) {
            append(child, level + 1, current, parts)?;
        }
        Ok(())
    }
    let mut parts = Vec::new();
    let mut current = 0;
    for block in blocks {
        append(block, 0, &mut current, &mut parts)?;
    }
    if current != 0 {
        parts.push(create_block_nesting_marker(0.0));
    }
    Ok(parts.join("\n\n"))
}

/// `serializeToggle`: children go inside the `<details>`.
fn serialize_toggle(block: &Json) -> Result<String, ConvertError> {
    let props = props_of(block);
    let open = props.get("open") == Some(&Json::Bool(true));
    let mut summary_props = props.as_object().cloned().unwrap_or_default();
    summary_props.shift_remove("open");
    let summary = serialized_trimmed(&[as_paragraph(block, Json::Object(summary_props))])?;
    let children = children_of(block);
    let body = if children.is_empty() {
        String::new()
    } else {
        blocks_to_markdown_preserving(children)?
    };
    let colors = has_non_default_colors(props).then(|| serialize_block_colors_marker(props));
    Ok(serialize_toggle_block(
        &summary,
        &body,
        colors.as_deref(),
        open,
    ))
}

/// `serializeQuote`: children inside the blockquote.
fn serialize_quote(block: &Json) -> Result<String, ConvertError> {
    let mut run = vec![as_paragraph(block, json!({}))];
    run.extend(children_of(block).iter().cloned());
    let inner = blocks_to_markdown_preserving(&run)?;
    Ok(serialize_quote_block(js_trim(&inner)))
}

/// `serializeCalloutWithChildren`.
fn serialize_callout_with_children(block: &Json) -> Result<String, ConvertError> {
    let mut run = vec![as_paragraph(block, json!({}))];
    run.extend(children_of(block).iter().cloned());
    let inner = blocks_to_markdown_preserving(&run)?;
    let props = props_of(block);
    let callout_type = match props.get("type") {
        Some(Json::String(s)) => s.clone(),
        _ => "undefined".to_owned(),
    };
    Ok(serialize_callout_block(
        &callout_type,
        js_trim(&inner),
        props.get("fold").and_then(Json::as_str),
    ))
}

fn with_markers(markers: &[String], text: String) -> String {
    if markers.is_empty() {
        text
    } else {
        format!("{}\n{text}", markers.join("\n"))
    }
}

/// `blocksToMarkdownPreserving`.
pub fn blocks_to_markdown_preserving(blocks: &[Json]) -> Result<String, ConvertError> {
    let mut segments: Vec<MarkdownSegment> = Vec::new();
    let mut group: Vec<Json> = Vec::new();
    let mut empty_count: u64 = 0;

    fn flush_group(
        group: &mut Vec<Json>,
        segments: &mut Vec<MarkdownSegment>,
    ) -> Result<(), ConvertError> {
        if group.is_empty() {
            return Ok(());
        }
        let md = serialize_blocks(group)?;
        segments.push(MarkdownSegment::Content {
            text: js_trim(&md).to_owned(),
        });
        group.clear();
        Ok(())
    }
    fn flush_gap(empty_count: &mut u64, segments: &mut Vec<MarkdownSegment>) {
        if *empty_count > 0 {
            segments.push(MarkdownSegment::Gap {
                extra_lines: *empty_count,
            });
            *empty_count = 0;
        }
    }

    for block in blocks {
        if is_empty_whiteboard(block) {
            continue;
        }
        let markers = sidecar_marker_lines(block)
            .map_err(|_| fail("a table row has cells that are not an array"))?;
        let ty = type_of(block);
        let content = |text: String| MarkdownSegment::Content { text };

        if ty == "taskBlock" {
            flush_group(&mut group, &mut segments)?;
            flush_gap(&mut empty_count, &mut segments);
            let lines =
                serialize_task_block_tree(block).ok_or_else(|| fail("task block has no props"))?;
            segments.push(content(lines.join("\n")));
        } else if ty == "file" {
            flush_group(&mut group, &mut segments)?;
            flush_gap(&mut empty_count, &mut segments);
            segments.push(content(serialize_file_block(&file_props(props_of(block)))));
        } else if ty == "mathBlock" {
            flush_group(&mut group, &mut segments)?;
            flush_gap(&mut empty_count, &mut segments);
            let math = serialize_math_block(latex_of(block));
            segments.push(content(with_markers(&markers, math)));
        } else if ty == "toggleListItem" {
            flush_group(&mut group, &mut segments)?;
            flush_gap(&mut empty_count, &mut segments);
            segments.push(content(serialize_toggle(block)?));
        } else if ty == "columnList" {
            flush_group(&mut group, &mut segments)?;
            flush_gap(&mut empty_count, &mut segments);
            let text = serialize_column_list_block(block, &mut |children| {
                blocks_to_markdown_preserving(children).map_err(|e| e.to_string())
            })
            .map_err(fail)?;
            segments.push(content(text));
        } else if (ty == "quote" || ty == "callout") && !children_of(block).is_empty() {
            flush_group(&mut group, &mut segments)?;
            flush_gap(&mut empty_count, &mut segments);
            let quoted = if ty == "quote" {
                serialize_quote(block)?
            } else {
                serialize_callout_with_children(block)?
            };
            segments.push(content(with_markers(&markers, quoted)));
        } else if is_empty_paragraph(block) {
            flush_group(&mut group, &mut segments)?;
            empty_count += 1;
        } else if !markers.is_empty() {
            flush_group(&mut group, &mut segments)?;
            flush_gap(&mut empty_count, &mut segments);
            let md = serialize_blocks(std::slice::from_ref(block))?;
            segments.push(content(format!("{}\n{}", markers.join("\n"), js_trim(&md))));
        } else if has_marker_serialized_children(block) {
            flush_group(&mut group, &mut segments)?;
            flush_gap(&mut empty_count, &mut segments);
            segments.push(content(serialize_with_nesting_markers(
                std::slice::from_ref(block),
            )?));
        } else {
            flush_gap(&mut empty_count, &mut segments);
            group.push(block.clone());
        }
    }

    flush_group(&mut group, &mut segments)?;
    // The host editor keeps an empty paragraph after a trailing portal so the
    // caret has somewhere to go. It is not content.
    let last = blocks.iter().rfind(|b| !is_empty_paragraph(b));
    let ends_in_portal = last.is_some_and(|b| {
        type_of(b) == "codeBlock"
            && props_of(b).get("language").and_then(Json::as_str) == Some(PORTAL_BLOCK_LANGUAGE)
    });
    if empty_count > 0 && !ends_in_portal {
        flush_gap(&mut empty_count, &mut segments);
    }
    Ok(assemble_markdown_with_blanks(&segments))
}
