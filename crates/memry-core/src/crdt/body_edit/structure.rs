//! Split from `body_edit.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;

/// Where `child` sits among `parent`'s children.
pub(super) fn child_index(
    txn: &TransactionMut,
    parent: &XmlElementRef,
    child: &XmlElementRef,
) -> Option<u32> {
    parent
        .children(txn)
        .position(|candidate| match candidate {
            XmlOut::Element(element) => element == *child,
            _ => false,
        })
        .map(|index| index as u32)
}

// MARK: - Moving blocks (N406)

/// The container's parent, which is a `blockGroup` for every real block.
pub(super) fn parent_of(container: &XmlElementRef) -> Option<XmlElementRef> {
    match container.parent() {
        Some(XmlOut::Element(element)) => Some(element),
        _ => None,
    }
}

pub(super) fn duplicate(
    txn: &mut TransactionMut,
    block_id: &str,
    new_block_id: &str,
) -> Result<(), CrdtError> {
    let (container, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let parent = parent_of(&container).ok_or_else(|| missing(block_id))?;
    let index = child_index(txn, &parent, &container).ok_or_else(|| missing(block_id))?;

    // The whole block, not its plain text: the original's props (a duplicate
    // of a red heading is a red heading), its marks and its inline nodes.
    let content = snapshot_subtree(txn, &block);
    let copy = parent.insert(txn, index + 1, XmlElementPrelim::empty("blockContainer"));
    copy.insert_attribute(txn, "id", new_block_id);
    restore_subtree(txn, &copy, 0, &content);
    Ok(())
}

/// An attribute value as an [`Any`], so a copy keeps its declared types.
pub(super) fn any_of(value: yrs::Out, txn: &TransactionMut) -> Any {
    match value {
        yrs::Out::Any(any) => any,
        other => Any::String(other.to_string(txn).into()),
    }
}

pub(super) fn move_block(
    txn: &mut TransactionMut,
    block_id: &str,
    after_block_id: Option<&str>,
) -> Result<(), CrdtError> {
    if after_block_id == Some(block_id) {
        // Moving a block after itself is a no-op, and treating it as one is
        // better than a delete-and-reinsert that churns the document.
        return Ok(());
    }

    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let snapshot = snapshot_subtree(txn, &container);

    let (target_parent, target_index) = match after_block_id {
        Some(id) => {
            let (anchor, _) = locate(txn, id).ok_or_else(|| missing(id))?;
            let parent = parent_of(&anchor).ok_or_else(|| missing(id))?;
            let index = child_index(txn, &parent, &anchor).ok_or_else(|| missing(id))?;
            (parent, index + 1)
        }
        None => (block_group(txn)?, 0),
    };

    // Removed first, so the insert index is computed against the document the
    // block will actually land in.
    let source_parent = parent_of(&container).ok_or_else(|| missing(block_id))?;
    let source_index =
        child_index(txn, &source_parent, &container).ok_or_else(|| missing(block_id))?;
    let adjusted = if source_parent == target_parent && source_index < target_index {
        target_index - 1
    } else {
        target_index
    };
    source_parent.remove_range(txn, source_index, 1);
    restore_subtree(txn, &target_parent, adjusted, &snapshot);
    drop_if_empty(txn, &source_parent);
    Ok(())
}

pub(super) fn indent(txn: &mut TransactionMut, block_id: &str) -> Result<(), CrdtError> {
    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let parent = parent_of(&container).ok_or_else(|| missing(block_id))?;
    let index = child_index(txn, &parent, &container).ok_or_else(|| missing(block_id))?;
    if index == 0 {
        // Desktop's rule: there is nothing to nest under.
        return Err(CrdtError::Undecodable {
            doc_id: block_id.to_owned(),
            what: "a block with no previous sibling cannot be indented".to_owned(),
        });
    }

    let previous = match parent.get(txn, index - 1) {
        Some(XmlOut::Element(element)) => element,
        _ => return Err(missing(block_id)),
    };
    // The sibling's own block is its first non-group child; the group of its
    // children is where this block goes.
    let group = child_block_group(txn, &previous)
        .unwrap_or_else(|| previous.push_back(txn, XmlElementPrelim::empty("blockGroup")));

    let snapshot = snapshot_subtree(txn, &container);
    parent.remove_range(txn, index, 1);
    let at = group.len(txn);
    restore_subtree(txn, &group, at, &snapshot);
    Ok(())
}

pub(super) fn outdent(txn: &mut TransactionMut, block_id: &str) -> Result<(), CrdtError> {
    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let group = parent_of(&container).ok_or_else(|| missing(block_id))?;
    // The group's parent is the container this block is nested inside. A block
    // already at the top has the fragment's own group as its parent, whose
    // parent is not a container, so there is nothing to lift to.
    let grandparent = parent_of(&group).ok_or_else(|| CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: "a top-level block cannot be outdented".to_owned(),
    })?;
    let outer = parent_of(&grandparent).ok_or_else(|| CrdtError::Undecodable {
        doc_id: block_id.to_owned(),
        what: "a top-level block cannot be outdented".to_owned(),
    })?;
    let anchor = child_index(txn, &outer, &grandparent).ok_or_else(|| missing(block_id))?;

    let index = child_index(txn, &group, &container).ok_or_else(|| missing(block_id))?;
    let snapshot = snapshot_subtree(txn, &container);
    group.remove_range(txn, index, 1);
    restore_subtree(txn, &outer, anchor + 1, &snapshot);
    drop_if_empty(txn, &group);
    Ok(())
}

/// Removes a nested `blockGroup` its last block just left. BlockNote's schema
/// requires a group to hold at least one block, so an empty one is invalid
/// for every reader. The document's own top-level group (whose parent is the
/// fragment, not an element) always stays.
fn drop_if_empty(txn: &mut TransactionMut, group: &XmlElementRef) {
    if group.tag().as_ref() != "blockGroup" || group.len(txn) > 0 {
        return;
    }
    let Some(container) = parent_of(group) else {
        return;
    };
    if let Some(index) = child_index(txn, &container, group) {
        container.remove_range(txn, index, 1);
    }
}

/// A block's own `blockGroup` of children, if it has one.
pub(super) fn child_block_group(
    txn: &TransactionMut,
    container: &XmlElementRef,
) -> Option<XmlElementRef> {
    container.children(txn).find_map(|child| match child {
        XmlOut::Element(inner) if inner.tag().as_ref() == "blockGroup" => Some(inner),
        _ => None,
    })
}

/// A container and everything under it, as plain data.
///
/// yrs has no move, so a relocation is a remove and a rebuild. **This is not
/// the whole-fragment replace §12.5.0.1 forbids**: that rule is about
/// re-seeding a document's entire contents from an external source, where a
/// concurrent edit to the old contents merges into tombstones and disappears.
/// This moves one subtree the user is holding, which is the operation they
/// asked for, and leaves every other block's identity untouched.
///
/// Children are kept **in order and with their formatting**: a text run is
/// its formatted chunks, not `get_string` (which renders marks as literal
/// `<bold>` tags), and a run and an inline node beside it stay in the order
/// they were in. Flattening either turned a moved block's bold text into tag
/// text, or moved a mention to the end of its paragraph (spec 004 TP026).
#[derive(Debug, Clone)]
pub(super) struct Subtree {
    tag: String,
    props: Vec<(String, Any)>,
    children: Vec<Piece>,
}

#[derive(Debug, Clone)]
enum Piece {
    /// One `XmlText`, as `(text, attributes)` chunks.
    Text(Vec<(String, Option<Box<yrs::types::Attrs>>)>),
    Element(Subtree),
}

pub(super) fn snapshot_subtree(txn: &TransactionMut, element: &XmlElementRef) -> Subtree {
    let tag = element.tag().clone();
    let children = element
        .children(txn)
        .filter_map(|child| match child {
            XmlOut::Text(run) => Some(Piece::Text(super::inline::formatted_tail(txn, &run, 0))),
            XmlOut::Element(inner) => Some(Piece::Element(snapshot_subtree(txn, &inner))),
            XmlOut::Fragment(_) => None,
        })
        .collect();
    Subtree {
        tag: tag.as_ref().to_owned(),
        props: element
            .attributes(txn)
            .map(|(name, value)| (name.to_owned(), any_of(value, txn)))
            .collect(),
        children,
    }
}

pub(super) fn restore_subtree(
    txn: &mut TransactionMut,
    parent: &XmlElementRef,
    index: u32,
    subtree: &Subtree,
) {
    let element = parent.insert(txn, index, XmlElementPrelim::empty(subtree.tag.as_str()));
    for (name, value) in &subtree.props {
        element.insert_attribute(txn, name.as_str(), value.clone());
    }
    for piece in &subtree.children {
        let at = element.len(txn);
        match piece {
            Piece::Text(chunks) => {
                if chunks.is_empty() {
                    continue;
                }
                let run = element.insert(txn, at, XmlTextPrelim::new(""));
                for (chunk, attrs) in chunks {
                    // Appended at the run's own length, in the document's
                    // offset unit, so no character count can drift from it.
                    let end = run.len(txn);
                    // An unmarked chunk is written with an explicit empty set:
                    // a plain insert would inherit the mark of the chunk
                    // before it.
                    let attrs = attrs.as_deref().cloned().unwrap_or_default();
                    run.insert_with_attributes(txn, end, chunk, attrs);
                }
            }
            Piece::Element(child) => restore_subtree(txn, &element, at, child),
        }
    }
}

// MARK: - Inline marks (N407)
