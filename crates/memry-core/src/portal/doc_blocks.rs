//! A note's blocks as a portal reaches them by id: listing them for block search and giving one
//! its ` ^anchor` (desktop `portals/doc-blocks.ts`, `listDocBlocks` and `stampAnchorInDoc`).
//!
//! A block id lives only in the document, so both walk the `prosemirror` fragment. The walk is
//! iterative: a body nested deeper than the stack is still listed, never a crash.

use std::collections::{HashMap, HashSet};

use yrs::types::Attrs;
use yrs::{Any, Out, ReadTxn, Text as _, Xml as _, XmlElementRef, XmlFragment as _, XmlOut};
use yrs::{XmlTextPrelim, XmlTextRef};

use super::anchor::{extract_anchor, fresh_anchor};
use crate::crdt::errors::CrdtError;
use crate::crdt::registry::Document;
use crate::crdt::text_extract::BODY_FRAGMENT;

/// Content node names that are not a run of inline text, so ` ^anchor` cannot go at their end.
const NON_TEXT_CONTENT: [&str; 6] = ["codeBlock", "table", "image", "video", "audio", "file"];

/// Stand-in for an inline element (mention, tag, link target) in a block's text.
const INLINE_ELEMENT: char = '\u{FFFC}';

/// One block of a note, in document order, nested ones after their parent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocBlock {
    pub id: String,
    /// The nearest enclosing block's id, `None` at the top level.
    pub parent_id: Option<String>,
    /// The block's own text, anchor included. Empty for a block without inline text.
    pub text: String,
    /// The block holds a run of inline text an anchor can end.
    pub stampable: bool,
}

/// What [`stamp_anchor`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StampOutcome {
    /// The block took this new anchor.
    Stamped(String),
    /// The block already carried this anchor; nothing was written.
    Existing(String),
    /// No block has the id, or the block has no inline text to carry an anchor (code, table,
    /// media).
    MissingBlock,
}

fn tag(element: &XmlElementRef) -> String {
    element.tag().to_string()
}

fn id_of<T: ReadTxn>(txn: &T, element: &XmlElementRef) -> Option<String> {
    if tag(element) != "blockContainer" {
        return None;
    }
    let id = element.get_attribute(txn, "id")?.to_string(txn);
    (!id.is_empty()).then_some(id)
}

/// The block's content node: the container's first element child that is not its `blockGroup`.
fn content_of<T: ReadTxn>(txn: &T, container: &XmlElementRef) -> Option<XmlElementRef> {
    container.children(txn).find_map(|child| match child {
        XmlOut::Element(element) if tag(&element) != "blockGroup" => Some(element),
        _ => None,
    })
}

fn has_inline_text<T: ReadTxn>(txn: &T, content: &XmlElementRef) -> bool {
    !NON_TEXT_CONTENT.contains(&tag(content).as_str())
        && content.children(txn).all(|child| match child {
            XmlOut::Text(_) => true,
            XmlOut::Element(element) => tag(&element) != "tableRow",
            XmlOut::Fragment(_) => false,
        })
}

fn text_of<T: ReadTxn>(txn: &T, content: &XmlElementRef) -> String {
    let mut text = String::new();
    for child in content.children(txn) {
        match child {
            XmlOut::Text(run) => {
                for chunk in run.diff(txn, yrs::types::text::YChange::identity) {
                    match chunk.insert {
                        Out::Any(Any::String(piece)) => text.push_str(&piece),
                        _ => text.push(INLINE_ELEMENT),
                    }
                }
            }
            XmlOut::Element(_) => text.push(INLINE_ELEMENT),
            XmlOut::Fragment(_) => {}
        }
    }
    text
}

/// Every block with an id, and the content node of each one that can carry an anchor.
fn walk<T: ReadTxn>(txn: &T) -> Vec<(DocBlock, Option<XmlElementRef>)> {
    let mut blocks = Vec::new();
    let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) else {
        return blocks;
    };
    let elements = |children: Vec<XmlOut>| {
        children.into_iter().filter_map(|child| match child {
            XmlOut::Element(element) => Some(element),
            _ => None,
        })
    };
    let mut stack: Vec<(XmlElementRef, Option<String>)> = Vec::new();
    let top: Vec<XmlOut> = fragment.children(txn).collect();
    stack.extend(elements(top).rev().map(|element| (element, None)));
    while let Some((element, parent_id)) = stack.pop() {
        let own = id_of(txn, &element);
        if let Some(id) = &own {
            let content = content_of(txn, &element).filter(|c| has_inline_text(txn, c));
            let text = content
                .as_ref()
                .map(|c| text_of(txn, c))
                .unwrap_or_default();
            let block = DocBlock {
                id: id.clone(),
                parent_id: parent_id.clone(),
                text,
                stampable: content.is_some(),
            };
            blocks.push((block, content));
        }
        let children: Vec<XmlOut> = element.children(txn).collect();
        let parent = own.or(parent_id);
        stack.extend(
            elements(children)
                .rev()
                .map(|child| (child, parent.clone())),
        );
    }
    blocks
}

/// Every block of the note in document order, nested ones after their parent.
pub fn list_doc_blocks(document: &Document) -> Result<Vec<DocBlock>, CrdtError> {
    document.read(|txn| walk(txn).into_iter().map(|(block, _)| block).collect())
}

/// Gives the block `block_id` its ` ^anchor`, or reports the one it has. The suffix goes at the
/// end of the block's last text run and takes none of that run's marks, so a bold or linked tail
/// does not swallow it. The anchor is one no block of the note carries yet.
pub fn stamp_anchor(document: &Document, block_id: &str) -> Result<StampOutcome, CrdtError> {
    document.write(|txn| {
        let blocks = walk(&*txn);
        let Some((block, Some(content))) = blocks.iter().find(|(block, _)| block.id == block_id)
        else {
            return Ok(StampOutcome::MissingBlock);
        };
        if let Some(existing) = extract_anchor(&block.text) {
            return Ok(StampOutcome::Existing(existing));
        }
        let taken: HashSet<String> = blocks
            .iter()
            .filter_map(|(block, _)| extract_anchor(&block.text))
            .collect();
        let anchor = fresh_anchor(&taken).ok_or_else(|| CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "no unused anchor in 20 draws: the random source is broken".to_owned(),
        })?;
        let suffix = format!(" ^{anchor}");
        let content = content.clone();
        match content.children(&*txn).last() {
            Some(XmlOut::Text(run)) => append_unmarked(txn, &run, &suffix),
            _ => {
                let run = content.push_back(txn, XmlTextPrelim::new(""));
                run.insert(txn, 0, &suffix);
            }
        }
        Ok(StampOutcome::Stamped(anchor))
    })?
}

/// Appends `text` to `run` with every mark the run uses set to null.
fn append_unmarked(txn: &mut yrs::TransactionMut, run: &XmlTextRef, text: &str) {
    let mut nulled: HashMap<String, Any> = HashMap::new();
    for chunk in run.diff(&*txn, yrs::types::text::YChange::identity) {
        for name in chunk.attributes.iter().flat_map(|attrs| attrs.keys()) {
            nulled.insert(name.to_string(), Any::Null);
        }
    }
    let end = run.len(&*txn);
    if nulled.is_empty() {
        run.insert(txn, end, text);
    } else {
        let attrs: Attrs = nulled.into_iter().map(|(k, v)| (k.into(), v)).collect();
        run.insert_with_attributes(txn, end, text, attrs);
    }
}

#[cfg(test)]
#[path = "doc_blocks_tests.rs"]
mod tests;
