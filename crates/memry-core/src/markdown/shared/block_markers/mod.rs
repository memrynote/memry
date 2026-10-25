//! Port of `packages/shared/src/block-markers.ts`: the sidecar marker lines
//! that carry what GFM cannot (block and cell colors, text alignment, table
//! column widths, link-card display). A parsed marker is a [`SidecarPatch`],
//! queued by the pipeline and applied to the block that follows the line.

mod table;

use serde_json::{Value as Json, json};

use super::block_colors::js_value::{prop, spread_all};
use super::block_colors::{
    apply_table_cell_colors, extract_table_cell_colors, has_non_default_colors,
    parse_block_colors_marker, parse_table_cell_colors_marker, serialize_block_colors_marker,
    serialize_table_cell_colors_marker,
};
use super::link_card_marker::{
    LinkCardDisplay, apply_link_card, parse_link_card_marker, serialize_link_card_marker,
};
pub use table::{
    JsTypeError, TableLayout, apply_table_cell_alignments, apply_table_layout,
    extract_table_cell_alignments, extract_table_layout, is_table_align_line, is_table_layout_line,
    parse_table_cell_alignments_marker, parse_table_layout_marker,
    serialize_table_cell_alignments_marker, serialize_table_layout_marker,
};

/// The non-default alignments a marker writes.
const ALIGNMENTS: [&str; 3] = ["center", "right", "justify"];

/// What a parsed marker line does to the block that follows it
/// (`SidecarPatch`, a closure in the TypeScript).
#[derive(Debug, Clone, PartialEq)]
pub enum SidecarPatch {
    /// `props = {...props, ...colors}`.
    BlockColors(Json),
    TableCellColors(Json),
    TableCellAlignments(Json),
    /// `props = {...props, textAlignment}`.
    BlockAlign(&'static str),
    TableLayout(TableLayout),
    LinkCard(LinkCardDisplay),
}

impl SidecarPatch {
    /// Run the patch on `block` (a `{type, props, content}` BlockNote block).
    pub fn apply(&self, block: &mut Json) {
        let Some(map) = block.as_object_mut() else {
            return;
        };
        match self {
            Self::BlockColors(colors) => merge_props(map, colors),
            Self::BlockAlign(alignment) => {
                merge_props(map, &json!({ "textAlignment": alignment }));
            }
            Self::TableCellColors(colors) => {
                if let Some(content) = map.get_mut("content") {
                    apply_table_cell_colors(content, colors);
                }
            }
            Self::TableCellAlignments(alignments) => {
                if let Some(content) = map.get_mut("content") {
                    apply_table_cell_alignments(content, alignments);
                }
            }
            Self::TableLayout(layout) => {
                if let Some(content) = map.get_mut("content") {
                    apply_table_layout(content, layout);
                }
            }
            Self::LinkCard(display) => apply_link_card(block, *display),
        }
    }
}

/// `block.props = {...block.props, ...extra}`.
fn merge_props(block: &mut serde_json::Map<String, Json>, extra: &Json) {
    let current = block.get("props").cloned().unwrap_or(Json::Null);
    block.insert(
        "props".to_owned(),
        Json::Object(spread_all(&[&current, extra])),
    );
}

/// `BLOCK_ALIGN_LINE_REGEX.test(line)`.
pub fn is_block_align_line(line: &str) -> bool {
    parse_block_align_marker(line).is_some()
}

/// The alignment marker a block needs, or `None` when its alignment is the
/// default (or absent, or a value outside the enum).
pub fn serialize_block_align_marker(props: &Json) -> Option<String> {
    let alignment = prop(props, "textAlignment")?.as_str()?;
    ALIGNMENTS
        .contains(&alignment)
        .then(|| format!("<!-- align:{alignment} -->"))
}

/// Parse a text alignment marker line; `None` when the line is not one.
pub fn parse_block_align_marker(line: &str) -> Option<&'static str> {
    let alignment = line.strip_prefix("<!-- align:")?.strip_suffix(" -->")?;
    ALIGNMENTS
        .into_iter()
        .find(|candidate| *candidate == alignment)
}

/// The marker lines a block needs in front of it, in on-disk order; empty for
/// a block in every default state. `Err` where the TypeScript throws (a table
/// row whose `cells` is not an array).
pub fn sidecar_marker_lines(block: &Json) -> Result<Vec<String>, JsTypeError> {
    let props = block.get("props").unwrap_or(&Json::Null);
    let content = block.get("content").unwrap_or(&Json::Null);
    let alignments = extract_table_cell_alignments(content)?;
    Ok([
        has_non_default_colors(props).then(|| serialize_block_colors_marker(props)),
        extract_table_cell_colors(content)
            .map(|colors| serialize_table_cell_colors_marker(&colors)),
        alignments.map(|alignments| serialize_table_cell_alignments_marker(&alignments)),
        serialize_block_align_marker(props),
        extract_table_layout(content).map(|layout| serialize_table_layout_marker(&layout)),
        serialize_link_card_marker(block),
    ]
    .into_iter()
    .flatten()
    .collect())
}

/// The patch `line` applies to the block after it; `None` leaves the line alone.
pub fn parse_sidecar_marker_line(line: &str) -> Option<SidecarPatch> {
    if let Some(colors) = parse_block_colors_marker(line) {
        return Some(SidecarPatch::BlockColors(colors));
    }
    if let Some(colors) = parse_table_cell_colors_marker(line) {
        return Some(SidecarPatch::TableCellColors(colors));
    }
    if let Some(alignments) = parse_table_cell_alignments_marker(line) {
        return Some(SidecarPatch::TableCellAlignments(alignments));
    }
    if let Some(alignment) = parse_block_align_marker(line) {
        return Some(SidecarPatch::BlockAlign(alignment));
    }
    if let Some(layout) = parse_table_layout_marker(line) {
        return Some(SidecarPatch::TableLayout(layout));
    }
    parse_link_card_marker(line).map(SidecarPatch::LinkCard)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_block_writes_no_marker() {
        let block = json!({"type": "paragraph", "props": {"textColor": "default"}, "content": []});
        assert!(sidecar_marker_lines(&block).unwrap().is_empty());
    }

    #[test]
    fn a_patch_lands_on_the_next_block() {
        let patch = parse_sidecar_marker_line("<!-- align:center -->").unwrap();
        let mut block = json!({"type": "paragraph", "props": {"a": 1}, "content": []});
        patch.apply(&mut block);
        assert_eq!(block["props"], json!({"a": 1, "textAlignment": "center"}));
    }
}
