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
use yrs::{ReadTxn, Text as _, Xml as _, XmlElementRef, XmlFragment, XmlOut, XmlTextRef};

use super::errors::CrdtError;
use super::registry::Document;
use super::text_extract::BODY_FRAGMENT;

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
    /// What the run points at, when it points at anything: a URL for a link, a
    /// wiki target for a wiki link, a tag name, an ISO date. The shell decides
    /// what to do with it; the core does not resolve it.
    pub target: Option<String>,
}

/// The body as blocks.
///
/// An empty document is an empty list, never a single empty paragraph: a note
/// nobody has written is not a note with one blank line in it.
pub fn extract_blocks(document: &Document) -> Result<Vec<Block>, CrdtError> {
    document.read(|txn| {
        let mut blocks = Vec::new();
        if let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) {
            walk(&fragment, txn, 0, &mut blocks);
        }
        blocks
    })
}

/// The same lines `extract_text` would emit, rebuilt from blocks.
///
/// Only the two things `extract_text` keeps are reconstructed — the heading
/// marker and the list marker — because those are the only two it claims.
pub fn blocks_to_text(blocks: &[Block]) -> String {
    blocks
        .iter()
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
const CONTAINERS: [&str; 4] = ["blockContainer", "blockGroup", "table", "tableRow"];
/// Blocks whose own content is dropped entirely.
const SKIPPED: [&str; 1] = ["divider"];
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

fn walk<F, T>(node: &F, txn: &T, depth: u32, blocks: &mut Vec<Block>)
where
    F: XmlFragment,
    T: ReadTxn,
{
    for child in node.children(txn) {
        match child {
            XmlOut::Element(element) => walk_element(&element, txn, depth, blocks),
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

fn walk_element<T: ReadTxn>(element: &XmlElementRef, txn: &T, depth: u32, blocks: &mut Vec<Block>) {
    let tag = element.tag().clone();
    let name: &str = tag.as_ref();

    if SKIPPED.contains(&name) {
        return;
    }

    if is_container(name) {
        // A `blockContainer` holds one block plus, sometimes, a `blockGroup`
        // of children; only the group is a level deeper.
        let deeper = if name == "blockGroup" {
            depth + 1
        } else {
            depth
        };
        // The id lives on the container, and the block under it is what the
        // shell addresses, so it is carried down one level.
        let container_id = attribute(element, txn, "id");
        let before = blocks.len();
        walk(element, txn, deeper, blocks);
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
                walk_element(&inner, txn, depth + 1, blocks);
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

/// The block's own inline content, flattened into runs.
fn inline_runs<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> Vec<InlineRun> {
    let mut runs = Vec::new();
    collect_runs(element, txn, &[], &mut runs);
    runs
}

fn collect_runs<T: ReadTxn>(
    element: &XmlElementRef,
    txn: &T,
    inherited: &[String],
    runs: &mut Vec<InlineRun>,
) {
    for child in element.children(txn) {
        match child {
            XmlOut::Text(text) => {
                for mut run in runs_of_text(&text, txn) {
                    run.marks = merge(inherited, &run.marks);
                    if !run.text.is_empty() {
                        runs.push(run);
                    }
                }
            }
            XmlOut::Element(inner) => {
                let tag = inner.tag().clone();
                let name: &str = tag.as_ref();
                if !is_inline_node(name) {
                    // A nested block. It contributes its own entry, not this
                    // block's text — folding it in would merge two paragraphs.
                    continue;
                }
                let mut marks = inherited.to_vec();
                marks.push(name.to_owned());
                let target = inline_target(&inner, txn);
                let before = runs.len();
                collect_runs(&inner, txn, &marks, runs);
                for run in runs[before..].iter_mut() {
                    if run.target.is_none() {
                        run.target = target.clone();
                    }
                }
                // An inline node with no text of its own — an image, a
                // checkbox — is still a run, or the shell never hears about it.
                if runs.len() == before {
                    runs.push(InlineRun {
                        text: String::new(),
                        marks,
                        target,
                    });
                }
            }
            XmlOut::Fragment(_) => {}
        }
    }
}

/// Where an inline node points, by the attribute its own type uses.
fn inline_target<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> Option<String> {
    for name in ["target", "href", "url", "tag", "date", "src", "noteId"] {
        if let Some(value) = attribute(element, txn, name) {
            return Some(value);
        }
    }
    None
}

/// One `XmlText`'s deltas, as runs. Marks are y-prosemirror's text attributes.
fn runs_of_text<T: ReadTxn>(text: &XmlTextRef, txn: &T) -> Vec<InlineRun> {
    let mut runs = Vec::new();
    for chunk in text.diff(txn, YChange::identity) {
        let mut marks: Vec<String> = Vec::new();
        let mut target: Option<String> = None;
        if let Some(attrs) = chunk.attributes {
            let mut entries: Vec<(&str, String)> = attrs
                .iter()
                .map(|(key, value)| (key.as_ref(), value.to_string()))
                .collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            for (key, value) in entries {
                marks.push(key.to_owned());
                if key == "link" || key == "href" {
                    target = Some(unquote(&value));
                }
            }
        }
        runs.push(InlineRun {
            text: unquote(&chunk.insert.to_string(txn)),
            marks,
            target,
        });
    }
    runs
}

/// `yrs::Out`'s `to_string` quotes a string value; the text itself is wanted.
fn unquote(value: &str) -> String {
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .map(|inner| inner.replace("\\\"", "\""))
        .unwrap_or_else(|| value.to_owned())
}

fn merge(inherited: &[String], own: &[String]) -> Vec<String> {
    let mut marks = inherited.to_vec();
    let mut seen: HashMap<&str, ()> = inherited.iter().map(|mark| (mark.as_str(), ())).collect();
    for mark in own {
        if seen.insert(mark.as_str(), ()).is_none() {
            marks.push(mark.clone());
        }
    }
    marks
}
