//! Backspace at the start of a block: its inline content joins the end of the
//! block above, and the block goes. See [`BlockEdit::MergeBlocks`]. Its
//! inverse, Return inside a block's text: [`BlockEdit::SplitBlock`].

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

pub(super) fn split_block(
    txn: &mut TransactionMut,
    block_id: &str,
    at: u32,
    kind: Option<&str>,
    new_block_id: &str,
) -> Result<(), CrdtError> {
    let refused = |what: &str| CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: what.to_owned(),
    };
    let (container, source) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    if child_block_group(txn, &container).is_some() {
        return Err(refused("a block with nested blocks does not split"));
    }
    let source_kind = source.tag().as_ref().to_owned();
    if !node_shapes::holds_inline(&source_kind)
        || kind.is_some_and(|kind| !node_shapes::holds_inline(kind))
    {
        return Err(refused(
            "only inline content splits, into a block that holds it",
        ));
    }
    if kind.is_some_and(|kind| {
        node_shapes::holds_plain_text(kind) && !node_shapes::holds_plain_text(&source_kind)
    }) {
        return Err(refused(
            "marks and inline nodes do not split into plain text",
        ));
    }
    let (_, units) = flatten(txn, &source);
    // The first child that moves, and where in it: a run splits at the
    // character the caret is before, a node moves whole.
    let (first, offset) = match units.get(at as usize) {
        Some(Unit::Text { child, offset, .. }) => (*child, *offset),
        Some(Unit::Node { child }) => (*child, 0),
        None if at as usize == units.len() => (source.len(txn), 0),
        None => return Err(refused("that offset is past the block's end")),
    };
    // Every piece is read before anything is removed: a run or node a copy
    // cannot carry is refused while the block is still whole.
    let mut pieces = Vec::new();
    let mut from = first;
    let mut cut = None;
    if offset > 0 {
        let Some(XmlOut::Text(run)) = source.get(txn, first) else {
            return Err(refused("that offset is not in a run of text"));
        };
        pieces.push(Piece::Text(formatted_tail(txn, &run, offset)?));
        cut = Some(run);
        from += 1;
    }
    for index in from..source.len(txn) {
        match source.get(txn, index) {
            Some(XmlOut::Text(run)) => pieces.push(Piece::Text(formatted_tail(txn, &run, 0)?)),
            Some(XmlOut::Element(element)) => {
                pieces.push(Piece::Element(snapshot_subtree(txn, &element)?))
            }
            _ => {}
        }
    }
    if let Some(run) = cut {
        let length = run.len(txn);
        run.remove_range(txn, offset, length - offset);
    }
    let moved = source.len(txn) - from;
    if moved > 0 {
        source.remove_range(txn, from, moved);
    }
    insert_block(
        txn,
        kind.unwrap_or(&source_kind),
        Some(block_id),
        "",
        new_block_id,
    )?;
    let (_, block) = locate(txn, new_block_id).ok_or_else(|| missing(new_block_id))?;
    if kind.is_none() {
        let props: Vec<(String, Any)> = source
            .attributes(txn)
            .map(|(name, value)| (name.to_owned(), any_of(value, txn)))
            .collect();
        for (name, value) in props {
            block.insert_attribute(txn, name, value);
        }
    }
    restore_pieces(txn, &block, &pieces);
    Ok(())
}
