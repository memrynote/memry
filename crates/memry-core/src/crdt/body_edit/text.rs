//! Split from `body_edit.rs` along its existing seams; see `mod.rs`.

#[allow(unused_imports)]
use super::*;

pub(super) fn set_text(
    txn: &mut TransactionMut,
    block_id: &str,
    text: &str,
) -> Result<(), CrdtError> {
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let kind = block.tag().clone();
    // A task block's text is its `title` prop, not inline content, so writing
    // it as content would produce a node BlockNote renders empty.
    if let Some(name) = node_shapes::text_prop(kind.as_ref()) {
        block.insert_attribute(txn, name, text);
        return Ok(());
    }
    replace_inline(txn, &block, text);
    Ok(())
}

/// Replaces an element's inline content, keeping its nested blocks.
///
/// Every child that is content goes together: a block's inline content is
/// text *and* inline nodes, and replacing the text means replacing both. A
/// `blockGroup` child is the block's nested children and survives, or
/// retyping a list item would delete everything indented under it.
pub(super) fn replace_inline(txn: &mut TransactionMut, element: &XmlElementRef, text: &str) {
    let mut removals = Vec::new();
    for (index, child) in element.children(txn).enumerate() {
        match child {
            XmlOut::Element(inner) if inner.tag().as_ref() == "blockGroup" => {}
            _ => removals.push(index as u32),
        }
    }
    // Back to front, so each index is still valid when it is reached.
    for index in removals.into_iter().rev() {
        element.remove_range(txn, index, 1);
    }
    if !text.is_empty() {
        element.insert(txn, 0, XmlTextPrelim::new(text));
    }
}

/// Sets one prop, **in its declared type** (N408).
///
/// The value crosses the FFI as text because a shell has one string field to
/// put it in, and it is converted here against the block's declared shape.
///
/// **This is not tidiness.** The reference writer stores `checked` as the
/// boolean `true`; storing the string `"true"` produces a document that reads
/// differently, because a non-empty string is truthy — so unticking a box,
/// written as `"false"`, reads as **ticked** anywhere the prop is tested for
/// truth. A prop whose declared type this build does not know is written as
/// text, which is the honest fallback for a schema that has moved on.
pub(super) fn set_prop(
    txn: &mut TransactionMut,
    block_id: &str,
    name: &str,
    value: &str,
) -> Result<(), CrdtError> {
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let kind = block.tag().clone();
    block.insert_attribute(txn, name, typed_prop(kind.as_ref(), name, value));
    Ok(())
}

/// One prop value in the type its block declares for it.
pub(super) fn typed_prop(kind: &str, name: &str, value: &str) -> Any {
    let declared = node_shapes::defaults_for(kind)
        .into_iter()
        .flatten()
        .find(|prop| prop.name == name)
        .map(|prop| prop.value);

    match declared {
        Some(node_shapes::PropValue::Bool(_)) => Any::Bool(value == "true"),
        Some(node_shapes::PropValue::Number(_)) => value
            .parse::<f64>()
            .map(Any::Number)
            .unwrap_or_else(|_| Any::String(value.into())),
        // `start` and `previewWidth` are declared undefined and take a real
        // value once set, so an empty string means "back to unset".
        Some(node_shapes::PropValue::Undefined) if value.is_empty() => Any::Undefined,
        Some(node_shapes::PropValue::Undefined) => value
            .parse::<f64>()
            .map(Any::Number)
            .unwrap_or_else(|_| Any::String(value.into())),
        _ => Any::String(value.into()),
    }
}

/// Changes a block's type while keeping what it says (N405).
///
/// Rebuilt rather than renamed, because a node's **tag is not editable** in
/// yrs and because the target type declares different props: a paragraph
/// turned into a heading needs a `level` it never had. The inline content is
/// carried across as text.
///
/// **The container and its id survive**, so every reference to this block —
/// a caret, a selection, a nested `blockGroup` of children — still resolves.
pub(super) fn turn_into(
    txn: &mut TransactionMut,
    block_id: &str,
    kind: &str,
) -> Result<(), CrdtError> {
    let (container, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    if node_shapes::defaults_for(kind).is_none() {
        return Err(CrdtError::Undecodable {
            doc_id: kind.to_owned(),
            what: "this build does not know how to shape that block type".to_owned(),
        });
    }

    let carried = block_text(txn, &block);

    // The old block, and only it: a `blockGroup` of children is a sibling of
    // the block inside the container and must outlive the change, or turning
    // a list item into a paragraph would orphan everything nested under it.
    let index = container
        .children(txn)
        .position(|child| match child {
            XmlOut::Element(inner) => inner.tag().as_ref() != "blockGroup",
            _ => true,
        })
        .ok_or_else(|| missing(block_id))? as u32;
    container.remove_range(txn, index, 1);

    let defaults = node_shapes::defaults_for(kind).unwrap_or_default();
    let rebuilt = container.insert(txn, index, XmlElementPrelim::empty(kind));
    for prop in &defaults {
        rebuilt.insert_attribute(txn, prop.name, prop.value.to_any());
    }
    if !carried.is_empty() {
        if node_shapes::holds_inline(kind) {
            rebuilt.insert(txn, 0, XmlTextPrelim::new(&carried));
        } else if let Some(name) = node_shapes::text_prop(kind) {
            rebuilt.insert_attribute(txn, name, carried.as_str());
        }
    }
    Ok(())
}

/// A block's own text, from wherever that type keeps it.
pub(super) fn block_text(txn: &TransactionMut, block: &XmlElementRef) -> String {
    let tag = block.tag().clone();
    if let Some(name) = node_shapes::text_prop(tag.as_ref()) {
        return attribute(txn, block, name).unwrap_or_default();
    }
    let mut out = String::new();
    for child in block.children(txn) {
        match child {
            XmlOut::Text(text) => out.push_str(&text.get_string(txn)),
            // A nested block is its own entry and must not be folded in.
            _ => continue,
        }
    }
    out
}

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

// MARK: - Tables (N402, N403, N404)
