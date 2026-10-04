//! Side-by-side columns (chapter 12 §12.9): `columnList > column > blockContainer`.
//!
//! **The schema these edits must never break.** `columnList` is `column
//! column+` and `column` is `blockContainer+`. A node y-prosemirror cannot
//! build is deleted (§12.5.0), and a deleted `columnList` takes every block of
//! every column with it, so an edit that leaves one column in a list, or an
//! empty column, loses data on the next peer that opens the note. Every
//! structural edit therefore settles its source with [`settle_after_removal`].
//!
//! **Neither row is a block an edit addresses.** Both carry an `id`, but no
//! text, no marks and no props an editor sets. A text, mark, prop, turn-into,
//! duplicate, indent or outdent edit naming one is refused with
//! [`column_layout_refusal`] rather than reported as a missing block, so a
//! shell can tell "that id is a column" from "that id is gone". A `columnList`
//! may be deleted, moved, and used as the anchor an insert or move lands
//! after; a `column` may be none of those, because the only place "after a
//! column" exists is inside its list, where nothing but another column fits.
//!
//! **Why an emptied column is removed rather than the edit refused.** Desktop
//! (BlockNote's `fixColumnList`) removes a column its last block left and
//! unwraps a list left with one column, so the remaining column's blocks
//! become siblings where the list stood. Refusing instead would leave a phone
//! unable to delete the last line of a column, which desktop allows; keeping a
//! one-column list or an empty column writes the invalid node above. The
//! unwrap rebuilds the surviving blocks (yrs has no move), with their ids,
//! props, marks and nested blocks, exactly as a move does; a peer's
//! concurrent typing inside those blocks merges into the removed copies, the
//! same cost desktop's own unwrap pays.

#[allow(unused_imports)]
use super::*;

pub(super) const COLUMN_LIST: &str = "columnList";
pub(super) const COLUMN: &str = "column";

/// Column counts [`BlockEdit::InsertColumnList`] builds: desktop's
/// "Two columns" and "Three columns".
pub(super) const COLUMN_COUNTS: std::ops::RangeInclusive<u32> = 2..=3;

/// The refusal for an edit that targets a column layout row, or that would
/// build an invalid column layout. `Undecodable`, as every other `body_edit`
/// refusal is, with `what` naming the column layout.
pub(super) fn column_layout_refusal(id: &str, what: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: id.to_owned(),
        what: format!("column layout: {what}"),
    }
}

/// The first element under the body whose tag is one of `tags` and whose `id`
/// is `id`.
fn find_tagged(txn: &TransactionMut, id: &str, tags: &[&str]) -> Option<XmlElementRef> {
    fn descend(
        txn: &TransactionMut,
        element: &XmlElementRef,
        id: &str,
        tags: &[&str],
    ) -> Option<XmlElementRef> {
        if tags.contains(&element.tag().as_ref())
            && attribute(txn, element, "id").as_deref() == Some(id)
        {
            return Some(element.clone());
        }
        element.children(txn).find_map(|child| match child {
            XmlOut::Element(inner) => descend(txn, &inner, id, tags),
            _ => None,
        })
    }
    let fragment = txn.get_xml_fragment(BODY_FRAGMENT)?;
    fragment.children(txn).find_map(|child| match child {
        XmlOut::Element(element) => descend(txn, &element, id, tags),
        _ => None,
    })
}

/// The `columnList` or `column` carrying `id`.
pub(super) fn locate_layout(txn: &TransactionMut, id: &str) -> Option<XmlElementRef> {
    find_tagged(txn, id, &[COLUMN_LIST, COLUMN])
}

/// A row a blockGroup holds: the `blockContainer` or `columnList` carrying
/// `id`. What a delete, a move and an insert anchor address.
pub(super) fn locate_row(txn: &TransactionMut, id: &str) -> Option<XmlElementRef> {
    find_tagged(txn, id, &["blockContainer", COLUMN_LIST])
}

/// `true` when `element` is `ancestor` or sits anywhere under it.
pub(super) fn is_within(element: &XmlElementRef, ancestor: &XmlElementRef) -> bool {
    let mut current = Some(element.clone());
    while let Some(node) = current {
        if node == *ancestor {
            return true;
        }
        current = parent_of(&node);
    }
    false
}

/// The edit's refusal when it names a column layout row it cannot apply to,
/// checked before anything is written.
pub(super) fn guard_column_layout(txn: &TransactionMut, edit: &BlockEdit) -> Result<(), CrdtError> {
    // Ids that must name a block: any column layout row is refused.
    let block_only: Option<&str> = match edit {
        BlockEdit::SetText { block_id, .. }
        | BlockEdit::ReplaceText { block_id, .. }
        | BlockEdit::SetProp { block_id, .. }
        | BlockEdit::TurnInto { block_id, .. }
        | BlockEdit::InsertInline { block_id, .. }
        | BlockEdit::SetMark { block_id, .. }
        | BlockEdit::RemoveMark { block_id, .. }
        | BlockEdit::Duplicate { block_id, .. }
        | BlockEdit::Indent { block_id }
        | BlockEdit::Outdent { block_id } => Some(block_id),
        BlockEdit::SetCellText { table_id, .. }
        | BlockEdit::SetCellProp { table_id, .. }
        | BlockEdit::SetCellCheckbox { table_id, .. }
        | BlockEdit::InsertRow { table_id, .. }
        | BlockEdit::DeleteRow { table_id, .. }
        | BlockEdit::InsertColumn { table_id, .. }
        | BlockEdit::DeleteColumn { table_id, .. } => Some(table_id),
        _ => None,
    };
    if let Some(id) = block_only
        && locate(txn, id).is_none()
        && let Some(row) = locate_layout(txn, id)
    {
        return Err(column_layout_refusal(
            id,
            &format!(
                "a {} has no text, marks or props an edit sets",
                row.tag().as_ref()
            ),
        ));
    }

    // Ids a `columnList` may fill but a `column` may not.
    let rows: [Option<&str>; 2] = match edit {
        BlockEdit::Delete { block_id } => [Some(block_id), None],
        BlockEdit::MoveBlock {
            block_id,
            after_block_id,
        } => [Some(block_id), after_block_id.as_deref()],
        BlockEdit::InsertParagraph { after_block_id, .. }
        | BlockEdit::InsertBlock { after_block_id, .. }
        | BlockEdit::InsertColumnList { after_block_id, .. } => [after_block_id.as_deref(), None],
        _ => [None, None],
    };
    for id in rows.into_iter().flatten() {
        if let Some(row) = locate_layout(txn, id)
            && row.tag().as_ref() == COLUMN
        {
            return Err(column_layout_refusal(
                id,
                "a column is addressed through its blocks or its column list, not on its own",
            ));
        }
    }

    // Kinds no block may become: a column layout is built whole, by
    // `InsertColumnList`, never as one node inside a blockContainer.
    let kind = match edit {
        BlockEdit::InsertBlock { kind, .. } | BlockEdit::TurnInto { kind, .. } => Some(kind),
        _ => None,
    };
    if let Some(kind) = kind
        && (kind == COLUMN_LIST || kind == COLUMN)
    {
        return Err(column_layout_refusal(
            kind,
            "a column layout is inserted with InsertColumnList, not as a block type",
        ));
    }
    Ok(())
}

/// Restores `parent`'s validity after a row left it: an emptied nested
/// `blockGroup` is dropped, an emptied `column` is removed, and a `columnList`
/// left with one column is unwrapped (see the module docs).
pub(super) fn settle_after_removal(txn: &mut TransactionMut, parent: &XmlElementRef) {
    match parent.tag().as_ref() {
        "blockGroup" => drop_if_empty(txn, parent),
        COLUMN => {
            if parent.len(txn) > 0 {
                return;
            }
            let Some(list) = parent_of(parent) else {
                return;
            };
            if let Some(index) = child_index(txn, &list, parent) {
                list.remove_range(txn, index, 1);
            }
            if list.tag().as_ref() == COLUMN_LIST {
                unwrap_if_single(txn, &list);
            }
        }
        _ => {}
    }
}

/// Replaces a `columnList` holding fewer than two columns with the blocks of
/// the one it has, in its place and in their order.
fn unwrap_if_single(txn: &mut TransactionMut, list: &XmlElementRef) {
    let columns: Vec<XmlElementRef> = list
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Element(element) => Some(element),
            _ => None,
        })
        .collect();
    if columns.len() >= 2 {
        return;
    }
    let Some(outer) = parent_of(list) else {
        return;
    };
    let Some(at) = child_index(txn, &outer, list) else {
        return;
    };
    let rows: Vec<Subtree> = columns
        .iter()
        .flat_map(|column| {
            column
                .children(txn)
                .filter_map(|child| match child {
                    XmlOut::Element(row) => Some(snapshot_subtree(txn, &row)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .collect();
    outer.remove_range(txn, at, 1);
    for (offset, row) in rows.iter().enumerate() {
        restore_subtree(txn, &outer, at + offset as u32, row);
    }
    if rows.is_empty() {
        drop_if_empty(txn, &outer);
    }
}

/// Builds a `columnList` of `columns` equal columns, each holding one empty
/// paragraph, after `after_block_id` or at the start of the body. See
/// [`BlockEdit::InsertColumnList`].
pub(super) fn insert_column_list(
    txn: &mut TransactionMut,
    after_block_id: Option<&str>,
    columns: u32,
    new_block_id: &str,
) -> Result<(), CrdtError> {
    if !COLUMN_COUNTS.contains(&columns) {
        return Err(column_layout_refusal(
            new_block_id,
            &format!(
                "a column list holds {} to {} columns, not {columns}",
                COLUMN_COUNTS.start(),
                COLUMN_COUNTS.end()
            ),
        ));
    }
    let (group, index) = match after_block_id {
        Some(id) => {
            // Desktop reads and writes a column region only at the top level
            // of a note (an MCM region does not nest, and a column cannot
            // hold a column list), so an anchor inside a column or a nested
            // block lands the list after the top-level row that holds it.
            let mut anchor = locate_row(txn, id).ok_or_else(|| missing(id))?;
            let group = loop {
                let parent = parent_of(&anchor).ok_or_else(|| missing(id))?;
                if is_top_level_group(&parent) {
                    break parent;
                }
                anchor = parent;
            };
            let index = child_index(txn, &group, &anchor).ok_or_else(|| missing(id))?;
            (group, index + 1)
        }
        None => (block_group(txn)?, 0),
    };

    let list = group.insert(txn, index, XmlElementPrelim::empty(COLUMN_LIST));
    list.insert_attribute(txn, "id", new_block_id);
    list.insert_attribute(txn, "regionId", "");
    list.insert_attribute(txn, "settings", "");
    for position in 0..columns {
        let column = list.insert(txn, position, XmlElementPrelim::empty(COLUMN));
        column.insert_attribute(txn, "id", new_block_id_string());
        column.insert_attribute(txn, "width", Any::Number(1.0));
        let container = column.insert(txn, 0, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(txn, "id", new_block_id_string());
        build_block(txn, &container, "paragraph", "")?;
    }
    Ok(())
}

fn new_block_id_string() -> String {
    structure::new_block_id()
}

/// `true` for the body's own top-level `blockGroup`, whose parent is the
/// fragment rather than an element.
pub(super) fn is_top_level_group(group: &XmlElementRef) -> bool {
    group.tag().as_ref() == "blockGroup" && parent_of(group).is_none()
}
