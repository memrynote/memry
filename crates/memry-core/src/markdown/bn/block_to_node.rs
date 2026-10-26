//! BlockNote `blockToNode` (`api/nodeConversions/blockToNode.ts`): a block as
//! JSON to a ProseMirror node of the memry schema, the inverse of
//! [`super::node_to_block`]. Every `createChecked` of the TypeScript is
//! [`Schema::node`] here, and a `throw` is an `Err`: the caller fails closed.

use serde_json::Value as Json;
use yrs::Any;

use crate::markdown::pm::model::json_to_any;
use crate::markdown::pm::{Mark, Node, PmError, Schema};

/// Where block ids come from: `crypto.randomUUID()` in production, a counter in
/// tests so a vector's output does not depend on chance.
pub trait IdSource: Send + Sync {
    fn next_id(&self) -> String;
}

/// A fresh random UUID per block.
pub struct UuidIds;

impl IdSource for UuidIds {
    fn next_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// What `blockToNode` throws.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum BlockError {
    #[error(transparent)]
    Pm(#[from] PmError),
    #[error("{0}")]
    Block(String),
}

fn err(message: impl Into<String>) -> BlockError {
    BlockError::Block(message.into())
}

fn str_of(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(str::to_owned)
}

fn props_attrs(props: Option<&Json>) -> Vec<(String, Any)> {
    match props {
        Some(Json::Object(map)) => map
            .iter()
            .map(|(k, v)| (k.clone(), json_to_any(v)))
            .collect(),
        _ => Vec::new(),
    }
}

fn is_plain(schema: &Schema, name: &str) -> bool {
    schema
        .node_type(name)
        .is_some_and(|ty| schema.node_ty(ty).spec.content == "text*")
}

/// `styledTextToNodes`.
fn styled_text_nodes(
    schema: &Schema,
    styled: &Json,
    block_type: Option<&str>,
) -> Result<Vec<Node>, BlockError> {
    let mut marks: Vec<Mark> = Vec::new();
    if let Some(styles) = styled.get("styles").and_then(Json::as_object) {
        for (style, value) in styles {
            let boolean = matches!(
                style.as_str(),
                "bold" | "italic" | "underline" | "strike" | "code"
            );
            let string = matches!(style.as_str(), "textColor" | "backgroundColor");
            if !boolean && !string {
                return Err(err(format!("style {style} not found in styleSchema")));
            }
            let truthy = match value {
                Json::Null | Json::Bool(false) => false,
                Json::String(s) => !s.is_empty(),
                Json::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
                _ => true,
            };
            if !truthy {
                continue;
            }
            let ty = schema
                .mark_type(style)
                .ok_or_else(|| PmError::UnknownMarkType(style.clone()))?;
            let given = if string {
                Any::from(
                    [("stringValue".to_owned(), json_to_any(value))]
                        .into_iter()
                        .collect::<std::collections::HashMap<_, _>>(),
                )
            } else {
                Any::Null
            };
            marks.push(schema.create_mark(ty, &given)?);
        }
    }
    let text = styled.get("text").and_then(Json::as_str).unwrap_or("");
    let plain = block_type.is_some_and(|t| is_plain(schema, t));
    // Plain content nodes hold raw text and allow only the marks their `marks`
    // spec names (none), so a formatting mark on one is dropped.
    let allowed = match block_type.and_then(|t| schema.node_type(t)) {
        Some(ty) if plain && !schema.node_ty(ty).all_marks => Vec::new(),
        _ => marks,
    };
    if plain {
        return Ok(if text.is_empty() {
            Vec::new()
        } else {
            vec![schema.text(text, allowed)?]
        });
    }
    let mut nodes = Vec::new();
    // `split(/(\n)/g)` keeping the separators, dropping empty strings.
    let mut rest = text;
    while !rest.is_empty() {
        match rest.find('\n') {
            Some(0) => {
                nodes.push(schema.node("hardBreak", &[], Vec::new())?);
                rest = &rest[1..];
            }
            Some(at) => {
                nodes.push(schema.text(&rest[..at], allowed.clone())?);
                rest = &rest[at..];
            }
            None => {
                nodes.push(schema.text(rest, allowed.clone())?);
                rest = "";
            }
        }
    }
    Ok(nodes)
}

/// `styledTextArrayToNodes`.
fn styled_array_nodes(
    schema: &Schema,
    content: &Json,
    block_type: Option<&str>,
) -> Result<Vec<Node>, BlockError> {
    let mut nodes = Vec::new();
    match content {
        Json::String(text) => {
            let item = serde_json::json!({"type": "text", "text": text, "styles": {}});
            nodes.extend(styled_text_nodes(schema, &item, block_type)?);
        }
        Json::Array(items) => {
            for item in items {
                nodes.extend(styled_text_nodes(schema, item, block_type)?);
            }
        }
        _ => return Err(err("styled text content is neither a string nor an array")),
    }
    Ok(nodes)
}

/// `linkToNodes`.
fn link_nodes(schema: &Schema, link: &Json) -> Result<Vec<Node>, BlockError> {
    let href = link.get("href").map_or(Any::Undefined, json_to_any);
    let link_ty = schema
        .mark_type("link")
        .ok_or_else(|| PmError::UnknownMarkType("link".into()))?;
    let mark = schema.create_mark(
        link_ty,
        &Any::from(
            [("href".to_owned(), href)]
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>(),
        ),
    )?;
    let content = link.get("content").unwrap_or(&Json::Null);
    styled_array_nodes(schema, content, None)?
        .into_iter()
        .map(|mut node| {
            if node.is_text() {
                // `node.mark([...node.marks, linkMark])`: appended, not re-sorted.
                node.marks.push(mark.clone());
                Ok(node)
            } else if schema.node_ty(node.ty).name == "hardBreak" {
                Ok(node)
            } else {
                Err(err("unexpected node type"))
            }
        })
        .collect()
}

/// `inlineContentToNodes`.
fn inline_nodes(
    schema: &Schema,
    content: &[Json],
    block_type: Option<&str>,
) -> Result<Vec<Node>, BlockError> {
    let mut nodes = Vec::new();
    for item in content {
        match item {
            Json::String(text) => {
                nodes.extend(styled_array_nodes(
                    schema,
                    &Json::String(text.clone()),
                    block_type,
                )?);
            }
            other => match other.get("type").and_then(Json::as_str) {
                Some("link") => nodes.extend(link_nodes(schema, other)?),
                Some("text") => nodes.extend(styled_text_nodes(schema, other, block_type)?),
                _ => nodes.push(content_node(schema, other)?),
            },
        }
    }
    Ok(nodes)
}

/// Cell column of every cell in `rows`, by `getTableCellOccupancyGrid` and
/// `getAbsoluteTableCells`: `result[row][cell]` is the absolute column.
fn absolute_columns(rows: &[Json]) -> Result<Vec<Vec<usize>>, BlockError> {
    fn is_table_cell(cell: &Json) -> bool {
        cell.get("type").and_then(Json::as_str) == Some("tableCell")
            && cell.get("props").is_some_and(|p| !p.is_null())
            && cell.get("content").is_some_and(|c| !c.is_null())
    }
    fn span(cell: &Json, key: &str) -> usize {
        if !is_table_cell(cell) {
            return 1;
        }
        match cell["props"].get(key) {
            Some(Json::Number(n)) => n.as_f64().map_or(1, |f| f.max(0.0) as usize),
            _ => 1,
        }
    }
    let cells = |row: &Json| {
        row.get("cells")
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let height = rows.len();
    let width = rows
        .iter()
        .map(|row| cells(row).iter().map(|c| span(c, "colspan")).sum::<usize>())
        .max()
        .unwrap_or(0);
    // grid[r][c] = Some((relative row, relative col))
    let mut grid: Vec<Vec<Option<(usize, usize)>>> = vec![vec![None; width]; height];
    for (row, row_json) in rows.iter().enumerate() {
        for (col, cell) in cells(row_json).iter().enumerate() {
            let (rowspan, colspan) = (span(cell, "rowspan"), span(cell, "colspan"));
            let mut start = None;
            'find: for (i, grid_row) in grid.iter().enumerate().skip(row) {
                for (j, slot) in grid_row.iter().enumerate().skip(col) {
                    if slot.is_none() {
                        start = Some((i, j));
                        break 'find;
                    }
                }
            }
            let (start_row, start_col) = start.ok_or_else(|| {
                err("Unable to create occupancy grid for table, no more available cells")
            })?;
            for i in start_row..start_row + rowspan {
                for j in start_col..start_col + colspan {
                    let slot = grid
                        .get_mut(i)
                        .and_then(|r| r.get_mut(j))
                        .ok_or_else(|| err("table cell outside the grid"))?;
                    if slot.is_some() {
                        return Err(err("Unable to create occupancy grid for table"));
                    }
                    *slot = Some((row, col));
                }
            }
        }
    }
    rows.iter()
        .enumerate()
        .map(|(row, row_json)| {
            (0..cells(row_json).len())
                .map(|col| {
                    grid.iter()
                        .flat_map(|r| r.iter().enumerate())
                        .find(|(_, slot)| **slot == Some((row, col)))
                        .map(|(c, _)| c)
                        .ok_or_else(|| err("Unable to resolve relative table cell indices"))
                })
                .collect()
        })
        .collect()
}

/// `tableContentToNodes`.
fn table_nodes(schema: &Schema, table: &Json) -> Result<Vec<Node>, BlockError> {
    let rows: Vec<Json> = table
        .get("rows")
        .and_then(Json::as_array)
        .cloned()
        .unwrap_or_default();
    let header_rows = table
        .get("headerRows")
        .and_then(Json::as_f64)
        .unwrap_or(0.0) as usize;
    let header_cols = table
        .get("headerCols")
        .and_then(Json::as_f64)
        .unwrap_or(0.0) as usize;
    let widths: Vec<Option<f64>> = table
        .get("columnWidths")
        .and_then(Json::as_array)
        .map(|w| w.iter().map(Json::as_f64).collect())
        .unwrap_or_default();
    let width_at = |col: usize| widths.get(col).copied().flatten().filter(|w| *w != 0.0);
    let columns = absolute_columns(&rows)?;
    let mut row_nodes = Vec::new();
    for (row_index, row) in rows.iter().enumerate() {
        let cells = row
            .get("cells")
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default();
        let mut cell_nodes = Vec::new();
        for (cell_index, cell) in cells.iter().enumerate() {
            let absolute = columns[row_index][cell_index];
            let mut colwidth =
                width_at(absolute).map_or(Any::Null, |w| Any::from(vec![Any::Number(w)]));
            let mut content: Vec<Node> = Vec::new();
            let mut props: Vec<(String, Any)> = Vec::new();
            let partial =
                cell.get("type").and_then(Json::as_str) == Some("tableCell") && !cell.is_array();
            if cell.is_null() || cell == &Json::Bool(false) || cell.as_str() == Some("") {
            } else if let Some(text) = cell.as_str() {
                content.push(schema.text(text, Vec::new())?);
            } else if partial {
                if let Some(inline) = cell.get("content").and_then(Json::as_array) {
                    content = inline_nodes(schema, inline, Some("tableParagraph"))?;
                }
                let colspan = cell["props"]
                    .get("colspan")
                    .and_then(Json::as_f64)
                    .filter(|s| cell.get("content").is_some_and(|c| !c.is_null()) && *s > 0.0)
                    .unwrap_or(1.0) as usize;
                if colspan > 1 {
                    colwidth = Any::from(
                        (0..colspan)
                            .map(|i| width_at(absolute + i).map_or(Any::Undefined, Any::Number))
                            .collect::<Vec<_>>(),
                    );
                }
                props = props_attrs(cell.get("props"));
            } else if let Some(inline) = cell.as_array() {
                content = inline_nodes(schema, inline, Some("tableParagraph"))?;
            }
            props.push(("colwidth".into(), colwidth));
            let paragraph = schema.node("tableParagraph", &[], content)?;
            let ty = if cell_index < header_cols || row_index < header_rows {
                "tableHeader"
            } else {
                "tableCell"
            };
            cell_nodes.push(schema.node(ty, &props, vec![paragraph])?);
        }
        row_nodes.push(schema.node("tableRow", &[], cell_nodes)?);
    }
    Ok(row_nodes)
}

/// `blockOrInlineContentToContentNode`.
fn content_node(schema: &Schema, block: &Json) -> Result<Node, BlockError> {
    let ty = str_of(block, "type").unwrap_or_else(|| "paragraph".into());
    if schema.node_type(&ty).is_none() {
        return Err(err(format!("node type {ty} not found in schema")));
    }
    let props = props_attrs(block.get("props"));
    let children = match block.get("content") {
        None | Some(Json::Null) | Some(Json::Bool(false)) => Vec::new(),
        Some(Json::String(text)) if text.is_empty() => Vec::new(),
        Some(Json::String(text)) => inline_nodes(schema, &[Json::String(text.clone())], Some(&ty))?,
        Some(Json::Array(items)) => inline_nodes(schema, items, Some(&ty))?,
        Some(table) if table.get("type").and_then(Json::as_str) == Some("tableContent") => {
            table_nodes(schema, table)?
        }
        Some(_) => return Err(err("unreachable block content")),
    };
    Ok(schema.node(&ty, &props, children)?)
}

/// `blockToNode(block, schema)`; `ids` supplies an id for a block that has
/// none (`id === undefined`).
pub fn block_to_node(
    schema: &Schema,
    block: &Json,
    ids: &dyn IdSource,
) -> Result<Node, BlockError> {
    let id = match block.get("id") {
        None => ids.next_id(),
        Some(Json::String(s)) => s.clone(),
        Some(Json::Null) => return Err(err("block id is null")),
        Some(_) => return Err(err("block id is not a string")),
    };
    let children = block
        .get("children")
        .and_then(Json::as_array)
        .map(|items| {
            items
                .iter()
                .map(|child| block_to_node(schema, child, ids))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();

    let ty = str_of(block, "type");
    let ty_id = match &ty {
        Some(name) => Some(
            schema
                .node_type(name)
                .ok_or_else(|| err(format!("Cannot read properties of undefined ({name})")))?,
        ),
        None => None,
    };
    let mut attrs: Vec<(String, Any)> = vec![("id".into(), Any::from(id.as_str()))];
    attrs.extend(props_attrs(block.get("props")));

    if ty_id.is_none_or(|t| schema.node_ty(t).is_in_group("blockContent")) {
        let content = content_node(schema, block)?;
        let mut kids = vec![content];
        if !children.is_empty() {
            kids.push(schema.node("blockGroup", &[], children)?);
        }
        Ok(schema.node("blockContainer", &attrs, kids)?)
    } else if let Some(t) = ty_id
        && schema.node_ty(t).is_in_group("bnBlock")
    {
        // `create`, not `createChecked`: a partial container passes through.
        let fragment = crate::markdown::pm::Fragment::from_array(children);
        Ok(schema.create(t, &attrs, fragment, Vec::new())?)
    } else {
        Err(err(format!(
            "block type {} doesn't match blockContent or bnBlock group",
            ty.unwrap_or_default()
        )))
    }
}

/// `ensureBlockIds`: a falsy id becomes a fresh one, parents before children.
pub fn ensure_block_ids(blocks: &mut [Json], ids: &dyn IdSource) {
    for block in blocks {
        let Some(map) = block.as_object_mut() else {
            continue;
        };
        let missing = match map.get("id") {
            None | Some(Json::Null) => true,
            Some(Json::String(s)) => s.is_empty(),
            Some(Json::Bool(b)) => !b,
            Some(Json::Number(n)) => n.as_f64().is_some_and(|f| f == 0.0),
            Some(_) => false,
        };
        if missing {
            map.insert("id".into(), Json::String(ids.next_id()));
        }
        if let Some(Json::Array(children)) = map.get_mut("children") {
            ensure_block_ids(children, ids);
        }
    }
}

/// `_blocksToProsemirrorNode`: the document node holding one `blockGroup`.
pub fn blocks_to_doc(
    schema: &Schema,
    blocks: &[Json],
    ids: &dyn IdSource,
) -> Result<Node, BlockError> {
    let nodes = blocks
        .iter()
        .map(|b| block_to_node(schema, b, ids))
        .collect::<Result<Vec<_>, _>>()?;
    let group_ty = schema
        .node_type("blockGroup")
        .ok_or_else(|| PmError::UnknownNodeType("blockGroup".into()))?;
    let group = schema.create(
        group_ty,
        &[],
        crate::markdown::pm::Fragment::from_array(nodes),
        Vec::new(),
    )?;
    Ok(schema.create(
        schema.top_node_type(),
        &[],
        crate::markdown::pm::Fragment::from_array(vec![group]),
        Vec::new(),
    )?)
}
