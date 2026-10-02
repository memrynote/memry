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
    Any, ReadTxn, Text as _, TransactionMut, Xml as _, XmlElementPrelim, XmlElementRef,
    XmlFragment as _, XmlTextPrelim, XmlTextRef,
};

use crate::crdt::errors::CrdtError;
use crate::crdt::node_shapes;
use crate::crdt::{BODY_FRAGMENT, Document};

mod inline;
mod snapshot;
mod structure;
mod tables;
mod text;

use inline::*;
use snapshot::*;
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
    /// Rewrites a block's text **in place, keeping its marks and inline
    /// nodes**.
    ///
    /// `text` is the whole block as the shell shows it, with every inline node
    /// (a wiki link, a date, a tag, an inline image) spelled as one U+FFFC
    /// OBJECT REPLACEMENT CHARACTER. The core diffs it against the block's own
    /// flattened text by common prefix and suffix and applies only the span
    /// between them, as deletes and inserts on the runs that hold it: a peer's
    /// concurrent typing elsewhere in the block survives the merge, and bold,
    /// colour and links outside the span are untouched. Inserted text takes the
    /// formatting of the character before it, as typing does. A U+FFFC in the
    /// inserted span is dropped: a node is never made from a placeholder.
    ///
    /// Only BlockNote's inline nodes are placeholders. Any other element in
    /// the block's content (a `hardBreak`) is not part of the shell's text,
    /// takes no position in the diff, and is never removed by it.
    ReplaceText {
        block_id: String,
        text: String,
        /// The block's text as the shell last read it, before the user typed.
        ///
        /// When given and the block has moved on since (a peer's edit merged
        /// while the shell held unsaved typing), only the user's change,
        /// `base` to `text`, is applied on top of the live block, so the
        /// peer's edit survives. `None` diffs `text` against the live block.
        #[uniffi(default = None)]
        base: Option<String>,
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
    /// Puts back a block read with [`snapshot_block`], **with its original
    /// ids**, so a peer's reference to it and the shell's redo still resolve.
    ///
    /// The undo of a delete and of a type change (iOS undo). When the block
    /// is still in the body, only its own element is replaced, with the type,
    /// props, marks and inline nodes it had; the blocks nested under it are
    /// left as they are. When it is gone, the whole container returns after
    /// the sibling it followed, else first in the block it was nested in, else
    /// first in the body.
    ///
    /// `snapshot` is opaque and belongs to the shell's undo stack only: it is
    /// never stored or synced.
    RestoreBlock {
        snapshot: String,
    },
}

/// Applies one edit to `document`.
///
/// The update the write authored reaches the registry's sink, which is what the
/// caller commits alongside its outbox row.
pub fn apply(document: &Document, edit: &BlockEdit) -> Result<(), CrdtError> {
    document.write(|txn| match edit {
        BlockEdit::SetText { block_id, text } => set_text(txn, block_id, text),
        BlockEdit::ReplaceText {
            block_id,
            text,
            base,
        } => replace_text(txn, block_id, text, base.as_deref()),
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
        BlockEdit::RestoreBlock { snapshot } => restore_block(txn, snapshot),
    })?
}

/// Reads one block's container and everything under it, for
/// [`BlockEdit::RestoreBlock`]. Authors no update.
///
/// A block the body does not hold is refused, as an edit to it would be.
pub fn snapshot_block(document: &Document, block_id: &str) -> Result<String, CrdtError> {
    // A write transaction only because `locate` walks one; nothing changes,
    // so nothing reaches the sink.
    document.write(|txn| snapshot::snapshot_block(txn, block_id))?
}

/// Appends a block read with [`snapshot_block`] (from any note's body), with
/// everything under it, to the end of this body: desktop's "Move to".
///
/// Its marks, props, inline nodes and nested blocks come along. Container ids
/// are kept, except one this body already holds, which is minted afresh: two
/// blocks sharing an id are two blocks no edit can tell apart.
pub fn append_snapshot(document: &Document, snapshot: &str) -> Result<(), CrdtError> {
    document.write(|txn| snapshot::append_block(txn, snapshot))?
}

/// [`append_snapshot`] inside a caller's transaction, so several appends
/// author one update.
pub(crate) fn append_snapshot_in(
    txn: &mut TransactionMut,
    snapshot: &str,
) -> Result<(), CrdtError> {
    snapshot::append_block(txn, snapshot)
}

/// The body's top-level `blockGroup`, created when the body is empty and
/// refused for a layout no BlockNote writer produces (§12.5.0): where a
/// writer outside this module appends top-level blocks.
pub(crate) fn top_block_group(txn: &mut TransactionMut) -> Result<XmlElementRef, CrdtError> {
    structure::block_group(txn)
}

/// The ids of the body's top-level blocks, in order: what a whole-body copy
/// snapshots one by one (note "Duplicate"). Authors no update; an empty body
/// answers an empty list.
pub fn top_level_block_ids(document: &Document) -> Result<Vec<String>, CrdtError> {
    document.write(|txn| {
        let mut ids = Vec::new();
        let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) else {
            return Ok(ids);
        };
        for child in fragment.children(txn) {
            let XmlOut::Element(group) = child else {
                continue;
            };
            if group.tag().as_ref() != "blockGroup" {
                continue;
            }
            for inner in group.children(txn) {
                if let XmlOut::Element(container) = inner
                    && container.tag().as_ref() == "blockContainer"
                    && let Some(id) = attribute(txn, &container, "id")
                {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
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
            // The last child of a nested group leaves no empty group behind:
            // BlockNote's schema requires a group to hold a block.
            drop_if_empty(txn, &element);
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::crdt::DocumentRegistry;
    use crate::crdt::canonical::canonical_fragment;
    use crate::crdt::registry::UpdateSink;

    fn empty_note() -> Arc<Document> {
        let sink: UpdateSink = Arc::new(|_, _| {});
        DocumentRegistry::new("device-body-edit", sink)
            .get_or_open("abc123def456")
            .expect("open")
    }

    fn insert(document: &Document, kind: &str, after: Option<&str>, text: &str) {
        apply(
            document,
            &BlockEdit::InsertBlock {
                kind: kind.to_owned(),
                after_block_id: after.map(str::to_owned),
                text: text.to_owned(),
                new_block_id: "n1".to_owned(),
            },
        )
        .unwrap_or_else(|error| panic!("inserting {kind} was refused: {error}"));
    }

    fn note_with_a_paragraph() -> Arc<Document> {
        let document = empty_note();
        apply(
            &document,
            &BlockEdit::InsertParagraph {
                after_block_id: None,
                text: "Before.".to_owned(),
                new_block_id: "p1".to_owned(),
            },
        )
        .expect("paragraph");
        document
    }

    const PARAGRAPH: &str = "0 element blockGroup\n\
        1 element blockContainer id=\"p1\"\n\
        2 element paragraph backgroundColor=\"default\" textAlignment=\"left\" textColor=\"default\"\n\
        3 text \"Before.\"\n";

    /// Each expected document is what desktop's `blocksToYXmlFragment` writes
    /// for the same blocks, rendered through the vector class's canonical form.
    #[test]
    fn an_inserted_math_diagram_or_whiteboard_is_the_node_desktop_writes() {
        for (kind, text, node) in [
            ("mathBlock", "", "2 element mathBlock latex=\"\""),
            ("diagram", "", "2 element diagram"),
            (
                "diagram",
                "graph TD; A-->B",
                "2 element diagram\n3 text \"graph TD; A-->B\"",
            ),
            ("whiteboard", "", "2 element whiteboard canvasId=\"\""),
        ] {
            let document = note_with_a_paragraph();
            insert(&document, kind, Some("p1"), text);
            assert_eq!(
                canonical_fragment(&document).expect("canonical"),
                format!("{PARAGRAPH}1 element blockContainer id=\"n1\"\n{node}"),
                "{kind} {text:?}"
            );
        }
    }

    #[test]
    fn a_math_block_inserted_into_an_empty_note_lands_inside_the_block_group() {
        let document = empty_note();
        insert(&document, "mathBlock", None, "");
        assert_eq!(
            canonical_fragment(&document).expect("canonical"),
            "0 element blockGroup\n\
             1 element blockContainer id=\"n1\"\n\
             2 element mathBlock latex=\"\""
        );
    }

    /// A diagram's content is plain, so a bold run carried across would build
    /// a node y-prosemirror deletes. Only the text crosses.
    #[test]
    fn turning_a_formatted_paragraph_into_a_diagram_carries_plain_text_only() {
        let document = note_with_a_paragraph();
        apply(
            &document,
            &BlockEdit::SetMark {
                block_id: "p1".to_owned(),
                start: 0,
                end: 6,
                mark: "bold".to_owned(),
                value: None,
            },
        )
        .expect("bold");
        apply(
            &document,
            &BlockEdit::TurnInto {
                block_id: "p1".to_owned(),
                kind: "diagram".to_owned(),
            },
        )
        .expect("turn into diagram");
        assert_eq!(
            canonical_fragment(&document).expect("canonical"),
            "0 element blockGroup\n\
             1 element blockContainer id=\"p1\"\n\
             2 element diagram\n\
             3 text \"Before.\""
        );
    }
}
