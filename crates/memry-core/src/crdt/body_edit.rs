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
    ReadTxn as _, TransactionMut, Xml as _, XmlElementPrelim, XmlElementRef, XmlFragment as _,
    XmlTextPrelim,
};

use crate::crdt::errors::CrdtError;
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
    SetText { block_id: String, text: String },
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
    /// Removes a block and everything nested under it.
    ///
    /// Its children go with it: they live inside its container, and leaving
    /// them behind would reparent a list's items to the body.
    Delete { block_id: String },
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
        } => insert_paragraph(txn, after_block_id.as_deref(), text, new_block_id),
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
    // Every child that is content, removed together: a block's inline content
    // is text and inline nodes, and replacing the text means replacing both.
    // `blockGroup` children are nested blocks and stay.
    let mut keep_from = 0;
    let mut removals = Vec::new();
    for (index, child) in block.children(txn).enumerate() {
        match child {
            XmlOut::Element(inner) if inner.tag().as_ref() == "blockGroup" => {
                keep_from = keep_from.max(index + 1);
            }
            _ => removals.push(index as u32),
        }
    }
    // Back to front, so each index is still valid when it is reached.
    for index in removals.into_iter().rev() {
        block.remove_range(txn, index, 1);
    }
    if !text.is_empty() {
        block.insert(txn, 0, XmlTextPrelim::new(text));
    }
    Ok(())
}

fn set_prop(
    txn: &mut TransactionMut,
    block_id: &str,
    name: &str,
    value: &str,
) -> Result<(), CrdtError> {
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    block.insert_attribute(txn, name, value);
    Ok(())
}

fn insert_paragraph(
    txn: &mut TransactionMut,
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
            // The end of the body. The root fragment is not an element, so the
            // append goes through the fragment itself.
            let fragment = txn
                .get_xml_fragment(BODY_FRAGMENT)
                .ok_or_else(|| missing(new_block_id))?;
            let container = fragment.push_back(txn, prelim);
            container.insert_attribute(txn, "id", new_block_id);
            let paragraph = container.insert(txn, 0, XmlElementPrelim::empty("paragraph"));
            if !text.is_empty() {
                paragraph.insert(txn, 0, XmlTextPrelim::new(text));
            }
            return Ok(());
        }
    };
    let container = parent.insert(txn, index, prelim);
    container.insert_attribute(txn, "id", new_block_id);
    let paragraph = container.insert(txn, 0, XmlElementPrelim::empty("paragraph"));
    if !text.is_empty() {
        paragraph.insert(txn, 0, XmlTextPrelim::new(text));
    }
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
