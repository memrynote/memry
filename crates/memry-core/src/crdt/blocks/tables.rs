//! Split from `blocks.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;

/// The `table` element under the `blockContainer` carrying `id`.
pub(super) fn find_table<F, T>(node: &F, txn: &T, id: &str) -> Option<XmlElementRef>
where
    F: XmlFragment,
    T: ReadTxn,
{
    for child in node.children(txn) {
        let XmlOut::Element(element) = child else {
            continue;
        };
        let tag = element.tag().clone();
        if tag.as_ref() == "blockContainer" && attribute(&element, txn, "id").as_deref() == Some(id)
        {
            return element.children(txn).find_map(|inner| match inner {
                XmlOut::Element(block) if block.tag().as_ref() == "table" => Some(block),
                _ => None,
            });
        }
        if let Some(found) = find_table(&element, txn, id) {
            return Some(found);
        }
    }
    None
}

pub(super) fn table_content<T: ReadTxn>(
    table: &XmlElementRef,
    txn: &T,
    block_id: &str,
) -> TableContent {
    let mut rows: Vec<TableRow> = Vec::new();
    for child in table.children(txn) {
        let XmlOut::Element(element) = child else {
            continue;
        };
        if element.tag().as_ref() != "tableRow" {
            continue;
        }
        let cells = element
            .children(txn)
            .filter_map(|cell| match cell {
                XmlOut::Element(cell) => Some(table_cell(&cell, txn)),
                _ => None,
            })
            .collect();
        rows.push(TableRow { cells });
    }

    // BlockNote reads the column widths off the first row alone, spanning
    // cells contributing one entry per column they cover.
    let column_widths = rows
        .first()
        .map(|row| {
            row.cells
                .iter()
                .flat_map(|cell| {
                    if cell.colwidth.is_empty() {
                        vec![None; cell.colspan.max(1) as usize]
                    } else {
                        cell.colwidth.clone()
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // Counted the way BlockNote counts them: every row all of whose cells are
    // headers, and every column all of whose cells are, not only the leading
    // ones. Reproducing the derivation rather than inventing a stricter one
    // keeps the two surfaces saying the same thing about the same table.
    let header_rows = rows
        .iter()
        .filter(|row| !row.cells.is_empty() && row.cells.iter().all(|cell| cell.is_header))
        .count() as u32;
    let columns = rows.first().map(|row| row.cells.len()).unwrap_or(0);
    let header_cols = (0..columns)
        .filter(|column| {
            !rows.is_empty()
                && rows
                    .iter()
                    .all(|row| row.cells.get(*column).is_some_and(|cell| cell.is_header))
        })
        .count() as u32;

    TableContent {
        block_id: Some(block_id.to_owned()),
        column_widths,
        header_rows,
        header_cols,
        rows,
    }
}

pub(super) fn table_cell<T: ReadTxn>(cell: &XmlElementRef, txn: &T) -> TableCell {
    let tag = cell.tag().clone();
    let mut content = Vec::new();
    for child in cell.children(txn) {
        match child {
            XmlOut::Element(inner) => walk_element(&inner, txn, 0, &mut content, false),
            XmlOut::Text(text) => {
                let runs = runs_of_text(&text, txn);
                if runs.iter().any(|run| !run.text.is_empty()) {
                    content.push(Block {
                        id: None,
                        kind: "tableParagraph".to_owned(),
                        depth: 0,
                        props: Vec::new(),
                        inline: runs,
                    });
                }
            }
            XmlOut::Fragment(_) => {}
        }
    }

    TableCell {
        // Not minted, and not derived from the position: "this cell has no id"
        // is the true answer, and a handle no edit could resolve is worse than
        // none (see the field's own note).
        block_id: attribute(cell, txn, "id"),
        is_header: tag.as_ref() == "tableHeader",
        colspan: span(cell, txn, "colspan"),
        rowspan: span(cell, txn, "rowspan"),
        background_color: attribute(cell, txn, "backgroundColor"),
        text_color: attribute(cell, txn, "textColor"),
        text_alignment: attribute(cell, txn, "textAlignment"),
        colwidth: colwidth(cell, txn),
        content,
    }
}

/// `colspan` or `rowspan`, defaulting to 1 — which is what an absent attribute
/// means, and what BlockNote's own default is.
pub(super) fn span<T: ReadTxn>(cell: &XmlElementRef, txn: &T, name: &str) -> u32 {
    match cell.get_attribute(txn, name) {
        Some(Out::Any(Any::Number(value))) if value >= 1.0 => value as u32,
        Some(other) => other.to_string(txn).parse::<u32>().unwrap_or(1).max(1),
        None => 1,
    }
}

/// A cell's `colwidth`, which the document stores as an **array** — one entry
/// per column the cell spans, holding `undefined` for a column nobody has
/// resized.
pub(super) fn colwidth<T: ReadTxn>(cell: &XmlElementRef, txn: &T) -> Vec<Option<f64>> {
    match cell.get_attribute(txn, "colwidth") {
        Some(Out::Any(Any::Array(values))) => values.iter().map(number).collect(),
        Some(Out::Any(single)) => vec![number(&single)],
        _ => Vec::new(),
    }
}

pub(super) fn number(value: &Any) -> Option<f64> {
    match value {
        Any::Number(value) => Some(*value),
        Any::BigInt(value) => Some(*value as f64),
        Any::String(text) => text.parse().ok(),
        _ => None,
    }
}
