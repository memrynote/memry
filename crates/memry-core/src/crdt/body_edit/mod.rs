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

use std::collections::HashMap;

use yrs::types::xml::XmlOut;
use yrs::{
    Any, GetString as _, ReadTxn, Text as _, TransactionMut, Xml as _, XmlElementPrelim,
    XmlElementRef, XmlFragment as _, XmlTextPrelim, XmlTextRef,
};

use crate::crdt::errors::CrdtError;
use crate::crdt::node_shapes;
use crate::crdt::{BODY_FRAGMENT, Document};

mod inline;
mod structure;
mod tables;
mod text;

use inline::*;
use structure::*;
use tables::*;
use text::*;

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
    /// Ticks or unticks one `inlineCheckbox` inside a table cell (N605).
    ///
    /// **Addressed by position within the cell**, because an inline checkbox
    /// has no id of its own — it is an inline node inside the cell's
    /// `tableParagraph`, not a block (§12.7.1). `index` counts the checkboxes
    /// in that cell, so a cell holding two has 0 and 1.
    ///
    /// A cell cannot hold a `checkListItem` block, which is why this exists
    /// at all: the inline form is the only ticking a table supports.
    SetCellCheckbox {
        table_id: String,
        row: u32,
        column: u32,
        index: u32,
        checked: bool,
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
    /// Replaces a range of one block's text with an **inline node** (N601,
    /// N602, N603).
    ///
    /// This is how a mention, a wiki link and a date reach the document:
    /// y-prosemirror carries an inline node as an `XmlElement` **sibling** of
    /// the block's text, not as a mark, so `SetMark` cannot make one.
    ///
    /// `start == end` inserts at the caret without removing anything.
    ///
    /// **The marks on the text after the insertion point are preserved**,
    /// which is the whole difficulty: splitting a run means rebuilding its
    /// tail, and a naive rebuild would drop the bold the user already had.
    InsertInline {
        block_id: String,
        start: u32,
        end: u32,
        /// `wikiLink`, `dateMention`, `hashTag`, `linkMention`.
        kind: String,
        /// The text the node displays.
        text: String,
        /// The node's own attributes: `target` for a wiki link, `date` for a
        /// date mention. Written verbatim, because the reader looks for them
        /// by name.
        attrs: HashMap<String, String>,
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
        BlockEdit::SetCellCheckbox {
            table_id,
            row,
            column,
            index,
            checked,
        } => set_cell_checkbox(txn, table_id, *row, *column, *index, *checked),
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
        BlockEdit::InsertInline {
            block_id,
            start,
            end,
            kind,
            text,
            attrs,
        } => insert_inline(txn, block_id, *start, *end, kind, text, attrs),
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
