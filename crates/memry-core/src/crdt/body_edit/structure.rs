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

// MARK: - Inserting blocks

/// The `blockGroup` a new top-level block belongs in (§12.5.0).
///
/// **This is the function the chapter calls the single most dangerous thing a
/// writing client can get wrong.** The fragment's one top-level child is a
/// `blockGroup`; a `blockContainer` placed beside it is a second top-level
/// child, and a `doc` with two is not constructible, so y-prosemirror answers
/// by **deleting the element**. Nothing fails at any layer a naive writer can
/// see: the update applies, the document encodes, `extract_text` may still
/// return the text, and the block is simply gone the next time the note opens.
///
/// So a writer **locates** its parent rather than assuming one: it appends
/// inside the existing group, creates the group when the fragment is empty,
/// and **refuses** a top-level layout it does not recognise rather than
/// guessing. Refusing is correct because the alternatives are a deletion the
/// user never sees and a document a peer cannot construct.
pub(super) fn block_group(txn: &mut TransactionMut) -> Result<XmlElementRef, CrdtError> {
    let fragment = txn
        .get_xml_fragment(BODY_FRAGMENT)
        .ok_or_else(|| unrecognised_layout("the body fragment is missing"))?;

    let children: Vec<XmlOut> = fragment.children(txn).collect();
    if children.is_empty() {
        return Ok(fragment.push_back(txn, XmlElementPrelim::empty("blockGroup")));
    }

    let mut group: Option<XmlElementRef> = None;
    for child in children {
        match child {
            XmlOut::Element(element) if element.tag().as_ref() == "blockGroup" => {
                if group.is_some() {
                    // Two groups is already a layout no BlockNote writer
                    // produces; appending into one of them would be a guess.
                    return Err(unrecognised_layout(
                        "the body has more than one top-level blockGroup",
                    ));
                }
                group = Some(element);
            }
            // A `blockContainer` or loose text directly under the fragment is
            // the shape §12.5.0 warns about. A writer that added to it would
            // be adding to a document a peer cannot construct.
            _ => {
                return Err(unrecognised_layout(
                    "the body's top level is not a single blockGroup",
                ));
            }
        }
    }

    group.ok_or_else(|| unrecognised_layout("the body has no top-level blockGroup"))
}

/// The refusal §12.5.0 demands for a layout this writer does not recognise.
pub(super) fn unrecognised_layout(what: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: BODY_FRAGMENT.to_owned(),
        what: format!("refusing to write into a body whose shape is unrecognised: {what}"),
    }
}

/// Builds one block node, with its declared props (§12.5.0).
///
/// The props are written explicitly rather than omitted, because that is what
/// BlockNote's own writer does and a block missing them is not the same
/// document even though it renders identically.
pub(super) fn build_block(
    txn: &mut TransactionMut,
    container: &XmlElementRef,
    kind: &str,
    text: &str,
) -> Result<XmlElementRef, CrdtError> {
    let defaults = node_shapes::defaults_for(kind).ok_or_else(|| CrdtError::Undecodable {
        doc_id: kind.to_owned(),
        what: "this build does not know how to shape that block type".to_owned(),
    })?;

    let block = container.insert(txn, 0, XmlElementPrelim::empty(kind));
    for prop in &defaults {
        block.insert_attribute(txn, prop.name, prop.value.to_any());
    }
    if kind == "table" {
        build_empty_grid(txn, &block);
    }

    if !text.is_empty() {
        if node_shapes::holds_inline(kind) {
            block.insert(txn, 0, XmlTextPrelim::new(text));
        } else if let Some(name) = node_shapes::text_prop(kind) {
            // A task block's text is a prop, not inline content.
            block.insert_attribute(txn, name, text);
        }
        // A type that holds neither drops the text rather than inventing a
        // place for it: a divider with a caption is not a thing.
    }
    Ok(block)
}

pub(super) fn insert_block(
    txn: &mut TransactionMut,
    kind: &str,
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
            // The end of the body — **inside the blockGroup**, never beside it.
            let group = block_group(txn)?;
            let index = group.children(txn).count() as u32;
            (group, index)
        }
    };

    let container = parent.insert(txn, index, prelim);
    container.insert_attribute(txn, "id", new_block_id);
    build_block(txn, &container, kind, text)?;
    Ok(())
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
    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let parent = parent_of(&container).ok_or_else(|| missing(block_id))?;
    let index = child_index(txn, &parent, &container).ok_or_else(|| missing(block_id))?;

    // The whole container, not its plain text and not only its block: the
    // original's props (a duplicate of a red heading is a red heading), its
    // marks, its inline nodes, and every block nested under it.
    let mut copy = snapshot_subtree(txn, &container);
    // Every container in the copy needs an id of its own: two blocks sharing
    // one are two blocks no edit can tell apart.
    copy.set_prop("id", Any::String(new_block_id.into()));
    for piece in &mut copy.children {
        if let Piece::Element(child) = piece {
            child.mint_container_ids();
        }
    }
    restore_subtree(txn, &parent, index + 1, &copy);
    Ok(())
}

/// A fresh block id in BlockNote's own format, a lowercase UUID v4.
pub(super) fn new_block_id() -> String {
    let mut bytes = crate::crypto::sodium::random_bytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
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
pub(super) fn drop_if_empty(txn: &mut TransactionMut, group: &XmlElementRef) {
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
    pub(super) tag: String,
    pub(super) props: Vec<(String, Any)>,
    pub(super) children: Vec<Piece>,
}

impl Subtree {
    /// Sets `name`, replacing the value it had.
    pub(super) fn set_prop(&mut self, name: &str, value: Any) {
        match self.props.iter_mut().find(|(key, _)| key == name) {
            Some((_, existing)) => *existing = value,
            None => self.props.push((name.to_owned(), value)),
        }
    }

    /// Mints a fresh id for each `blockContainer` in this subtree whose id is
    /// in `taken`.
    pub(super) fn mint_taken_container_ids(&mut self, taken: &std::collections::HashSet<String>) {
        if self.tag == "blockContainer" {
            let id = self.props.iter().find_map(|(name, value)| match value {
                Any::String(id) if name == "id" => Some(id.to_string()),
                _ => None,
            });
            if id.is_some_and(|id| taken.contains(&id)) {
                self.set_prop("id", Any::String(new_block_id().into()));
            }
        }
        for piece in &mut self.children {
            if let Piece::Element(child) = piece {
                child.mint_taken_container_ids(taken);
            }
        }
    }

    /// Gives this subtree's every `blockContainer` a freshly minted id.
    fn mint_container_ids(&mut self) {
        if self.tag == "blockContainer" {
            self.set_prop("id", Any::String(new_block_id().into()));
        }
        for piece in &mut self.children {
            if let Piece::Element(child) = piece {
                child.mint_container_ids();
            }
        }
    }

    /// The text this subtree holds, marks and node boundaries dropped.
    pub(super) fn plain_text(&self) -> String {
        let mut out = String::new();
        for piece in &self.children {
            piece.push_plain_text(&mut out);
        }
        out
    }
}

#[derive(Debug, Clone)]
pub(super) enum Piece {
    /// One `XmlText`, as `(text, attributes)` chunks.
    Text(Vec<(String, Option<Box<yrs::types::Attrs>>)>),
    Element(Subtree),
}

impl Piece {
    fn push_plain_text(&self, out: &mut String) {
        match self {
            Piece::Text(chunks) => chunks.iter().for_each(|(chunk, _)| out.push_str(chunk)),
            Piece::Element(child) => child
                .children
                .iter()
                .for_each(|piece| piece.push_plain_text(out)),
        }
    }
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
    restore_pieces(txn, &element, &subtree.children);
}

/// Appends `pieces` to `element`'s children, formatting and order kept.
pub(super) fn restore_pieces(txn: &mut TransactionMut, element: &XmlElementRef, pieces: &[Piece]) {
    for piece in pieces {
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
            Piece::Element(child) => restore_subtree(txn, element, at, child),
        }
    }
}

// MARK: - Inline marks (N407)
