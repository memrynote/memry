//! A table block: `tableContentToNodes` rendered through ProseMirror's
//! `DOMSerializer`, and the `colgroup` the table node's `renderHTML` adds.

use serde_json::Value as Json;

use super::inline::{inline_content_nodes, pm_fragment};
use super::{Ret, err, truthy};
use crate::markdown::bn::dom::{Dom, NodeId};
use crate::markdown::convert::ConvertError;
use crate::markdown::frontmatter::js::number_to_string;

fn is_partial_cell(cell: &Json) -> bool {
    cell.get("type").and_then(Json::as_str) == Some("tableCell")
}

fn count(value: Option<&Json>) -> usize {
    value.and_then(Json::as_u64).map_or(0, |n| n as usize)
}

fn span_text(props: Option<&Json>, name: &str) -> String {
    match props.and_then(|p| p.get(name)) {
        Some(Json::Number(n)) => n.as_f64().map_or_else(|| "1".into(), number_to_string),
        Some(Json::String(s)) => s.clone(),
        _ => "1".into(),
    }
}

/// `getColspan`.
fn colspan_of(cell: &Json) -> usize {
    let n = cell
        .get("props")
        .and_then(|p| p.get("colspan"))
        .and_then(Json::as_f64)
        .unwrap_or(1.0);
    if n.is_finite() && n >= 1.0 {
        n as usize
    } else {
        1
    }
}

/// The `tr` elements of a table's content.
pub(super) fn rows(dom: &mut Dom, content: &Json) -> Result<Vec<NodeId>, ConvertError> {
    let header_rows = count(content.get("headerRows"));
    let header_cols = count(content.get("headerCols"));
    let rows = content
        .get("rows")
        .and_then(Json::as_array)
        .filter(|r| !r.is_empty())
        .ok_or_else(|| err("a table without rows"))?;
    // `tableContentToNodes` places every cell on the occupancy grid first, and
    // that throws on a span the grid cannot hold (text, fraction, overlap).
    crate::markdown::bn::block_to_node::absolute_columns(rows).map_err(|e| err(e.to_string()))?;
    let mut trs = Vec::new();
    for (row_index, row) in rows.iter().enumerate() {
        let cells = row
            .get("cells")
            .and_then(Json::as_array)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| err("a table row without cells"))?;
        let tr = dom.create_element("tr");
        for (cell_index, cell) in cells.iter().enumerate() {
            let tag = if row_index < header_rows || cell_index < header_cols {
                "th"
            } else {
                "td"
            };
            let td = dom.create_element(tag);
            let props = if is_partial_cell(cell) {
                cell.get("props")
            } else {
                None
            };
            dom.set_attr(td, "colspan", &span_text(props, "colspan"));
            dom.set_attr(td, "rowspan", &span_text(props, "rowspan"));
            let p = dom.create_element("p");
            dom.append_child(td, p);
            let nodes = if !truthy(Some(cell)) {
                Vec::new()
            } else if let Json::String(s) = cell {
                vec![super::inline::Inl::Text {
                    text: s.clone(),
                    marks: Vec::new(),
                }]
            } else if is_partial_cell(cell) {
                match cell.get("content") {
                    Some(c) if truthy(Some(c)) => inline_content_nodes(c, Some("tableParagraph"))?,
                    _ => Vec::new(),
                }
            } else {
                inline_content_nodes(cell, Some("tableParagraph"))?
            };
            pm_fragment(dom, &nodes, p)?;
            dom.append_child(tr, td);
        }
        trs.push(tr);
    }
    Ok(trs)
}

/// The table block: `<table><colgroup>…</colgroup>` with the rows after it.
pub(super) fn table_dom(dom: &mut Dom, block: &Json) -> Result<Ret, ConvertError> {
    let table = dom.create_element("table");
    let colgroup = dom.create_element("colgroup");
    let first_row = block
        .get("content")
        .and_then(|c| c.get("rows"))
        .and_then(Json::as_array)
        .and_then(|r| r.first())
        .and_then(|r| r.get("cells"))
        .and_then(Json::as_array);
    for cell in first_row.into_iter().flatten() {
        let n = if is_partial_cell(cell) {
            colspan_of(cell)
        } else {
            1
        };
        for _ in 0..n {
            let col = dom.create_element("col");
            dom.append_child(colgroup, col);
        }
    }
    dom.append_child(table, colgroup);
    Ok(Ret::with_content(table, table))
}
