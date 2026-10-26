//! `markdown-convert/layer-markers.json`: block-markers, block-colors,
//! inline-colors, task-block, plain-checkbox, obsidian-tasks and
//! link-card-marker, function by function against the TypeScript.

#![cfg(feature = "markdown")]

mod support;

use std::collections::BTreeMap;

use memry_core::markdown::bn::html_to_blocks::markdown_to_blocks;
use memry_core::markdown::shared::block_colors::{
    apply_table_cell_colors, extract_table_cell_colors, has_non_default_colors,
    is_block_colors_line, is_table_cell_colors_line, parse_block_colors_marker,
    parse_table_cell_colors_marker, serialize_block_colors_marker,
    serialize_table_cell_colors_marker,
};
use memry_core::markdown::shared::block_markers::{
    TableLayout, apply_table_cell_alignments, apply_table_layout, extract_table_cell_alignments,
    extract_table_layout, is_block_align_line, is_table_align_line, is_table_layout_line,
    parse_block_align_marker, parse_sidecar_marker_line, parse_table_cell_alignments_marker,
    parse_table_layout_marker, serialize_block_align_marker,
    serialize_table_cell_alignments_marker, serialize_table_layout_marker, sidecar_marker_lines,
};
use memry_core::markdown::shared::inline_colors::{
    MaskedColorSpan, apply_inline_color_tokens, extract_inline_color_runs, mask_inline_color_spans,
    restore_inline_color_tokens, strip_inline_style_span_tags,
};
use memry_core::markdown::shared::link_card_marker::{
    LinkCardDisplay, WikiLinkSize, apply_link_card, is_link_card_line, parse_link_card_marker,
    serialize_link_card_marker,
};
use memry_core::markdown::shared::obsidian_tasks::{
    has_obsidian_task_fields, obsidian_task_import_blocker, parse_obsidian_task_fields,
    parse_obsidian_task_line,
};
use memry_core::markdown::shared::plain_checkbox::{
    has_plain_checkbox_marker, normalize_plain_checkboxes, with_plain_checkbox_markers,
};
use memry_core::markdown::shared::task_block::{
    cap_task_tree_depth, extract_inline_text, normalize_task_blocks, parse_task_block_suffix,
    scan_task_checkbox_states, serialize_task_block, serialize_task_block_tree,
    strip_task_block_suffixes,
};
use serde_json::{Value as Json, json};
use support::vector_compare::{Failures, json_equal};
use support::vector_file;

/// The result of one function: a JSON value, or `Err` where the TypeScript throws.
type Outcome = Result<Json, String>;

fn string(args: &[Json], at: usize) -> Result<&str, String> {
    args.get(at)
        .and_then(Json::as_str)
        .ok_or_else(|| format!("argument {at} is not a string"))
}

fn value(args: &[Json], at: usize) -> Json {
    args.get(at).cloned().unwrap_or(Json::Null)
}

fn list(args: &[Json], at: usize) -> Vec<Json> {
    args.get(at)
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default()
}

fn opt<T: Into<Json>>(value: Option<T>) -> Json {
    value.map_or(Json::Null, Into::into)
}

fn blocks_json(blocks: Vec<Json>) -> Json {
    Json::Array(blocks)
}

fn changed(blocks: Vec<Json>, did_change: bool) -> Json {
    json!({"blocks": blocks, "didChange": did_change})
}

fn layout_of(layout: &Json) -> TableLayout {
    TableLayout {
        column_widths: layout["columnWidths"]
            .as_array()
            .cloned()
            .unwrap_or_default(),
    }
}

fn layout_json(layout: &TableLayout) -> Json {
    json!({"columnWidths": layout.column_widths})
}

fn display_of(display: &Json) -> LinkCardDisplay {
    LinkCardDisplay {
        size: display["size"].as_str().map(|size| match size {
            "small" => WikiLinkSize::Small,
            "medium" => WikiLinkSize::Medium,
            _ => WikiLinkSize::None,
        }),
        cover: display["cover"].as_bool(),
        preview: display["preview"].as_bool(),
    }
}

fn spans_of(spans: &Json) -> Vec<MaskedColorSpan> {
    spans
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(MaskedColorSpan::from_json)
        .collect()
}

/// A `Map`'s `[key, value]` pairs, last value winning and the first position kept.
fn map_pairs(pairs: &[Json]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for pair in pairs {
        let (Some(key), Some(text)) = (pair[0].as_str(), pair[1].as_str()) else {
            continue;
        };
        match out.iter_mut().find(|(existing, _)| existing == key) {
            Some(entry) => entry.1 = text.to_owned(),
            None => out.push((key.to_owned(), text.to_owned())),
        }
    }
    out
}

fn pairs_json(pairs: &[(String, String)]) -> Json {
    Json::Array(pairs.iter().map(|(k, v)| json!([k, v])).collect())
}

fn masked_json(text: &str, spans: &[MaskedColorSpan]) -> Json {
    json!({"text": text, "spans": spans.iter().map(MaskedColorSpan::to_json).collect::<Vec<_>>()})
}

fn parse_markdown(markdown: &str) -> Result<Vec<Json>, String> {
    match markdown_to_blocks(markdown) {
        Ok(Json::Array(blocks)) => Ok(blocks),
        Ok(other) => Err(format!("not a block list: {other}")),
        Err(e) => Err(e.to_string()),
    }
}

/// `everyBlock`: pre-order, a `false` from `visit` skips the children.
fn every_block(blocks: &[Json], visit: &mut dyn FnMut(&Json) -> bool) {
    for block in blocks {
        if visit(block)
            && let Some(children) = block["children"].as_array()
        {
            every_block(children, visit);
        }
    }
}

fn from_markdown(name: &str, markdown: &str) -> Option<Outcome> {
    Some(match name {
        "taskBlock.normalizeFromMarkdown" | "taskBlock.normalizeFromMarkdownNoSource" => {
            let source = (name == "taskBlock.normalizeFromMarkdown").then_some(markdown);
            parse_markdown(markdown).map(|blocks| {
                let (blocks, did_change) = normalize_task_blocks(&blocks, source);
                changed(blocks, did_change)
            })
        }
        "taskBlock.serializeTreesFromMarkdown" => (|| {
            let (blocks, _) = normalize_task_blocks(&parse_markdown(markdown)?, Some(markdown));
            let mut trees: Vec<Json> = Vec::new();
            let mut failed = false;
            every_block(&blocks, &mut |block| {
                if block["type"] != "taskBlock" {
                    return true;
                }
                match serialize_task_block_tree(block) {
                    Some(lines) => trees.push(json!(lines)),
                    None => failed = true,
                }
                false
            });
            if failed {
                return Err("serializeTaskBlockTree threw".to_owned());
            }
            Ok(Json::Array(trees))
        })(),
        "plainCheckbox.pipelineFromMarkdown" => parse_markdown(markdown).map(|blocks| {
            let (mut plain, did_change) = normalize_task_blocks(&blocks, Some(markdown));
            let did_change_plain = normalize_plain_checkboxes(&mut plain);
            let _ = did_change;
            let mut with_markers = plain.clone();
            with_plain_checkbox_markers(&mut with_markers);
            json!({
                "plain": changed(plain, did_change_plain),
                "withMarkers": blocks_json(with_markers),
            })
        }),
        "inlineColors.pipelineFromMarkdown" => (|| {
            let masked = mask_inline_color_spans(markdown);
            let parsed = parse_markdown(&masked.text)?;
            let blocks = apply_inline_color_tokens(&parsed, &masked.spans);
            let (wrapped, replacements) = extract_inline_color_runs(&blocks);
            Ok(json!({
                "masked": masked_json(&masked.text, &masked.spans),
                "blocks": blocks,
                "wrapped": wrapped,
                "replacements": pairs_json(&replacements),
            }))
        })(),
        "blockMarkers.linesFromMarkdown" => (|| {
            let blocks = parse_markdown(markdown)?;
            let mut lines: Vec<Json> = Vec::new();
            let mut failed = false;
            every_block(&blocks, &mut |block| {
                match sidecar_marker_lines(block) {
                    Ok(own) if !own.is_empty() => lines.push(json!(own)),
                    Ok(_) => {}
                    Err(_) => failed = true,
                }
                true
            });
            if failed {
                return Err("sidecarMarkerLines threw".to_owned());
            }
            Ok(Json::Array(lines))
        })(),
        _ => return None,
    })
}

fn dispatch(name: &str, args: &[Json]) -> Option<Outcome> {
    if let Some(markdown) = args.first().and_then(Json::as_str)
        && let Some(outcome) = from_markdown(name, markdown)
    {
        return Some(outcome);
    }
    let text = |at: usize| string(args, at);
    Some(match name {
        "blockColors.isBlockColorsLine" => text(0).map(|l| json!(is_block_colors_line(l))),
        "blockColors.isTableCellColorsLine" => text(0).map(|l| json!(is_table_cell_colors_line(l))),
        "blockColors.hasNonDefaultColors" => Ok(json!(has_non_default_colors(&value(args, 0)))),
        "blockColors.serializeBlockColorsMarker" => {
            Ok(json!(serialize_block_colors_marker(&value(args, 0))))
        }
        "blockColors.parseBlockColorsMarker" => text(0).map(|l| opt(parse_block_colors_marker(l))),
        "blockColors.extractTableCellColors" => Ok(opt(extract_table_cell_colors(&value(args, 0)))),
        "blockColors.serializeTableCellColorsMarker" => {
            Ok(json!(serialize_table_cell_colors_marker(&value(args, 0))))
        }
        "blockColors.parseTableCellColorsMarker" => {
            text(0).map(|l| opt(parse_table_cell_colors_marker(l)))
        }
        "blockColors.applyTableCellColors" => {
            let mut content = value(args, 0);
            apply_table_cell_colors(&mut content, &value(args, 1));
            Ok(content)
        }

        "blockMarkers.isBlockAlignLine" => text(0).map(|l| json!(is_block_align_line(l))),
        "blockMarkers.isTableAlignLine" => text(0).map(|l| json!(is_table_align_line(l))),
        "blockMarkers.isTableLayoutLine" => text(0).map(|l| json!(is_table_layout_line(l))),
        "blockMarkers.serializeBlockAlignMarker" => {
            Ok(opt(serialize_block_align_marker(&value(args, 0))))
        }
        "blockMarkers.parseBlockAlignMarker" => text(0).map(|l| opt(parse_block_align_marker(l))),
        "blockMarkers.extractTableCellAlignments" => extract_table_cell_alignments(&value(args, 0))
            .map(opt)
            .map_err(|_| "the TypeScript threw".to_owned()),
        "blockMarkers.serializeTableCellAlignmentsMarker" => Ok(json!(
            serialize_table_cell_alignments_marker(&value(args, 0))
        )),
        "blockMarkers.parseTableCellAlignmentsMarker" => {
            text(0).map(|l| opt(parse_table_cell_alignments_marker(l)))
        }
        "blockMarkers.applyTableCellAlignments" => {
            let mut content = value(args, 0);
            apply_table_cell_alignments(&mut content, &value(args, 1));
            Ok(content)
        }
        "blockMarkers.extractTableLayout" => Ok(opt(
            extract_table_layout(&value(args, 0)).map(|layout| layout_json(&layout))
        )),
        "blockMarkers.serializeTableLayoutMarker" => Ok(json!(serialize_table_layout_marker(
            &layout_of(&value(args, 0))
        ))),
        "blockMarkers.parseTableLayoutMarker" => {
            text(0).map(|l| opt(parse_table_layout_marker(l).map(|layout| layout_json(&layout))))
        }
        "blockMarkers.applyTableLayout" => {
            let mut content = value(args, 0);
            apply_table_layout(&mut content, &layout_of(&value(args, 1)));
            Ok(content)
        }
        "blockMarkers.sidecarMarkerLines" => sidecar_marker_lines(&value(args, 0))
            .map(|lines| json!(lines))
            .map_err(|_| "the TypeScript threw".to_owned()),
        "blockMarkers.parseSidecarMarkerLine" => {
            text(0).map(|l| match parse_sidecar_marker_line(l) {
                Some(patch) => {
                    let mut block = value(args, 1);
                    patch.apply(&mut block);
                    block
                }
                None => Json::Null,
            })
        }

        "linkCard.isLinkCardLine" => text(0).map(|l| json!(is_link_card_line(l))),
        "linkCard.serializeLinkCardMarker" => Ok(opt(serialize_link_card_marker(&value(args, 0)))),
        "linkCard.parseLinkCardMarker" => {
            text(0).map(|l| opt(parse_link_card_marker(l).map(LinkCardDisplay::to_json)))
        }
        "linkCard.applyLinkCard" => {
            let mut block = value(args, 0);
            apply_link_card(&mut block, display_of(&value(args, 1)));
            Ok(block)
        }

        "inlineColors.extractInlineColorRuns" => {
            let (blocks, replacements) = extract_inline_color_runs(&list(args, 0));
            Ok(json!({"blocks": blocks, "replacements": pairs_json(&replacements)}))
        }
        "inlineColors.restoreInlineColorTokens" => {
            text(0).map(|md| json!(restore_inline_color_tokens(md, &map_pairs(&list(args, 1)))))
        }
        "inlineColors.maskInlineColorSpans" => text(0).map(|md| {
            let masked = mask_inline_color_spans(md);
            masked_json(&masked.text, &masked.spans)
        }),
        "inlineColors.applyInlineColorTokens" => Ok(blocks_json(apply_inline_color_tokens(
            &list(args, 0),
            &spans_of(&value(args, 1)),
        ))),
        "inlineColors.stripInlineStyleSpanTags" => {
            text(0).map(|md| json!(strip_inline_style_span_tags(md)))
        }

        "plainCheckbox.hasPlainCheckboxMarker" => {
            text(0).map(|t| json!(has_plain_checkbox_marker(t)))
        }
        "plainCheckbox.normalizePlainCheckboxes" => {
            let mut blocks = list(args, 0);
            let did_change = normalize_plain_checkboxes(&mut blocks);
            Ok(changed(blocks, did_change))
        }
        "plainCheckbox.withPlainCheckboxMarkers" => {
            let mut blocks = list(args, 0);
            with_plain_checkbox_markers(&mut blocks);
            Ok(blocks_json(blocks))
        }

        "taskBlock.serializeTaskBlock" => Ok(json!(serialize_task_block(&value(args, 0)))),
        "taskBlock.capTaskTreeDepth" => Ok(cap_task_tree_depth(&value(args, 0))),
        "taskBlock.serializeTaskBlockTree" => serialize_task_block_tree(&value(args, 0))
            .map(|lines| json!(lines))
            .ok_or_else(|| "the TypeScript threw".to_owned()),
        "taskBlock.parseTaskBlockSuffix" => text(0).map(|t| {
            opt(parse_task_block_suffix(t).map(|s| json!({"taskId": s.task_id, "title": s.title})))
        }),
        "taskBlock.scanTaskCheckboxStates" => text(0).map(|md| {
            Json::Array(
                scan_task_checkbox_states(md)
                    .into_iter()
                    .map(|(id, checked)| json!([id, checked]))
                    .collect(),
            )
        }),
        "taskBlock.stripTaskBlockSuffixes" => {
            text(0).map(|md| json!(strip_task_block_suffixes(md)))
        }
        "taskBlock.extractInlineText" => Ok(json!(extract_inline_text(&value(args, 0)))),
        "taskBlock.normalizeTaskBlocks" => {
            let (blocks, did_change) =
                normalize_task_blocks(&list(args, 0), args.get(1).and_then(Json::as_str));
            Ok(changed(blocks, did_change))
        }

        "obsidianTasks.hasObsidianTaskFields" => {
            text(0).map(|t| json!(has_obsidian_task_fields(t)))
        }
        "obsidianTasks.parseObsidianTaskFields" => {
            text(0).map(|t| parse_obsidian_task_fields(t).to_json())
        }
        "obsidianTasks.parseObsidianTaskLine" => {
            text(0).map(|l| opt(parse_obsidian_task_line(l).map(|line| line.to_json())))
        }
        "obsidianTasks.obsidianTaskImportBlocker" => {
            text(0).map(|t| opt(obsidian_task_import_blocker(t).map(|b| b.as_str())))
        }
        _ => return None,
    })
}

#[test]
fn markers_layer_vectors() {
    let vectors = vector_file("markdown-convert/layer-markers");
    let mut failures = Failures::default();
    let mut per_group: BTreeMap<String, usize> = BTreeMap::new();
    let mut functions: BTreeMap<String, usize> = BTreeMap::new();
    for case in vectors["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let name = case["input"]["fn"].as_str().expect("fn");
        let args = case["input"]["args"].as_array().expect("args");
        *per_group
            .entry(id.split('/').next().unwrap_or("").to_owned())
            .or_default() += 1;
        *functions.entry(name.to_owned()).or_default() += 1;
        let outcome = match dispatch(name, args) {
            None => Err(format!("no Rust dispatch for {name}")),
            Some(actual) => match (case["expected"]["status"].as_str(), actual) {
                (Some("ok"), Ok(actual)) => json_equal(&case["expected"]["output"], &actual),
                (Some("ok"), Err(e)) => Err(format!("failed: {e}")),
                (Some("error"), Ok(_)) => Err("the oracle threw, the port did not".into()),
                (Some("error"), Err(_)) => Ok(()),
                _ => Err("unknown status".into()),
            },
        };
        failures.check(id, outcome);
    }
    println!(
        "layer-markers: {} cases, {} functions, per group {per_group:?}",
        failures.checked(),
        functions.len()
    );
    failures.finish("layer-markers");
}
