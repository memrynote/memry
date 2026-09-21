//! Editing a note body: the four changes an editor makes to a block.
//!
//! Reading a body became possible when `extract_blocks` landed. Writing one had
//! no path at all — the core could render a note and not change a word of it.
//!
//! **Every edit is a `Document::write`, never a diff.** Chapter 12 §12.5.1: the
//! update is what the transaction authored, not what a second copy of the
//! document turns out to differ by. A diff would re-send text nobody touched
//! and would lose the intent that makes a concurrent edit merge correctly.
//!
//! **A block is addressed by its `blockContainer` id**, which is what
//! `extract_blocks` hands the shell. An id that is not in the document is a
//! refusal rather than a no-op: an editor that believes it changed a block it
//! did not is how a keystroke disappears.
//!
//! **Text is replaced, not patched.** The first slice replaces a block's whole
//! inline content, which loses that block's marks — and says so in the error
//! type rather than quietly dropping bold from a line somebody edited. Nested
//! blocks under the container are untouched, because a list item's children are
//! their own blocks with their own ids.

use yrs::types::xml::XmlOut;
use yrs::{
    Any, GetString as _, ReadTxn as _, Text as _, TransactionMut, Xml as _, XmlElementPrelim,
    XmlElementRef, XmlFragment as _, XmlTextPrelim,
};

use crate::crdt::errors::CrdtError;
use crate::crdt::node_shapes;
use crate::crdt::{BODY_FRAGMENT, Document};

/// What an editor asks for.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum BlockEdit {
    /// Replaces a block's inline content with plain text.
    ///
    /// **Marks on that block are lost.** Keeping them means addressing runs
    /// rather than blocks, which the shell cannot do until it renders a
    /// selection; until then this is the honest shape, and a caller that did
    /// not want it can read the block first and decide.
    SetText {
        block_id: String,
        text: String,
    },
    /// Sets one attribute: `checked` on a check item, `level` on a heading,
    /// `language` on a code block, `type` on a callout.
    ///
    /// The value crosses as the string the document stores, because that is
    /// what the attribute is — the core does not know which props are numbers.
    SetProp {
        block_id: String,
        name: String,
        value: String,
    },
    /// Inserts a paragraph after `after_block_id`, or at the end of the body
    /// when it is `None`.
    InsertParagraph {
        after_block_id: Option<String>,
        text: String,
        /// The id the new block is given. Minted by the caller so the shell can
        /// place the caret in it without a second read.
        new_block_id: String,
    },
    /// Inserts any registry block type (N401).
    ///
    /// The node tree is built here, from the declared shape, because a node
    /// y-prosemirror cannot construct is **deleted silently** (§12.5.0). A
    /// `kind` this build cannot shape is refused rather than written bare.
    InsertBlock {
        kind: String,
        after_block_id: Option<String>,
        text: String,
        new_block_id: String,
    },
    /// Changes a block's type, carrying its inline content across (N405).
    TurnInto {
        block_id: String,
        kind: String,
    },
    /// Replaces one table cell's text (N402).
    ///
    /// **Addressed by position, not by id, and Q1 is why.** BlockNote builds
    /// a cell as `tableCell > tableParagraph` with no `blockContainer` and no
    /// id anywhere between, so there is nothing for `SetText` to find. A
    /// positional address is the only one available.
    SetCellText {
        table_id: String,
        row: u32,
        column: u32,
        text: String,
    },
    /// Sets one prop on one table cell (N404): its colours, its alignment, or
    /// its `colwidth`.
    SetCellProp {
        table_id: String,
        row: u32,
        column: u32,
        name: String,
        value: String,
    },
    /// Inserts a row (N403). `at` past the end appends.
    ///
    /// The new row takes its column count from the table's first row, so a
    /// table never gains a ragged row that desktop would render short.
    InsertRow {
        table_id: String,
        at: u32,
    },
    DeleteRow {
        table_id: String,
        at: u32,
    },
    /// Inserts a column (N403), preserving every surviving cell's `colwidth`
    /// and colours because those belong to the cells rather than to the
    /// column index.
    InsertColumn {
        table_id: String,
        at: u32,
    },
    DeleteColumn {
        table_id: String,
        at: u32,
    },
    /// Copies a block, and everything nested under it, directly after itself
    /// (N406).
    Duplicate {
        block_id: String,
        new_block_id: String,
    },
    /// Moves a block after another, or to the start of the body when
    /// `after_block_id` is `None` (N406).
    MoveBlock {
        block_id: String,
        after_block_id: Option<String>,
    },
    /// Nests a block under its previous sibling (N406).
    ///
    /// Desktop's rule, which this matches: a block with no previous sibling
    /// cannot indent, because there is nothing to nest under.
    Indent {
        block_id: String,
    },
    /// Lifts a block out to its parent's level (N406).
    Outdent {
        block_id: String,
    },
    /// Applies or removes an inline mark over a range within one block (N407).
    ///
    /// **This is what removes `SetText`'s documented limitation.** Replacing a
    /// block's whole text loses its marks; addressing a range keeps them, so
    /// a shell with a selection no longer has to choose between bold and
    /// editing.
    ///
    /// `value` carries a colour name for `textColor` and `backgroundColor`
    /// and an address for `link`; the boolean marks ignore it.
    SetMark {
        block_id: String,
        start: u32,
        end: u32,
        mark: String,
        value: Option<String>,
    },
    RemoveMark {
        block_id: String,
        start: u32,
        end: u32,
        mark: String,
    },
    /// Removes a block and everything nested under it.
    ///
    /// Its children go with it: they live inside its container, and leaving
    /// them behind would reparent a list's items to the body.
    Delete {
        block_id: String,
    },
}

/// Applies one edit to `document`.
///
/// The update the write authored reaches the registry's sink, which is what the
/// caller commits alongside its outbox row.
pub fn apply(document: &Document, edit: &BlockEdit) -> Result<(), CrdtError> {
    document.write(|txn| match edit {
        BlockEdit::SetText { block_id, text } => set_text(txn, block_id, text),
        BlockEdit::SetProp {
            block_id,
            name,
            value,
        } => set_prop(txn, block_id, name, value),
        BlockEdit::InsertParagraph {
            after_block_id,
            text,
            new_block_id,
        } => insert_block(
            txn,
            "paragraph",
            after_block_id.as_deref(),
            text,
            new_block_id,
        ),
        BlockEdit::InsertBlock {
            kind,
            after_block_id,
            text,
            new_block_id,
        } => insert_block(txn, kind, after_block_id.as_deref(), text, new_block_id),
        BlockEdit::TurnInto { block_id, kind } => turn_into(txn, block_id, kind),
        BlockEdit::SetCellText {
            table_id,
            row,
            column,
            text,
        } => set_cell_text(txn, table_id, *row, *column, text),
        BlockEdit::SetCellProp {
            table_id,
            row,
            column,
            name,
            value,
        } => set_cell_prop(txn, table_id, *row, *column, name, value),
        BlockEdit::InsertRow { table_id, at } => insert_row(txn, table_id, *at),
        BlockEdit::DeleteRow { table_id, at } => delete_row(txn, table_id, *at),
        BlockEdit::InsertColumn { table_id, at } => insert_column(txn, table_id, *at),
        BlockEdit::DeleteColumn { table_id, at } => delete_column(txn, table_id, *at),
        BlockEdit::Duplicate {
            block_id,
            new_block_id,
        } => duplicate(txn, block_id, new_block_id),
        BlockEdit::MoveBlock {
            block_id,
            after_block_id,
        } => move_block(txn, block_id, after_block_id.as_deref()),
        BlockEdit::Indent { block_id } => indent(txn, block_id),
        BlockEdit::Outdent { block_id } => outdent(txn, block_id),
        BlockEdit::SetMark {
            block_id,
            start,
            end,
            mark,
            value,
        } => set_mark(txn, block_id, *start, *end, mark, value.as_deref(), true),
        BlockEdit::RemoveMark {
            block_id,
            start,
            end,
            mark,
        } => set_mark(txn, block_id, *start, *end, mark, None, false),
        BlockEdit::Delete { block_id } => delete(txn, block_id),
    })?
}

/// The `blockContainer` carrying `id`, and the block element inside it.
///
/// Returns both because an edit needs one or the other: a prop and text belong
/// to the block, a delete belongs to the container.
fn locate(txn: &TransactionMut, id: &str) -> Option<(XmlElementRef, XmlElementRef)> {
    let fragment = txn.get_xml_fragment(BODY_FRAGMENT)?;
    let mut found = None;
    for child in fragment.children(txn) {
        if let XmlOut::Element(element) = child {
            found = descend(txn, &element, id);
            if found.is_some() {
                break;
            }
        }
    }
    found
}

fn descend(
    txn: &TransactionMut,
    element: &XmlElementRef,
    id: &str,
) -> Option<(XmlElementRef, XmlElementRef)> {
    let tag = element.tag().clone();
    let name: &str = tag.as_ref();
    if name == "blockContainer" && attribute(txn, element, "id").as_deref() == Some(id) {
        // The block is the container's first element child that is not the
        // `blockGroup` of its children.
        let block = element.children(txn).find_map(|child| match child {
            XmlOut::Element(inner) => {
                let inner_tag = inner.tag().clone();
                (inner_tag.as_ref() != "blockGroup").then_some(inner)
            }
            _ => None,
        })?;
        return Some((element.clone(), block));
    }
    for child in element.children(txn) {
        if let XmlOut::Element(inner) = child
            && let Some(found) = descend(txn, &inner, id)
        {
            return Some(found);
        }
    }
    None
}

fn attribute(txn: &TransactionMut, element: &XmlElementRef, name: &str) -> Option<String> {
    element
        .attributes(txn)
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string(txn))
}

/// The refusal for an id this body does not hold.
///
/// Not a storage failure and not a silent no-op: the shell believes it edited
/// that block, and it did not. `doc_id` is the block rather than the note
/// because the block is what was not found — the note was opened fine.
fn missing(id: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: id.to_owned(),
        what: "this body holds no such block".to_owned(),
    }
}

fn set_text(txn: &mut TransactionMut, block_id: &str, text: &str) -> Result<(), CrdtError> {
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let kind = block.tag().clone();
    // A task block's text is its `title` prop, not inline content, so writing
    // it as content would produce a node BlockNote renders empty.
    if let Some(name) = node_shapes::text_prop(kind.as_ref()) {
        block.insert_attribute(txn, name, text);
        return Ok(());
    }
    replace_inline(txn, &block, text);
    Ok(())
}

/// Replaces an element's inline content, keeping its nested blocks.
///
/// Every child that is content goes together: a block's inline content is
/// text *and* inline nodes, and replacing the text means replacing both. A
/// `blockGroup` child is the block's nested children and survives, or
/// retyping a list item would delete everything indented under it.
fn replace_inline(txn: &mut TransactionMut, element: &XmlElementRef, text: &str) {
    let mut removals = Vec::new();
    for (index, child) in element.children(txn).enumerate() {
        match child {
            XmlOut::Element(inner) if inner.tag().as_ref() == "blockGroup" => {}
            _ => removals.push(index as u32),
        }
    }
    // Back to front, so each index is still valid when it is reached.
    for index in removals.into_iter().rev() {
        element.remove_range(txn, index, 1);
    }
    if !text.is_empty() {
        element.insert(txn, 0, XmlTextPrelim::new(text));
    }
}

/// Sets one prop, **in its declared type** (N408).
///
/// The value crosses the FFI as text because a shell has one string field to
/// put it in, and it is converted here against the block's declared shape.
///
/// **This is not tidiness.** The reference writer stores `checked` as the
/// boolean `true`; storing the string `"true"` produces a document that reads
/// differently, because a non-empty string is truthy — so unticking a box,
/// written as `"false"`, reads as **ticked** anywhere the prop is tested for
/// truth. A prop whose declared type this build does not know is written as
/// text, which is the honest fallback for a schema that has moved on.
fn set_prop(
    txn: &mut TransactionMut,
    block_id: &str,
    name: &str,
    value: &str,
) -> Result<(), CrdtError> {
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let kind = block.tag().clone();
    block.insert_attribute(txn, name, typed_prop(kind.as_ref(), name, value));
    Ok(())
}

/// One prop value in the type its block declares for it.
fn typed_prop(kind: &str, name: &str, value: &str) -> Any {
    let declared = node_shapes::defaults_for(kind)
        .into_iter()
        .flatten()
        .find(|prop| prop.name == name)
        .map(|prop| prop.value);

    match declared {
        Some(node_shapes::PropValue::Bool(_)) => Any::Bool(value == "true"),
        Some(node_shapes::PropValue::Number(_)) => value
            .parse::<f64>()
            .map(Any::Number)
            .unwrap_or_else(|_| Any::String(value.into())),
        // `start` and `previewWidth` are declared undefined and take a real
        // value once set, so an empty string means "back to unset".
        Some(node_shapes::PropValue::Undefined) if value.is_empty() => Any::Undefined,
        Some(node_shapes::PropValue::Undefined) => value
            .parse::<f64>()
            .map(Any::Number)
            .unwrap_or_else(|_| Any::String(value.into())),
        _ => Any::String(value.into()),
    }
}

/// Changes a block's type while keeping what it says (N405).
///
/// Rebuilt rather than renamed, because a node's **tag is not editable** in
/// yrs and because the target type declares different props: a paragraph
/// turned into a heading needs a `level` it never had. The inline content is
/// carried across as text.
///
/// **The container and its id survive**, so every reference to this block —
/// a caret, a selection, a nested `blockGroup` of children — still resolves.
fn turn_into(txn: &mut TransactionMut, block_id: &str, kind: &str) -> Result<(), CrdtError> {
    let (container, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    if node_shapes::defaults_for(kind).is_none() {
        return Err(CrdtError::Undecodable {
            doc_id: kind.to_owned(),
            what: "this build does not know how to shape that block type".to_owned(),
        });
    }

    let carried = block_text(txn, &block);

    // The old block, and only it: a `blockGroup` of children is a sibling of
    // the block inside the container and must outlive the change, or turning
    // a list item into a paragraph would orphan everything nested under it.
    let index = container
        .children(txn)
        .position(|child| match child {
            XmlOut::Element(inner) => inner.tag().as_ref() != "blockGroup",
            _ => true,
        })
        .ok_or_else(|| missing(block_id))? as u32;
    container.remove_range(txn, index, 1);

    let defaults = node_shapes::defaults_for(kind).unwrap_or_default();
    let rebuilt = container.insert(txn, index, XmlElementPrelim::empty(kind));
    for prop in &defaults {
        rebuilt.insert_attribute(txn, prop.name, prop.value.to_any());
    }
    if !carried.is_empty() {
        if node_shapes::holds_inline(kind) {
            rebuilt.insert(txn, 0, XmlTextPrelim::new(&carried));
        } else if let Some(name) = node_shapes::text_prop(kind) {
            rebuilt.insert_attribute(txn, name, carried.as_str());
        }
    }
    Ok(())
}

/// A block's own text, from wherever that type keeps it.
fn block_text(txn: &TransactionMut, block: &XmlElementRef) -> String {
    let tag = block.tag().clone();
    if let Some(name) = node_shapes::text_prop(tag.as_ref()) {
        return attribute(txn, block, name).unwrap_or_default();
    }
    let mut out = String::new();
    for child in block.children(txn) {
        match child {
            XmlOut::Text(text) => out.push_str(&text.get_string(txn)),
            // A nested block is its own entry and must not be folded in.
            _ => continue,
        }
    }
    out
}

/// The `blockGroup` a new top-level block belongs in (§12.5.0).
///
/// **This is the function the chapter calls the single most dangerous thing a
/// writing client can get wrong.** The fragment's one top-level child is a
/// `blockGroup`; a `blockContainer` placed beside it is a second top-level
/// child, and a `doc` with two is not constructible, so y-prosemirror answers
/// by **deleting the element**. Nothing fails at any layer a naive writer can
/// see: the update applies, the document encodes, `extract_text` may still
/// return the text, and the block is simply gone the next time the note opens.
///
/// So a writer **locates** its parent rather than assuming one: it appends
/// inside the existing group, creates the group when the fragment is empty,
/// and **refuses** a top-level layout it does not recognise rather than
/// guessing. Refusing is correct because the alternatives are a deletion the
/// user never sees and a document a peer cannot construct.
fn block_group(txn: &mut TransactionMut) -> Result<XmlElementRef, CrdtError> {
    let fragment = txn
        .get_xml_fragment(BODY_FRAGMENT)
        .ok_or_else(|| unrecognised_layout("the body fragment is missing"))?;

    let children: Vec<XmlOut> = fragment.children(txn).collect();
    if children.is_empty() {
        return Ok(fragment.push_back(txn, XmlElementPrelim::empty("blockGroup")));
    }

    let mut group: Option<XmlElementRef> = None;
    for child in children {
        match child {
            XmlOut::Element(element) if element.tag().as_ref() == "blockGroup" => {
                if group.is_some() {
                    // Two groups is already a layout no BlockNote writer
                    // produces; appending into one of them would be a guess.
                    return Err(unrecognised_layout(
                        "the body has more than one top-level blockGroup",
                    ));
                }
                group = Some(element);
            }
            // A `blockContainer` or loose text directly under the fragment is
            // the shape §12.5.0 warns about. A writer that added to it would
            // be adding to a document a peer cannot construct.
            _ => {
                return Err(unrecognised_layout(
                    "the body's top level is not a single blockGroup",
                ));
            }
        }
    }

    group.ok_or_else(|| unrecognised_layout("the body has no top-level blockGroup"))
}

/// The refusal §12.5.0 demands for a layout this writer does not recognise.
fn unrecognised_layout(what: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: BODY_FRAGMENT.to_owned(),
        what: format!("refusing to write into a body whose shape is unrecognised: {what}"),
    }
}

/// Builds one block node, with its declared props (§12.5.0).
///
/// The props are written explicitly rather than omitted, because that is what
/// BlockNote's own writer does and a block missing them is not the same
/// document even though it renders identically.
fn build_block(
    txn: &mut TransactionMut,
    container: &XmlElementRef,
    kind: &str,
    text: &str,
) -> Result<XmlElementRef, CrdtError> {
    let defaults = node_shapes::defaults_for(kind).ok_or_else(|| CrdtError::Undecodable {
        doc_id: kind.to_owned(),
        what: "this build does not know how to shape that block type".to_owned(),
    })?;

    let block = container.insert(txn, 0, XmlElementPrelim::empty(kind));
    for prop in &defaults {
        block.insert_attribute(txn, prop.name, prop.value.to_any());
    }

    if !text.is_empty() {
        if node_shapes::holds_inline(kind) {
            block.insert(txn, 0, XmlTextPrelim::new(text));
        } else if let Some(name) = node_shapes::text_prop(kind) {
            // A task block's text is a prop, not inline content.
            block.insert_attribute(txn, name, text);
        }
        // A type that holds neither drops the text rather than inventing a
        // place for it: a divider with a caption is not a thing.
    }
    Ok(block)
}

fn insert_block(
    txn: &mut TransactionMut,
    kind: &str,
    after_block_id: Option<&str>,
    text: &str,
    new_block_id: &str,
) -> Result<(), CrdtError> {
    let prelim = XmlElementPrelim::empty("blockContainer");
    let (parent, index) = match after_block_id {
        Some(id) => {
            let (container, _) = locate(txn, id).ok_or_else(|| missing(id))?;
            let parent = container
                .parent()
                .and_then(|parent| match parent {
                    XmlOut::Element(element) => Some(element),
                    _ => None,
                })
                .ok_or_else(|| missing(id))?;
            let position = parent
                .children(txn)
                .position(|child| match child {
                    XmlOut::Element(element) => {
                        attribute(txn, &element, "id").as_deref() == Some(id)
                    }
                    _ => false,
                })
                .ok_or_else(|| missing(id))?;
            (parent, position as u32 + 1)
        }
        None => {
            // The end of the body — **inside the blockGroup**, never beside it.
            let group = block_group(txn)?;
            let index = group.children(txn).count() as u32;
            (group, index)
        }
    };

    let container = parent.insert(txn, index, prelim);
    container.insert_attribute(txn, "id", new_block_id);
    build_block(txn, &container, kind, text)?;
    Ok(())
}

// MARK: - Tables (N402, N403, N404)

/// The `table` element under the container carrying `id`.
fn locate_table(txn: &mut TransactionMut, table_id: &str) -> Result<XmlElementRef, CrdtError> {
    let (_, block) = locate(txn, table_id).ok_or_else(|| missing(table_id))?;
    if block.tag().as_ref() != "table" {
        return Err(CrdtError::Undecodable {
            doc_id: table_id.to_owned(),
            what: "that block is not a table".to_owned(),
        });
    }
    Ok(block)
}

fn rows_of(txn: &TransactionMut, table: &XmlElementRef) -> Vec<XmlElementRef> {
    table
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Element(row) if row.tag().as_ref() == "tableRow" => Some(row),
            _ => None,
        })
        .collect()
}

fn cells_of(txn: &TransactionMut, row: &XmlElementRef) -> Vec<XmlElementRef> {
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
fn out_of_range(table_id: &str, what: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: table_id.to_owned(),
        what: format!("this table has no such {what}"),
    }
}

fn cell_at(
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
fn build_cell(txn: &mut TransactionMut, row: &XmlElementRef, index: u32) -> XmlElementRef {
    let cell = row.insert(txn, index, XmlElementPrelim::empty("tableCell"));
    for prop in node_shapes::cell_defaults() {
        cell.insert_attribute(txn, prop.name, prop.value.to_any());
    }
    cell.insert(txn, 0, XmlElementPrelim::empty("tableParagraph"));
    cell
}

/// A cell's `tableParagraph`, which is where its text lives.
fn cell_paragraph(txn: &mut TransactionMut, cell: &XmlElementRef) -> Option<XmlElementRef> {
    cell.children(txn).find_map(|child| match child {
        XmlOut::Element(inner) if inner.tag().as_ref() == "tableParagraph" => Some(inner),
        _ => None,
    })
}

fn set_cell_text(
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

fn set_cell_prop(
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

fn insert_row(txn: &mut TransactionMut, table_id: &str, at: u32) -> Result<(), CrdtError> {
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

fn delete_row(txn: &mut TransactionMut, table_id: &str, at: u32) -> Result<(), CrdtError> {
    let table = locate_table(txn, table_id)?;
    let rows = rows_of(txn, &table);
    let row = rows
        .get(at as usize)
        .ok_or_else(|| out_of_range(table_id, "row"))?;
    let index = child_index(txn, &table, row).ok_or_else(|| out_of_range(table_id, "row"))?;
    table.remove_range(txn, index, 1);
    Ok(())
}

fn insert_column(txn: &mut TransactionMut, table_id: &str, at: u32) -> Result<(), CrdtError> {
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

fn delete_column(txn: &mut TransactionMut, table_id: &str, at: u32) -> Result<(), CrdtError> {
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

/// Where `child` sits among `parent`'s children.
fn child_index(txn: &TransactionMut, parent: &XmlElementRef, child: &XmlElementRef) -> Option<u32> {
    parent
        .children(txn)
        .position(|candidate| match candidate {
            XmlOut::Element(element) => element == *child,
            _ => false,
        })
        .map(|index| index as u32)
}

// MARK: - Moving blocks (N406)

/// The container's parent, which is a `blockGroup` for every real block.
fn parent_of(container: &XmlElementRef) -> Option<XmlElementRef> {
    match container.parent() {
        Some(XmlOut::Element(element)) => Some(element),
        _ => None,
    }
}

fn duplicate(
    txn: &mut TransactionMut,
    block_id: &str,
    new_block_id: &str,
) -> Result<(), CrdtError> {
    let (container, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let parent = parent_of(&container).ok_or_else(|| missing(block_id))?;
    let index = child_index(txn, &parent, &container).ok_or_else(|| missing(block_id))?;

    let kind = block.tag().clone();
    let text = block_text(txn, &block);
    let props: Vec<(String, Any)> = block
        .attributes(txn)
        .map(|(name, value)| (name.to_owned(), any_of(value, txn)))
        .collect();

    let copy = parent.insert(txn, index + 1, XmlElementPrelim::empty("blockContainer"));
    copy.insert_attribute(txn, "id", new_block_id);
    let rebuilt = copy.insert(txn, 0, XmlElementPrelim::empty(kind.as_ref()));
    // The original's props, not the type's defaults: a duplicate of a red
    // heading is a red heading.
    for (name, value) in props {
        rebuilt.insert_attribute(txn, name.as_str(), value);
    }
    if !text.is_empty() && node_shapes::holds_inline(kind.as_ref()) {
        rebuilt.insert(txn, 0, XmlTextPrelim::new(&text));
    }
    Ok(())
}

/// An attribute value as an [`Any`], so a copy keeps its declared types.
fn any_of(value: yrs::Out, txn: &TransactionMut) -> Any {
    match value {
        yrs::Out::Any(any) => any,
        other => Any::String(other.to_string(txn).into()),
    }
}

fn move_block(
    txn: &mut TransactionMut,
    block_id: &str,
    after_block_id: Option<&str>,
) -> Result<(), CrdtError> {
    if after_block_id == Some(block_id) {
        // Moving a block after itself is a no-op, and treating it as one is
        // better than a delete-and-reinsert that churns the document.
        return Ok(());
    }

    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let snapshot = snapshot_subtree(txn, &container);

    let (target_parent, target_index) = match after_block_id {
        Some(id) => {
            let (anchor, _) = locate(txn, id).ok_or_else(|| missing(id))?;
            let parent = parent_of(&anchor).ok_or_else(|| missing(id))?;
            let index = child_index(txn, &parent, &anchor).ok_or_else(|| missing(id))?;
            (parent, index + 1)
        }
        None => (block_group(txn)?, 0),
    };

    // Removed first, so the insert index is computed against the document the
    // block will actually land in.
    let source_parent = parent_of(&container).ok_or_else(|| missing(block_id))?;
    let source_index =
        child_index(txn, &source_parent, &container).ok_or_else(|| missing(block_id))?;
    let adjusted = if source_parent == target_parent && source_index < target_index {
        target_index - 1
    } else {
        target_index
    };
    source_parent.remove_range(txn, source_index, 1);
    restore_subtree(txn, &target_parent, adjusted, &snapshot);
    Ok(())
}

fn indent(txn: &mut TransactionMut, block_id: &str) -> Result<(), CrdtError> {
    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let parent = parent_of(&container).ok_or_else(|| missing(block_id))?;
    let index = child_index(txn, &parent, &container).ok_or_else(|| missing(block_id))?;
    if index == 0 {
        // Desktop's rule: there is nothing to nest under.
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "a block with no previous sibling cannot be indented".to_owned(),
        });
    }

    let previous = match parent.get(txn, index - 1) {
        Some(XmlOut::Element(element)) => element,
        _ => return Err(missing(block_id)),
    };
    // The sibling's own block is its first non-group child; the group of its
    // children is where this block goes.
    let group = child_block_group(txn, &previous)
        .unwrap_or_else(|| previous.push_back(txn, XmlElementPrelim::empty("blockGroup")));

    let snapshot = snapshot_subtree(txn, &container);
    parent.remove_range(txn, index, 1);
    let at = group.len(txn);
    restore_subtree(txn, &group, at, &snapshot);
    Ok(())
}

fn outdent(txn: &mut TransactionMut, block_id: &str) -> Result<(), CrdtError> {
    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let group = parent_of(&container).ok_or_else(|| missing(block_id))?;
    // The group's parent is the container this block is nested inside. A block
    // already at the top has the fragment's own group as its parent, whose
    // parent is not a container, so there is nothing to lift to.
    let grandparent = parent_of(&group).ok_or_else(|| CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: "a top-level block cannot be outdented".to_owned(),
    })?;
    let outer = parent_of(&grandparent).ok_or_else(|| CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: "a top-level block cannot be outdented".to_owned(),
    })?;
    let anchor = child_index(txn, &outer, &grandparent).ok_or_else(|| missing(block_id))?;

    let index = child_index(txn, &group, &container).ok_or_else(|| missing(block_id))?;
    let snapshot = snapshot_subtree(txn, &container);
    group.remove_range(txn, index, 1);
    restore_subtree(txn, &outer, anchor + 1, &snapshot);
    Ok(())
}

/// A block's own `blockGroup` of children, if it has one.
fn child_block_group(txn: &TransactionMut, container: &XmlElementRef) -> Option<XmlElementRef> {
    container.children(txn).find_map(|child| match child {
        XmlOut::Element(inner) if inner.tag().as_ref() == "blockGroup" => Some(inner),
        _ => None,
    })
}

/// A container and everything under it, as plain data.
///
/// yrs has no move, so a relocation is a remove and a rebuild. **This is not
/// the whole-fragment replace §12.5.0.1 forbids**: that rule is about
/// re-seeding a document's entire contents from an external source, where a
/// concurrent edit to the old contents merges into tombstones and disappears.
/// This moves one subtree the user is holding, which is the operation they
/// asked for, and leaves every other block's identity untouched.
#[derive(Debug, Clone)]
struct Subtree {
    tag: String,
    props: Vec<(String, Any)>,
    text: String,
    children: Vec<Subtree>,
}

fn snapshot_subtree(txn: &TransactionMut, element: &XmlElementRef) -> Subtree {
    let tag = element.tag().clone();
    let mut text = String::new();
    let mut children = Vec::new();
    for child in element.children(txn) {
        match child {
            XmlOut::Text(value) => text.push_str(&value.get_string(txn)),
            XmlOut::Element(inner) => children.push(snapshot_subtree(txn, &inner)),
            XmlOut::Fragment(_) => {}
        }
    }
    Subtree {
        tag: tag.as_ref().to_owned(),
        props: element
            .attributes(txn)
            .map(|(name, value)| (name.to_owned(), any_of(value, txn)))
            .collect(),
        text,
        children,
    }
}

fn restore_subtree(
    txn: &mut TransactionMut,
    parent: &XmlElementRef,
    index: u32,
    subtree: &Subtree,
) {
    let element = parent.insert(txn, index, XmlElementPrelim::empty(subtree.tag.as_str()));
    for (name, value) in &subtree.props {
        element.insert_attribute(txn, name.as_str(), value.clone());
    }
    if !subtree.text.is_empty() {
        element.insert(txn, 0, XmlTextPrelim::new(&subtree.text));
    }
    let mut at = element.len(txn);
    for child in &subtree.children {
        restore_subtree(txn, &element, at, child);
        at = element.len(txn);
    }
}

// MARK: - Inline marks (N407)

/// Applies or removes a mark over a range inside one block.
///
/// **This is what removes `SetText`'s documented limitation.** Replacing a
/// block's whole text loses its marks; a range keeps every run outside it, so
/// a shell with a selection no longer has to choose between formatting and
/// editing.
///
/// The attribute shape is y-prosemirror's: a mark's value is its `attrs`
/// object, and BlockNote wraps a string style's value in `stringValue`.
/// Removing is `Any::Null`, which is how yrs deletes a formatting attribute.
fn set_mark(
    txn: &mut TransactionMut,
    block_id: &str,
    start: u32,
    end: u32,
    mark: &str,
    value: Option<&str>,
    apply: bool,
) -> Result<(), CrdtError> {
    if end <= start {
        // An empty range formats nothing. Refused rather than silently doing
        // nothing, because a caller that computed it wrongly should hear so.
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "a mark needs a non-empty range".to_owned(),
        });
    }
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let text = block
        .children(txn)
        .find_map(|child| match child {
            XmlOut::Text(value) => Some(value),
            _ => None,
        })
        .ok_or_else(|| CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "that block holds no text to mark".to_owned(),
        })?;

    let attribute = if !apply {
        Any::Null
    } else {
        match value {
            Some(value) => {
                let mut attrs = std::collections::HashMap::new();
                // `link` names its address `href`; every string style wraps
                // its value in `stringValue`.
                let key = if mark == "link" {
                    "href"
                } else {
                    "stringValue"
                };
                attrs.insert(key.to_owned(), Any::String(value.into()));
                Any::Map(attrs.into())
            }
            // A boolean style carries an empty attribute object.
            None => Any::Map(std::collections::HashMap::new().into()),
        }
    };

    let length = text.len(txn);
    if start >= length {
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "that range starts past the end of the block".to_owned(),
        });
    }
    let end = end.min(length);
    text.format(txn, start, end - start, [(mark.into(), attribute)].into());
    Ok(())
}

fn delete(txn: &mut TransactionMut, block_id: &str) -> Result<(), CrdtError> {
    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let parent = container.parent();
    match parent {
        Some(XmlOut::Element(element)) => {
            let index = element
                .children(txn)
                .position(|child| match child {
                    XmlOut::Element(inner) => {
                        attribute(txn, &inner, "id").as_deref() == Some(block_id)
                    }
                    _ => false,
                })
                .ok_or_else(|| missing(block_id))? as u32;
            element.remove_range(txn, index, 1);
        }
        _ => {
            let fragment = txn
                .get_xml_fragment(BODY_FRAGMENT)
                .ok_or_else(|| missing(block_id))?;
            let index = fragment
                .children(txn)
                .position(|child| match child {
                    XmlOut::Element(inner) => {
                        attribute(txn, &inner, "id").as_deref() == Some(block_id)
                    }
                    _ => false,
                })
                .ok_or_else(|| missing(block_id))? as u32;
            fragment.remove_range(txn, index, 1);
        }
    }
    Ok(())
}
