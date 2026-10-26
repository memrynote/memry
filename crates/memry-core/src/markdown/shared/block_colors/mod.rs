//! Port of `packages/shared/src/block-colors.ts`: the `<!-- colors:{…} -->` and
//! `<!-- table-colors:{…} -->` sidecar lines. Blocks and props are BlockNote
//! JSON (`serde_json::Value`); the marker payloads keep the key order the
//! TypeScript writes.

pub(crate) mod js_value;

use serde_json::{Map, Value as Json};

use js_value::{
    array_index, is_integer, is_object, is_record, js_number, js_parse, js_stringify, prop,
    spread_all,
};

/// The JS pattern `\{.*\}` between `prefix` and ` -->`: no line terminator in it.
pub(crate) fn dotted_payload<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let inner = line.strip_prefix(prefix)?.strip_suffix(" -->")?;
    let body = inner.strip_prefix('{')?.strip_suffix('}')?;
    if body.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(inner)
}

/// The JS pattern `\{[^}]*\}` between `<!-- colors:` and ` -->`.
fn block_colors_payload(line: &str) -> Option<&str> {
    let inner = line.strip_prefix("<!-- colors:")?.strip_suffix(" -->")?;
    let body = inner.strip_prefix('{')?.strip_suffix('}')?;
    (!body.contains('}')).then_some(inner)
}

/// `BLOCK_COLORS_LINE_REGEX.test(line)`.
pub fn is_block_colors_line(line: &str) -> bool {
    block_colors_payload(line).is_some()
}

/// `TABLE_CELL_COLORS_LINE_REGEX.test(line)`.
pub fn is_table_cell_colors_line(line: &str) -> bool {
    dotted_payload(line, "<!-- table-colors:").is_some()
}

fn non_default(props: &Json, key: &str) -> Option<Json> {
    match prop(props, key) {
        Some(Json::String(text)) if text == "default" => None,
        other => other.cloned(),
    }
}

/// True when block props carry a non-default text or background color.
pub fn has_non_default_colors(props: &Json) -> bool {
    non_default(props, "textColor").is_some() || non_default(props, "backgroundColor").is_some()
}

/// The non-default colors only, in the fixed key order `textColor`, `backgroundColor`.
fn pick_non_default_colors(props: &Json) -> Json {
    let mut colors = Map::new();
    for key in ["textColor", "backgroundColor"] {
        if let Some(value) = non_default(props, key) {
            colors.insert(key.to_owned(), value);
        }
    }
    Json::Object(colors)
}

/// Serialize non-default block colors to a marker line.
pub fn serialize_block_colors_marker(props: &Json) -> String {
    format!(
        "<!-- colors:{} -->",
        js_stringify(&pick_non_default_colors(props))
    )
}

/// Parse a block color marker line; `None` when the line is not a valid marker.
pub fn parse_block_colors_marker(line: &str) -> Option<Json> {
    js_parse(block_colors_payload(line)?)
}

fn table_rows(content: &Json) -> Option<&Vec<Json>> {
    prop(content, "rows")?.as_array()
}

/// The colors of every non-default cell, keyed `"<row>:<cell>"`, or `None`
/// when the block is not a table or nothing in it is colored.
pub fn extract_table_cell_colors(content: &Json) -> Option<Json> {
    let mut colors = Map::new();
    for (row_index, row) in table_rows(content)?.iter().enumerate() {
        let Some(cells) = prop(row, "cells").and_then(Json::as_array) else {
            continue;
        };
        for (cell_index, cell) in cells.iter().enumerate() {
            let Some(props) = cell_props(cell) else {
                continue;
            };
            if has_non_default_colors(props) {
                colors.insert(
                    format!("{row_index}:{cell_index}"),
                    pick_non_default_colors(props),
                );
            }
        }
    }
    (!colors.is_empty()).then_some(Json::Object(colors))
}

/// A cell's props, or `None` when the cell cannot hold any.
fn cell_props(cell: &Json) -> Option<&Json> {
    if !is_record(cell) {
        return None;
    }
    prop(cell, "props").filter(|props| is_object(props))
}

/// Serialize a table's cell colors to a marker line.
pub fn serialize_table_cell_colors_marker(colors: &Json) -> String {
    format!("<!-- table-colors:{} -->", js_stringify(colors))
}

/// Parse a table cell color marker line; `None` when the line is not a valid marker.
pub fn parse_table_cell_colors_marker(line: &str) -> Option<Json> {
    let parsed = js_parse(dotted_payload(line, "<!-- table-colors:")?)?;
    parsed.is_object().then_some(parsed)
}

/// The `[rowIndex, cellIndex]` a `"<row>:<cell>"` key names:
/// `key.split(':').map(Number)`, `None` unless both are integers.
pub(crate) fn parse_cell_key(key: &str) -> Option<(f64, f64)> {
    let mut parts = key.split(':');
    let row = js_number(parts.next()?);
    let cell = js_number(parts.next()?);
    (is_integer(row) && is_integer(cell)).then_some((row, cell))
}

/// The cell at a parsed key, when the table still has it.
pub(crate) fn cell_at_mut<'a>(content: &'a mut Json, key: &str) -> Option<&'a mut Json> {
    let (row, cell) = parse_cell_key(key)?;
    let rows = content.as_object_mut()?.get_mut("rows")?.as_array_mut()?;
    let row_index = array_index(row, rows.len())?;
    let cells = rows[row_index]
        .as_object_mut()?
        .get_mut("cells")?
        .as_array_mut()?;
    let cell_index = array_index(cell, cells.len())?;
    Some(&mut cells[cell_index])
}

/// Put parsed cell colors back on a freshly parsed table's cells. A key naming
/// a cell the table no longer has is skipped.
pub fn apply_table_cell_colors(content: &mut Json, colors: &Json) {
    if table_rows(content).is_none() {
        return;
    }
    let Some(entries) = colors.as_object() else {
        return;
    };
    for (key, cell_colors) in entries {
        let Some(cell) = cell_at_mut(content, key) else {
            continue;
        };
        if !is_record(cell) {
            continue;
        }
        let Some(props) = cell.get("props").filter(|props| is_object(props)) else {
            continue;
        };
        let merged = spread_all(&[props, cell_colors]);
        if let Some(map) = cell.as_object_mut() {
            map.insert("props".to_owned(), Json::Object(merged));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn marker_round_trips_the_non_default_colors() {
        let line = serialize_block_colors_marker(&json!({
            "backgroundColor": "blue", "textColor": "red", "other": 1
        }));
        assert_eq!(
            line,
            r#"<!-- colors:{"textColor":"red","backgroundColor":"blue"} -->"#
        );
        assert_eq!(
            parse_block_colors_marker(&line),
            Some(json!({"textColor": "red", "backgroundColor": "blue"}))
        );
    }

    #[test]
    fn a_missing_cell_is_skipped() {
        let mut content = json!({"rows": [{"cells": [{"props": {}}]}]});
        apply_table_cell_colors(&mut content, &json!({"3:0": {"textColor": "red"}}));
        assert_eq!(content, json!({"rows": [{"cells": [{"props": {}}]}]}));
    }
}
