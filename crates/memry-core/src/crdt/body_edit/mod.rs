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

mod columns;
mod inline;
mod locate;
mod merge;
mod paste;
mod snapshot;
mod structure;
mod tables;
mod text;
mod text_diff;

use columns::*;
use inline::*;
use locate::*;
use merge::*;
use paste::*;
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
    /// flattened text with each node both keep as an anchor, and applies only
    /// the changed span between two anchors, as deletes and inserts on the
    /// runs that hold it, so no edit removes a node the text still has: a peer's
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
    ///
    /// A block directly in a column is refused as a column layout edit:
    /// there is no level inside the column to lift it to, and desktop leaves
    /// it where it is.
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
    /// first in the column it sat in, else where that column's list stood
    /// (its column rebuilt when the list is still there), else first in the
    /// body.
    ///
    /// `snapshot` is opaque and belongs to the shell's undo stack only: it is
    /// never stored or synced.
    RestoreBlock {
        snapshot: String,
    },
    /// Inserts a side-by-side column layout (chapter 12 §12.9):
    /// `columnList > column(width 1) > blockContainer > paragraph`, one empty
    /// paragraph per column.
    ///
    /// Lands after `after_block_id`, or at the start of the body when it is
    /// `None`. An anchor inside a column (or nested under another block) lands
    /// the list after the top-level row that holds it, because a column list
    /// never nests. `columns` outside 2..=3 is refused.
    ///
    /// `new_block_id` becomes the `columnList`'s own `id`; the core mints the
    /// ids of each column and of each column's paragraph container.
    InsertColumnList {
        after_block_id: Option<String>,
        columns: u32,
        new_block_id: String,
    },
    /// Backspace at a block's start: appends `block_id`'s inline content, marks
    /// and inline nodes kept, to `into_block_id`'s, then removes `block_id`. A
    /// block with nested blocks is refused. Last, to keep earlier FFI indices.
    MergeBlocks {
        block_id: String,
        into_block_id: String,
    },
    /// Return inside a block's text (desktop's `splitBlockTr`): the inline
    /// content from `at` on, marks and inline nodes kept, moves to a new
    /// block `new_block_id` right after `block_id`. `MergeBlocks` of the new
    /// block into `block_id` undoes it.
    ///
    /// `at` counts characters of the block's text as `ReplaceText` spells
    /// it: Unicode scalar values, each inline node one U+FFFC. A byte offset
    /// could not tell the caret before a textless node (a date) from the
    /// caret after it.
    ///
    /// `kind` names the new block's type, with its default props. `None`
    /// gives it `block_id`'s type and props, as desktop's split at a block's
    /// start does. A block with nested blocks is refused: on desktop they go
    /// with the tail, and `MergeBlocks` refuses to bring them back. Last, to
    /// keep earlier FFI indices.
    SplitBlock {
        block_id: String,
        at: u32,
        #[uniffi(default = None)]
        kind: Option<String>,
        new_block_id: String,
    },
    /// Plain text pasted at `at` in `block_id` (counted as `SplitBlock`'s
    /// `at`), read as markdown as desktop's paste reads `text/plain`
    /// (chapter 12 §12.1.0). Its blocks go below the text before the caret,
    /// and the text after it moves to a block of `block_id`'s type below
    /// them; at the start of the block they go above it, and an empty block
    /// is replaced. `new_block_ids` holds one id per block the paste writes
    /// ([`crate::crdt::markdown_seed::paste_plan`]), then the moved text's
    /// when there is any. A code block, and a block with nested blocks split
    /// mid-text, are refused. Last, to keep earlier FFI indices.
    PasteMarkdown {
        block_id: String,
        at: u32,
        markdown: String,
        new_block_ids: Vec<String>,
    },
}

/// Applies one edit to `document`.
///
/// The update the write authored reaches the registry's sink, which is what the
/// caller commits alongside its outbox row.
pub fn apply(document: &Document, edit: &BlockEdit) -> Result<(), CrdtError> {
    document.write(|txn| {
        guard_column_layout(txn, edit)?;
        apply_in(txn, edit)
    })?
}

fn apply_in(txn: &mut TransactionMut, edit: &BlockEdit) -> Result<(), CrdtError> {
    match edit {
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
        BlockEdit::InsertColumnList {
            after_block_id,
            columns,
            new_block_id,
        } => insert_column_list(txn, after_block_id.as_deref(), *columns, new_block_id),
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
        BlockEdit::MergeBlocks {
            block_id,
            into_block_id,
        } => merge_blocks(txn, block_id, into_block_id),
        BlockEdit::SplitBlock {
            block_id,
            at,
            kind,
            new_block_id,
        } => split_block(txn, block_id, *at, kind.as_deref(), new_block_id),
        BlockEdit::PasteMarkdown {
            block_id,
            at,
            markdown,
            new_block_ids,
        } => paste_markdown(txn, block_id, *at, markdown, new_block_ids),
    }
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
/// snapshots one by one (note "Duplicate"). A `columnList` is a top-level row
/// like a block, and is listed so a copy keeps its columns. Authors no update;
/// an empty body answers an empty list.
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
                    && matches!(container.tag().as_ref(), "blockContainer" | COLUMN_LIST)
                    && let Some(id) = attribute(txn, &container, "id")
                {
                    ids.push(id);
                }
            }
        }
        Ok(ids)
    })?
}

#[cfg(test)]
mod tests;
