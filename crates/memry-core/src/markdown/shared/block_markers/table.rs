//! Table-level sidecar lines of `packages/shared/src/block-markers.ts`:
//! `<!-- table-align:{…} -->` (non-left cell alignments) and
//! `<!-- table-layout:{…} -->` (column widths).

use serde_json::{Map, Value as Json};

use crate::markdown::shared::block_colors::js_value::{
    is_object, is_record, js_parse, js_stringify, prop, spread_all,
};
use crate::markdown::shared::block_colors::{cell_at_mut, dotted_payload};

/// `TABLE_ALIGN_LINE_REGEX.test(line)`.
pub fn is_table_align_line(line: &str) -> bool {
    dotted_payload(line, "<!-- table-align:").is_some()
}

/// `TABLE_LAYOUT_LINE_REGEX.test(line)`.
pub fn is_table_layout_line(line: &str) -> bool {
    dotted_payload(line, "<!-- table-layout:").is_some()
}

pub(super) fn is_non_default_alignment(value: &Json) -> bool {
    matches!(value.as_str(), Some("center" | "right" | "justify"))
}

fn table_rows(content: &Json) -> Option<&Vec<Json>> {
    prop(content, "rows")?.as_array()
}

/// The TypeScript threw: `row?.cells?.forEach` on a `cells` that is neither
/// null nor an array.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsTypeError;

/// The alignment of every non-left cell, keyed `"<row>:<cell>"`, or `None`.
pub fn extract_table_cell_alignments(content: &Json) -> Result<Option<Json>, JsTypeError> {
    let Some(rows) = table_rows(content) else {
        return Ok(None);
    };
    let mut alignments = Map::new();
    for (row_index, row) in rows.iter().enumerate() {
        let cells = match prop(row, "cells") {
            None | Some(Json::Null) => continue,
            Some(Json::Array(cells)) => cells,
            Some(_) => return Err(JsTypeError),
        };
        for (cell_index, cell) in cells.iter().enumerate() {
            let alignment = is_record(cell)
                .then(|| prop(cell, "props"))
                .flatten()
                .and_then(|props| prop(props, "textAlignment"));
            if let Some(alignment) = alignment.filter(|a| is_non_default_alignment(a)) {
                alignments.insert(format!("{row_index}:{cell_index}"), alignment.clone());
            }
        }
    }
    Ok((!alignments.is_empty()).then_some(Json::Object(alignments)))
}

pub fn serialize_table_cell_alignments_marker(alignments: &Json) -> String {
    format!("<!-- table-align:{} -->", js_stringify(alignments))
}

/// Parse a table cell alignment marker; `None` unless every value is a non-left alignment.
pub fn parse_table_cell_alignments_marker(line: &str) -> Option<Json> {
    let parsed = js_parse(dotted_payload(line, "<!-- table-align:")?)?;
    parsed
        .as_object()?
        .values()
        .all(is_non_default_alignment)
        .then_some(parsed)
}

/// Put parsed cell alignments back on a freshly parsed table. A key naming a
/// cell the table no longer has is skipped.
pub fn apply_table_cell_alignments(content: &mut Json, alignments: &Json) {
    if table_rows(content).is_none() {
        return;
    }
    let Some(entries) = alignments.as_object() else {
        return;
    };
    for (key, alignment) in entries {
        let Some(cell) = cell_at_mut(content, key) else {
            continue;
        };
        let Some(props) = prop(cell, "props").filter(|props| is_object(props)) else {
            continue;
        };
        if !is_record(cell) {
            continue;
        }
        let mut merged = spread_all(&[props]);
        merged.insert("textAlignment".to_owned(), alignment.clone());
        if let Some(map) = cell.as_object_mut() {
            map.insert("props".to_owned(), Json::Object(merged));
        }
    }
}

/// `TableLayout`: one slot per column, `null` where the editor picks the width.
/// Each slot is a JSON number or `null`.
#[derive(Debug, Clone, PartialEq)]
pub struct TableLayout {
    pub column_widths: Vec<Json>,
}

/// `isStoredWidth`: a finite number above zero.
fn is_stored_width(value: &Json) -> bool {
    value
        .as_f64()
        .is_some_and(|width| width.is_finite() && width > 0.0)
}

/// A table's column widths, or `None` when the block is not a table or nobody
/// has resized a column.
pub fn extract_table_layout(content: &Json) -> Option<TableLayout> {
    table_rows(content)?;
    let widths = prop(content, "columnWidths")?.as_array()?;
    let column_widths: Vec<Json> = widths
        .iter()
        .map(|width| {
            if is_stored_width(width) {
                width.clone()
            } else {
                Json::Null
            }
        })
        .collect();
    column_widths
        .iter()
        .any(|width| !width.is_null())
        .then_some(TableLayout { column_widths })
}

pub fn serialize_table_layout_marker(layout: &TableLayout) -> String {
    let widths = Json::Array(layout.column_widths.clone());
    format!(
        "<!-- table-layout:{{\"columnWidths\":{}}} -->",
        js_stringify(&widths)
    )
}

/// Parse a table layout marker line; `None` when the line is not a valid marker.
pub fn parse_table_layout_marker(line: &str) -> Option<TableLayout> {
    let parsed = js_parse(dotted_payload(line, "<!-- table-layout:")?)?;
    let widths = prop(&parsed, "columnWidths")?.as_array()?;
    widths
        .iter()
        .all(|width| width.is_null() || is_stored_width(width))
        .then(|| TableLayout {
            column_widths: widths.clone(),
        })
}

/// Put parsed column widths back on a freshly parsed table. The column count
/// is the table's own; a marker that no longer fits pads or truncates.
pub fn apply_table_layout(content: &mut Json, layout: &TableLayout) {
    let Some(rows) = table_rows(content) else {
        return;
    };
    let parsed = prop(content, "columnWidths").and_then(Json::as_array);
    let column_count = parsed.map_or_else(
        || {
            rows.first()
                .and_then(|row| prop(row, "cells"))
                .and_then(Json::as_array)
                .map_or(0, Vec::len)
        },
        Vec::len,
    );
    if column_count == 0 {
        return;
    }
    let widths: Vec<Json> = (0..column_count)
        .map(|column| match layout.column_widths.get(column) {
            Some(stored) if is_stored_width(stored) => stored.clone(),
            _ => parsed
                .and_then(|list| list.get(column))
                .cloned()
                .unwrap_or(Json::Null),
        })
        .collect();
    if let Some(map) = content.as_object_mut() {
        map.insert("columnWidths".to_owned(), Json::Array(widths));
    }
}
