//! Split from `body_edit.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;

/// The `table` element under the container carrying `id`.
pub(super) fn locate_table(
    txn: &mut TransactionMut,
    table_id: &str,
) -> Result<XmlElementRef, CrdtError> {
    let (_, block) = locate(txn, table_id).ok_or_else(|| missing(table_id))?;
    if block.tag().as_ref() != "table" {
        return Err(CrdtError::Undecodable {
            doc_id: table_id.to_owned(),
            what: "that block is not a table".to_owned(),
        });
    }
    Ok(block)
}

pub(super) fn rows_of(txn: &TransactionMut, table: &XmlElementRef) -> Vec<XmlElementRef> {
    table
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Element(row) if row.tag().as_ref() == "tableRow" => Some(row),
            _ => None,
        })
        .collect()
}

pub(super) fn cells_of(txn: &TransactionMut, row: &XmlElementRef) -> Vec<XmlElementRef> {
    row.children(txn)
        .filter_map(|child| match child {
            XmlOut::Element(cell) if matches!(cell.tag().as_ref(), "tableCell" | "tableHeader") => {
                Some(cell)
            }
            _ => None,
        })
        .collect()
}

/// The refusal for a row or column outside the table.
pub(super) fn out_of_range(table_id: &str, what: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: table_id.to_owned(),
        what: format!("this table has no such {what}"),
    }
}

pub(super) fn cell_at(
    txn: &mut TransactionMut,
    table_id: &str,
    row: u32,
    column: u32,
) -> Result<XmlElementRef, CrdtError> {
    let table = locate_table(txn, table_id)?;
    let rows = rows_of(txn, &table);
    let row = rows
        .get(row as usize)
        .ok_or_else(|| out_of_range(table_id, "row"))?
        .clone();
    let cells = cells_of(txn, &row);
    cells
        .get(column as usize)
        .cloned()
        .ok_or_else(|| out_of_range(table_id, "column"))
}

/// Builds an empty cell: `tableCell > tableParagraph`, which is the shape
/// BlockNote builds and the one y-prosemirror can construct.
pub(super) fn build_cell(
    txn: &mut TransactionMut,
    row: &XmlElementRef,
    index: u32,
) -> XmlElementRef {
    let cell = row.insert(txn, index, XmlElementPrelim::empty("tableCell"));
    for prop in node_shapes::cell_defaults() {
        cell.insert_attribute(txn, prop.name, prop.value.to_any());
    }
    cell.insert(txn, 0, XmlElementPrelim::empty("tableParagraph"));
    cell
}

/// A cell's `tableParagraph`, which is where its text lives.
pub(super) fn cell_paragraph(
    txn: &mut TransactionMut,
    cell: &XmlElementRef,
) -> Option<XmlElementRef> {
    cell.children(txn).find_map(|child| match child {
        XmlOut::Element(inner) if inner.tag().as_ref() == "tableParagraph" => Some(inner),
        _ => None,
    })
}

pub(super) fn set_cell_text(
    txn: &mut TransactionMut,
    table_id: &str,
    row: u32,
    column: u32,
    text: &str,
) -> Result<(), CrdtError> {
    let cell = cell_at(txn, table_id, row, column)?;
    let paragraph = match cell_paragraph(txn, &cell) {
        Some(paragraph) => paragraph,
        // A cell written by an older build with bare text and no paragraph.
        // Repaired rather than refused: the shape BlockNote needs is the one
        // worth converging on.
        None => cell.insert(txn, 0, XmlElementPrelim::empty("tableParagraph")),
    };
    replace_inline(txn, &paragraph, text);
    Ok(())
}

pub(super) fn set_cell_prop(
    txn: &mut TransactionMut,
    table_id: &str,
    row: u32,
    column: u32,
    name: &str,
    value: &str,
) -> Result<(), CrdtError> {
    let cell = cell_at(txn, table_id, row, column)?;
    // `colwidth` is an array of numbers, which is how prosemirror-tables
    // stores it and how desktop regenerates the `table-layout` marker.
    let typed = if name == "colwidth" {
        match value.parse::<f64>() {
            Ok(width) => Any::Array(vec![Any::Number(width)].into()),
            Err(_) => Any::Undefined,
        }
    } else {
        node_shapes::cell_defaults()
            .into_iter()
            .find(|prop| prop.name == name)
            .map(|prop| match prop.value {
                node_shapes::PropValue::Number(_) => value
                    .parse::<f64>()
                    .map(Any::Number)
                    .unwrap_or_else(|_| Any::String(value.into())),
                node_shapes::PropValue::Bool(_) => Any::Bool(value == "true"),
                _ => Any::String(value.into()),
            })
            .unwrap_or_else(|| Any::String(value.into()))
    };
    cell.insert_attribute(txn, name, typed);
    Ok(())
}

/// Ticks or unticks the `index`-th inline checkbox in one cell (N605).
///
/// The value is written as a **boolean**, not as text, for the reason N408
/// gives: a non-empty string is truthy, so an unticked box stored as
/// `"false"` reads as ticked by anything testing the prop for truth.
pub(super) fn set_cell_checkbox(
    txn: &mut TransactionMut,
    table_id: &str,
    row: u32,
    column: u32,
    index: u32,
    checked: bool,
) -> Result<(), CrdtError> {
    let cell = cell_at(txn, table_id, row, column)?;
    let paragraph = cell_paragraph(txn, &cell).ok_or_else(|| CrdtError::Undecodable {
        doc_id: table_id.to_owned(),
        what: "that cell holds no tableParagraph to look in".to_owned(),
    })?;

    let boxes: Vec<XmlElementRef> = paragraph
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Element(element) if element.tag().as_ref() == "inlineCheckbox" => Some(element),
            _ => None,
        })
        .collect();

    let target = boxes
        .get(index as usize)
        .ok_or_else(|| CrdtError::Undecodable {
            doc_id: table_id.to_owned(),
            what: "that cell has no such checkbox".to_owned(),
        })?;
    target.insert_attribute(txn, "checked", Any::Bool(checked));
    Ok(())
}

pub(super) fn insert_row(
    txn: &mut TransactionMut,
    table_id: &str,
    at: u32,
) -> Result<(), CrdtError> {
    let table = locate_table(txn, table_id)?;
    let rows = rows_of(txn, &table);
    // The column count comes from the first row, so a new row is never
    // ragged. A table with no rows yet gets one column to type into.
    let columns = rows
        .first()
        .map(|row| cells_of(txn, row).len())
        .unwrap_or(1)
        .max(1);

    let index = at.min(rows.len() as u32);
    // Rows sit among the table's children; the insert index is the position
    // of the row currently there, or the end.
    let position = match rows.get(index as usize) {
        Some(row) => child_index(txn, &table, row).unwrap_or_else(|| table.len(txn)),
        None => table.len(txn),
    };
    let row = table.insert(txn, position, XmlElementPrelim::empty("tableRow"));
    for column in 0..columns {
        build_cell(txn, &row, column as u32);
    }
    Ok(())
}

pub(super) fn delete_row(
    txn: &mut TransactionMut,
    table_id: &str,
    at: u32,
) -> Result<(), CrdtError> {
    let table = locate_table(txn, table_id)?;
    let rows = rows_of(txn, &table);
    let row = rows
        .get(at as usize)
        .ok_or_else(|| out_of_range(table_id, "row"))?;
    let index = child_index(txn, &table, row).ok_or_else(|| out_of_range(table_id, "row"))?;
    table.remove_range(txn, index, 1);
    Ok(())
}

pub(super) fn insert_column(
    txn: &mut TransactionMut,
    table_id: &str,
    at: u32,
) -> Result<(), CrdtError> {
    let table = locate_table(txn, table_id)?;
    for row in rows_of(txn, &table) {
        let cells = cells_of(txn, &row);
        let index = at.min(cells.len() as u32);
        let position = match cells.get(index as usize) {
            Some(cell) => child_index(txn, &row, cell).unwrap_or_else(|| row.len(txn)),
            None => row.len(txn),
        };
        build_cell(txn, &row, position);
    }
    Ok(())
}

pub(super) fn delete_column(
    txn: &mut TransactionMut,
    table_id: &str,
    at: u32,
) -> Result<(), CrdtError> {
    let table = locate_table(txn, table_id)?;
    let rows = rows_of(txn, &table);
    // Checked before anything is removed, so a bad index cannot leave the
    // table half-narrowed.
    if rows
        .iter()
        .all(|row| cells_of(txn, row).len() <= at as usize)
    {
        return Err(out_of_range(table_id, "column"));
    }
    for row in rows {
        let cells = cells_of(txn, &row);
        let Some(cell) = cells.get(at as usize) else {
            continue;
        };
        if let Some(index) = child_index(txn, &row, cell) {
            row.remove_range(txn, index, 1);
        }
    }
    Ok(())
}
