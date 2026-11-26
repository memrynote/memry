//! Plain text pasted into a block, read as markdown. See
//! [`BlockEdit::PasteMarkdown`].

#[allow(unused_imports)]
use super::*;

use crate::crdt::markdown_seed;

pub(super) fn paste_markdown(
    txn: &mut TransactionMut,
    block_id: &str,
    at: u32,
    markdown: &str,
    new_block_ids: &[String],
) -> Result<(), CrdtError> {
    let refused = |what: &str| CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: what.to_owned(),
    };
    let (container, source) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let kind = source.tag().as_ref().to_owned();
    if !node_shapes::holds_inline(&kind) || node_shapes::holds_plain_text(&kind) {
        return Err(refused("markdown pastes only into a block of marked text"));
    }
    let blocks = markdown_seed::paste_plan(markdown).blocks;
    if blocks.is_empty() {
        return Err(refused("the pasted text makes no blocks"));
    }
    // Everything is checked before the first write: a refusal leaves the
    // body as it was.
    let length = flatten(txn, &source).1.len();
    if at as usize > length {
        return Err(refused("that offset is past the block's end"));
    }
    let tail = at > 0 && (at as usize) < length;
    if new_block_ids.len() != blocks.len() + usize::from(tail) {
        return Err(refused(
            "a paste takes one new id per block it writes, then one for the text after the caret",
        ));
    }
    let nested = child_block_group(txn, &container).is_some();
    if tail && nested {
        return Err(refused("a block with nested blocks does not split"));
    }
    let Some(XmlOut::Element(parent)) = container.parent() else {
        return Err(missing(block_id));
    };
    let index = child_index(txn, &parent, &container).ok_or_else(|| missing(block_id))?;

    if tail {
        split_block(txn, block_id, at, None, &new_block_ids[blocks.len()])?;
    }
    // At the start of a block with text, the pasted blocks go above it.
    let before = at == 0 && length > 0;
    let index = if before { index } else { index + 1 };
    markdown_seed::insert_blocks(txn, &parent, index, &blocks, &new_block_ids[..blocks.len()]);
    // An empty block is replaced, as desktop's paste replaces it.
    if length == 0 && !nested {
        delete(txn, block_id)?;
    }
    Ok(())
}
