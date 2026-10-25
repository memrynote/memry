//! Writing a column region and converting it to and from `columnList` blocks.

use serde_json::{Map, Value, json};

use super::regions::ColumnContentSegment;
use super::settings::{column_settings_for, column_widths_from_settings};
use super::{
    COLUMN_BREAK_LINE, COLUMN_REGION_END_LINE, COLUMN_REGION_START_PREFIX, DEFAULT_COLUMN_WIDTH,
};
use crate::markdown::frontmatter::js::js_trim;

/// `columnRegionIdFor`: the MCM id to write. Once written it is read back into
/// `regionId` and never derived again; before that it comes from the block id.
pub fn column_region_id_for(region_id: &str, block_id: Option<&str>) -> String {
    if !region_id.is_empty() {
        return region_id.to_owned();
    }
    let derived: String = block_id
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(6)
        .collect();
    if derived.is_empty() {
        "columns".to_owned()
    } else {
        derived
    }
}

/// `serializeColumnRegion`.
pub fn serialize_column_region(
    region_id: &str,
    settings: &str,
    column_bodies: &[String],
) -> String {
    let header = if settings.is_empty() {
        format!("{COLUMN_REGION_START_PREFIX} {region_id}")
    } else {
        format!("{COLUMN_REGION_START_PREFIX} {region_id}\n{settings}")
    };
    let mut parts = vec![header];
    for (index, body) in column_bodies.iter().enumerate() {
        if index > 0 {
            parts.push(COLUMN_BREAK_LINE.to_owned());
        }
        let trimmed = js_trim(body);
        if !trimmed.is_empty() {
            parts.push(trimmed.to_owned());
        }
    }
    parts.push(COLUMN_REGION_END_LINE.to_owned());
    parts.join("\n\n")
}

/// `buildColumnListBlock`: the `columnList` block for a `columns` segment, each
/// column's markdown parsed by `parse_column`. A column the parse leaves empty
/// gets one empty paragraph. `new_id`, when given, is called once per column in
/// order and then once for the list. A segment that is not `columns` is an error
/// (the TypeScript throws on its missing fields).
pub fn build_column_list_block(
    segment: &ColumnContentSegment,
    parse_column: &mut dyn FnMut(&str) -> Result<Vec<Value>, String>,
    empty_paragraph: &mut dyn FnMut() -> Value,
    mut new_id: Option<&mut dyn FnMut() -> String>,
) -> Result<Value, String> {
    let ColumnContentSegment::Columns {
        region_id,
        settings,
        columns,
    } = segment
    else {
        return Err("not a columns segment".to_owned());
    };
    let widths = column_widths_from_settings(settings, columns.len());
    let mut built = Vec::with_capacity(columns.len());
    for (index, markdown) in columns.iter().enumerate() {
        let mut children = if markdown.is_empty() {
            Vec::new()
        } else {
            parse_column(markdown)?
        };
        if children.is_empty() {
            children.push(empty_paragraph());
        }
        let mut column = Map::new();
        column.insert("type".into(), json!("column"));
        if let Some(new_id) = new_id.as_mut() {
            column.insert("id".into(), json!(new_id()));
        }
        column.insert("props".into(), json!({ "width": widths[index] }));
        column.insert("children".into(), Value::Array(children));
        built.push(Value::Object(column));
    }
    let mut list = Map::new();
    list.insert("type".into(), json!("columnList"));
    if let Some(new_id) = new_id.as_mut() {
        list.insert("id".into(), json!(new_id()));
    }
    list.insert(
        "props".into(),
        json!({ "regionId": region_id, "settings": settings }),
    );
    list.insert("children".into(), Value::Array(built));
    Ok(Value::Object(list))
}

fn column_blocks(column: &Value) -> Vec<Value> {
    column
        .get("children")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// `serializeColumnListBlock`: a `columnList` block's region, each column's
/// blocks serialized by `serialize_column`. A region of one column does not
/// parse back as a region, so its blocks are written as page content.
pub fn serialize_column_list_block(
    block: &Value,
    serialize_column: &mut dyn FnMut(&[Value]) -> Result<String, String>,
) -> Result<String, String> {
    let columns: &[Value] = block
        .get("children")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    if columns.len() < 2 {
        let blocks: Vec<Value> = columns.iter().flat_map(column_blocks).collect();
        return serialize_column(&blocks);
    }
    let widths: Vec<f64> = columns
        .iter()
        .map(|column| {
            column
                .get("props")
                .and_then(|props| props.get("width"))
                .and_then(Value::as_f64)
                .unwrap_or(DEFAULT_COLUMN_WIDTH)
        })
        .collect();
    let mut bodies = Vec::with_capacity(columns.len());
    for column in columns {
        bodies.push(serialize_column(&column_blocks(column))?);
    }
    let props = block.get("props");
    let text_prop = |name: &str| {
        props
            .and_then(|p| p.get(name))
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    let region_id = text_prop("regionId");
    let settings = text_prop("settings");
    let block_id = block.get("id").and_then(Value::as_str);
    Ok(serialize_column_region(
        &column_region_id_for(region_id, block_id),
        &column_settings_for(settings, &widths),
        &bodies,
    ))
}
