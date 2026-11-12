//! Backspace at the start of a block: its inline content joins the end of the
//! block above, and the block goes. See [`BlockEdit::MergeBlocks`].

#[allow(unused_imports)]
use super::*;

pub(super) fn merge_blocks(
    txn: &mut TransactionMut,
    block_id: &str,
    into_block_id: &str,
) -> Result<(), CrdtError> {
    let (container, source) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let (_, target) = locate(txn, into_block_id).ok_or_else(|| missing(into_block_id))?;
    // Deleting the block would take its nested blocks with it, and a block
    // cannot merge into itself or into a block nested under it.
    if block_id == into_block_id || child_block_group(txn, &container).is_some() {
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: format!(
                "cannot merge into {into_block_id}: only a block without nested blocks merges, into another block"
            ),
        });
    }
    let mut pieces = snapshot_subtree(txn, &source)?.children;
    // A leading run joins the target's trailing run, so the join is one text
    // node, as ProseMirror's join leaves it.
    let trailing = match target.get(txn, target.len(txn).saturating_sub(1)) {
        Some(XmlOut::Text(run)) => Some(run),
        _ => None,
    };
    if let (Some(run), Some(Piece::Text(chunks))) = (trailing, pieces.first()) {
        for (chunk, attrs) in chunks {
            // An unmarked chunk is written with an explicit empty set, so it
            // does not inherit the mark of the text it follows.
            let attrs = attrs.as_deref().cloned().unwrap_or_default();
            let end = run.len(txn);
            match chunk {
                Chunk::Text(text) => run.insert_with_attributes(txn, end, text, attrs),
                Chunk::Embed(embed) => {
                    run.insert_embed_with_attributes(txn, end, embed.clone(), attrs);
                }
            }
        }
        pieces.remove(0);
    }
    restore_pieces(txn, &target, &pieces);
    delete(txn, block_id)
}
