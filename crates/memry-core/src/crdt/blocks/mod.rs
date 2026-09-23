//! `blocks`: the note body as a list of blocks, for a shell that renders it.
//!
//! **Why this exists beside [`super::text_extract`].** `extract_text` is the
//! core's only *text* operation and claims no fidelity: marks, link targets,
//! callout types and table structure are all dropped, because search and
//! previews read better without them. A phone rendering a note needs exactly
//! what that drops. So this is a second, richer walk of the same
//! `prosemirror` fragment — not a markdown parser, not a serialiser, and not a
//! second document model.
//!
//! **The two walks may not drift, and a test says so rather than a comment.**
//! `text_extract` is pinned byte-for-byte to `text-extract.json`, generated
//! from the TypeScript reference; folding it into this walk would put that
//! contract at risk for a refactor's sake. Instead [`blocks_to_text`] renders
//! this output the way `extract_text` renders the document, and
//! `tests/crdt_blocks.rs` asserts the two agree on every committed vector. A
//! block type one walk knows and the other does not is then a failing test,
//! which is the guarantee a shared function would have bought.
//!
//! **Nothing is dropped for being unknown** (FR-033's habit). A block type
//! this port has never heard of crosses with its own tag as `kind`, its
//! attributes as `props`, and its text as inline runs; the shell renders it as
//! a paragraph rather than losing it. The same goes for an unknown inline
//! element and an unknown mark.
//!
//! **No markdown, in either direction.** The markers `extract_text` emits are
//! *not* produced here: `kind` and `props` carry what the marker stood for, and
//! a shell that wants "1. " decides that itself.

use std::collections::HashMap;

use yrs::types::text::YChange;
use yrs::{Any, Out, ReadTxn, Text as _, Xml as _, XmlElementRef, XmlFragment, XmlOut, XmlTextRef};

use super::errors::CrdtError;
use super::registry::Document;
use super::text_extract::BODY_FRAGMENT;

mod inline;
mod tables;

use inline::*;
use tables::*;

/// One block of a note body.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Block {
    /// The `blockContainer` id y-prosemirror carries, when there is one.
    ///
    /// `None` rather than a minted id: this identifies a block *in the
    /// document*, and inventing one would give the shell a handle that no edit
    /// could ever resolve.
    pub id: Option<String>,
    /// The node name, verbatim — `paragraph`, `heading`, `callout`,
    /// `bulletListItem`, or something this build has never seen.
    pub kind: String,
    /// Nesting depth in blocks, 0 at the top of the body. A list inside a list
    /// item is 1; the shell indents from this and nothing else.
    pub depth: u32,
    /// The node's own attributes: `level` on a heading, `type` on a callout,
    /// `checked` on a check list item, `language` on a code block.
    pub props: Vec<BlockProp>,
    /// The block's own inline content, in order. Nested blocks are not in
    /// here — they are their own entries, deeper.
    pub inline: Vec<InlineRun>,
}

/// One attribute of a block, as the document spells it.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BlockProp {
    pub name: String,
    pub value: String,
}

/// A run of inline content that shares one set of marks.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct InlineRun {
    pub text: String,
    /// Mark names in document order: `bold`, `italic`, `code`, `strike`, and
    /// for an inline node its tag — `wikiLink`, `hashTag`, `dateMention`,
    /// `linkMention`.
    pub marks: Vec<String>,
    /// What each mark **says**, which the name alone does not.
    ///
    /// `bold` is the whole statement; `textColor` is not, and until this
    /// existed a red word and a blue word reached the shell as the same bare
    /// `textColor`. Values are flattened into one flat map rather than nested,
    /// because the FFI carries a `Map<String, String>` and a shell asking "what
    /// colour" wants one lookup:
    ///
    /// - a mark whose attributes are empty — every boolean style — is **not**
    ///   in the map at all; its presence in [`Self::marks`] is the whole fact;
    /// - BlockNote stores a string-valued style's value under one attribute
    ///   named `stringValue`, and that one is normalised to the bare mark name,
    ///   so `textColor` reads as `textColor -> "red"` and no shell ever learns
    ///   BlockNote's spelling;
    /// - anything else is keyed `mark.attribute`, so a link's `href` is
    ///   `link.href`, and a nested object or array is its JSON rather than
    ///   being dropped (FR-033);
    /// - an inline **node**'s own attributes are here too, under its tag —
    ///   `wikiLink.displayAs`, `dateMention.date` — because those are lost
    ///   otherwise and Phase G needs them.
    pub mark_attrs: HashMap<String, String>,
    /// What the run points at, when it points at anything: a URL for a link, a
    /// wiki target for a wiki link, a tag name, an ISO date. The shell decides
    /// what to do with it; the core does not resolve it.
    pub target: Option<String>,
}

/// One table's structure, which a flat block list cannot carry.
///
/// A table's cells reach [`extract_blocks`] as blocks like any other, because
/// dropping them would lose their text and break the walk this module is held
/// to. But a flat list with a depth number cannot say **which row** a cell is
/// in, how wide a column is, or which cells are headers, so a shell reading
/// only that list draws a table as a column of loose paragraphs. This is the
/// second read that answers those questions.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TableContent {
    /// The `blockContainer` id of the table itself, which is the handle an
    /// edit addresses. `None` for a table written without one.
    pub block_id: Option<String>,
    /// One entry per column, in the document's own units, `None` where the
    /// column has never been resized.
    ///
    /// Taken from the first row's `colwidth` attributes, the way BlockNote
    /// derives `columnWidths`. They are **not** pixels on this screen: a
    /// column sized on a desktop window is wider than a phone, so a shell
    /// applies them proportionally (N011).
    pub column_widths: Vec<Option<f64>>,
    /// How many rows are entirely `tableHeader`, counted the way BlockNote
    /// counts them: any fully-header row, not only leading ones.
    pub header_rows: u32,
    /// How many columns are entirely `tableHeader`, same rule.
    pub header_cols: u32,
    pub rows: Vec<TableRow>,
}

/// One row of a table.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TableRow {
    pub cells: Vec<TableCell>,
}

/// One cell of a table.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TableCell {
    /// **Q1's answer, recorded where it cannot be missed: a cell carries no
    /// `blockContainer` id.** BlockNote builds a cell as
    /// `tableCell > tableParagraph`, with no container and no id anywhere in
    /// between, so a cell cannot be addressed the way every other block is.
    /// An edit reaches one by the table's id plus its row and column
    /// (N402), and this field exists to say so rather than leaving the next
    /// reader to rediscover it from a fixture.
    pub block_id: Option<String>,
    /// `true` when the document spells this cell `tableHeader`.
    pub is_header: bool,
    pub colspan: u32,
    pub rowspan: u32,
    pub background_color: Option<String>,
    pub text_color: Option<String>,
    pub text_alignment: Option<String>,
    /// This cell's own `colwidth`, one entry per column it spans.
    pub colwidth: Vec<Option<f64>>,
    /// The cell's content, as blocks. Normally one `tableParagraph`; a cell
    /// holding something this build does not know keeps it rather than
    /// flattening it to text (FR-033).
    pub content: Vec<Block>,
}

/// The body as blocks.
///
/// An empty document is an empty list, never a single empty paragraph: a note
/// nobody has written is not a note with one blank line in it.
pub fn extract_blocks(document: &Document) -> Result<Vec<Block>, CrdtError> {
    document.read(|txn| {
        let mut blocks = Vec::new();
        if let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) {
            walk(&fragment, txn, 0, &mut blocks, true);
        }
        blocks
    })
}

/// One table's structure, by the `blockContainer` id of the table block.
///
/// `None` for an id this body does not hold **and** for an id that holds
/// something other than a table: the caller asked about a table and there is
/// none, which is one answer rather than two.
pub fn extract_table(
    document: &Document,
    block_id: &str,
) -> Result<Option<TableContent>, CrdtError> {
    document.read(|txn| {
        let fragment = txn.get_xml_fragment(BODY_FRAGMENT)?;
        let table = find_table(&fragment, txn, block_id)?;
        Some(table_content(&table, txn, block_id))
    })
}

/// The same lines `extract_text` would emit, rebuilt from blocks.
///
/// Only the two things `extract_text` keeps are reconstructed — the heading
/// marker and the list marker — because those are the only two it claims.
pub fn blocks_to_text(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter(|block| !TEXT_DROPPED.contains(&block.kind.as_str()))
        .filter_map(|block| {
            let text: String = block.inline.iter().map(|run| run.text.as_str()).collect();
            let line = format!("{}{}", marker(block), text);
            let line = line.trim_end_matches([' ', '\t', '\n', '\r']).to_owned();
            (!line.is_empty()).then_some(line)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `extract_text`'s markers, and no others.
fn marker(block: &Block) -> String {
    match block.kind.as_str() {
        "heading" => {
            let level = block
                .props
                .iter()
                .find(|prop| prop.name == "level")
                .and_then(|prop| prop.value.parse::<i64>().ok())
                .unwrap_or(1)
                .clamp(1, 6) as usize;
            format!("{} ", "#".repeat(level))
        }
        "bulletListItem" | "checkListItem" | "taskBlock" => "- ".to_owned(),
        "numberedListItem" => "1. ".to_owned(),
        _ => String::new(),
    }
}

// MARK: - The walk

/// Structural nodes that carry no block of their own.
///
/// **`table` and `tableRow` are deliberately not here, and `extract_text`'s
/// list is deliberately different.** Treating them as containers is what made
/// a table unrecoverable: every cell of every row arrived at one depth, with
/// no row boundary, no column count and the table's own `blockContainer` id
/// stuck on the first cell. A shell could not tell a two-by-three table from
/// six paragraphs. They are blocks here, so the table keeps its id and its
/// rows keep their boundaries; the text walk still sees them as containers,
/// because a table contributes one line per cell and nothing of its own — and
/// both of those produce the same bytes, which `tests/crdt_blocks.rs` checks.
const CONTAINERS: [&str; 2] = ["blockContainer", "blockGroup"];
/// Blocks `extract_text` drops entirely (chapter 12 §12.1.3).
///
/// **Only the text walk drops them.** A `divider` is a real block a shell has
/// to draw, and dropping it here is what made `NoteBlockView`'s `case
/// "divider"` unreachable — the block never left the core. It is emitted like
/// any other block now, and [`blocks_to_text`] skips it so the two walks still
/// agree byte for byte.
const TEXT_DROPPED: [&str; 1] = ["divider"];
/// The attribute BlockNote stores a string-valued style's value under.
///
/// `createStyleSpecFromTipTapMark` builds every string style with a single
/// `stringValue` attribute, so `textColor="red"` arrives as
/// `{ stringValue: "red" }`. Normalised away in [`flatten_mark_attrs`].
const STRING_VALUE_ATTR: &str = "stringValue";
/// Node names that are inline content rather than blocks.
const INLINE_NODES: [&str; 6] = [
    "wikiLink",
    "hashTag",
    "dateMention",
    "linkMention",
    "inlineImage",
    "inlineCheckbox",
];

fn is_container(name: &str) -> bool {
    CONTAINERS.contains(&name)
}

fn is_inline_node(name: &str) -> bool {
    INLINE_NODES.contains(&name)
}

/// `at_root` marks the fragment's own children.
///
/// It exists for one node: chapter 12 §12.5.0 says the fragment's single
/// top-level child is **always** a `blockGroup`, so that one is structural in
/// the same way the fragment is and must not count as nesting. Without this,
/// every top-level block in a real BlockNote document reported `depth: 1`,
/// and a shell indenting by depth drew the whole note one step in.
fn walk<F, T>(node: &F, txn: &T, depth: u32, blocks: &mut Vec<Block>, at_root: bool)
where
    F: XmlFragment,
    T: ReadTxn,
{
    for child in node.children(txn) {
        match child {
            XmlOut::Element(element) => walk_element(&element, txn, depth, blocks, at_root),
            // Loose text directly under the fragment has no block of its own.
            // `extract_text` emits it as a line, so it becomes a paragraph
            // here rather than disappearing.
            XmlOut::Text(text) => {
                let runs = runs_of_text(&text, txn);
                if runs.iter().any(|run| !run.text.is_empty()) {
                    blocks.push(Block {
                        id: None,
                        kind: "paragraph".to_owned(),
                        depth,
                        props: Vec::new(),
                        inline: runs,
                    });
                }
            }
            XmlOut::Fragment(_) => {}
        }
    }
}

fn walk_element<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    depth: u32,
    blocks: &mut Vec<Block>,
    at_root: bool,
) {
    let tag = element.tag().clone();
    let name: &str = tag.as_ref();

    if is_container(name) {
        // A `blockContainer` holds one block plus, sometimes, a `blockGroup`
        // of children; only the group is a level deeper — except the one the
        // fragment always carries, which is structure rather than nesting.
        let deeper = if name == "blockGroup" && !at_root {
            depth + 1
        } else {
            depth
        };
        // The id lives on the container, and the block under it is what the
        // shell addresses, so it is carried down one level.
        let container_id = attribute(element, txn, "id");
        let before = blocks.len();
        walk(element, txn, deeper, blocks, false);
        if let Some(id) = container_id
            && let Some(first) = blocks.get_mut(before)
            && first.id.is_none()
        {
            first.id = Some(id);
        }
        return;
    }

    blocks.push(Block {
        id: None,
        kind: name.to_owned(),
        depth,
        props: props_of(element, txn),
        inline: inline_runs(element, txn),
    });

    // A block may nest further blocks — a list inside a list item, a row
    // inside a table. They are their own entries, one level deeper, after this
    // one. Inline children are already in the runs above.
    for grandchild in element.children(txn) {
        if let XmlOut::Element(inner) = grandchild {
            let inner_tag = inner.tag().clone();
            let inner_name: &str = inner_tag.as_ref();
            if !is_inline_node(inner_name) {
                walk_element(&inner, txn, depth + 1, blocks, false);
            }
        }
    }
}

fn attribute<T: ReadTxn>(element: &XmlElementRef, txn: &T, name: &str) -> Option<String> {
    element
        .attributes(txn)
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.to_string(txn))
}

fn props_of<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> Vec<BlockProp> {
    let mut props: Vec<BlockProp> = element
        .attributes(txn)
        .map(|(name, value)| BlockProp {
            name: name.to_owned(),
            value: value.to_string(txn),
        })
        .collect();
    // Attribute order is a map's, which is not stable across runs; a shell
    // diffing two reads of the same block must not see a change that is not
    // one.
    props.sort_by(|left, right| left.name.cmp(&right.name));
    props
}
