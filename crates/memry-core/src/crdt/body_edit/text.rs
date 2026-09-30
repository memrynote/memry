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
    // One plain run: edit it in place, so a concurrent insert from another
    // device outside the changed span survives the merge (spec 005-journal
    // JP082). Replacing the run deleted whatever a peer had typed into it.
    if let Some((run, current)) = sole_plain_run(txn, &block) {
        edit_in_place(txn, &run, &current, text);
        return Ok(());
    }
    replace_inline(txn, &block, text);
    Ok(())
}

/// The placeholder a shell spells an inline node with in `ReplaceText`.
pub const INLINE_NODE_PLACEHOLDER: char = '\u{FFFC}';

/// One character of a block's flattened inline content, and where it lives.
#[derive(Clone)]
enum Unit {
    /// A character inside the text run at `child`, starting at `offset`
    /// (the document's offset kind, UTF-8 bytes) and `len` long.
    Text { child: u32, offset: u32, len: u32 },
    /// A whole inline node, the element at `child`.
    Node { child: u32 },
}

/// The block's inline content as characters, inline nodes as U+FFFC.
///
/// Only an element [`crate::crdt::blocks::is_inline_node`] names is a
/// placeholder, because only those reach the shell: `extract_blocks` skips
/// every other element, a `hardBreak` included. Such an element takes no
/// position here either, so the shell's text and this one line up and a diff
/// can never remove it.
fn flatten(txn: &TransactionMut, block: &XmlElementRef) -> (Vec<char>, Vec<Unit>) {
    let mut chars = Vec::new();
    let mut units = Vec::new();
    for (index, child) in block.children(txn).enumerate() {
        let child_index = index as u32;
        match child {
            XmlOut::Element(inner) if inner.tag().as_ref() == "blockGroup" => {}
            XmlOut::Text(run) => {
                let mut offset = 0u32;
                for chunk in run.diff(txn, yrs::types::text::YChange::identity) {
                    match chunk.insert {
                        yrs::Out::Any(Any::String(piece)) => {
                            for character in piece.chars() {
                                let len = character.len_utf8() as u32;
                                chars.push(character);
                                units.push(Unit::Text {
                                    child: child_index,
                                    offset,
                                    len,
                                });
                                offset += len;
                            }
                        }
                        // An embed inside a text run occupies one position.
                        _ => {
                            chars.push(INLINE_NODE_PLACEHOLDER);
                            units.push(Unit::Text {
                                child: child_index,
                                offset,
                                len: 1,
                            });
                            offset += 1;
                        }
                    }
                }
            }
            XmlOut::Element(inner) if crate::crdt::blocks::is_inline_node(inner.tag().as_ref()) => {
                chars.push(INLINE_NODE_PLACEHOLDER);
                units.push(Unit::Node { child: child_index });
            }
            XmlOut::Element(_) | XmlOut::Fragment(_) => {}
        }
    }
    (chars, units)
}

/// The span `from` and `to` differ in, by common prefix and suffix: the start,
/// the end of the span in `from`, and the end of the span in `to`.
fn changed_span(from: &[char], to: &[char]) -> (usize, usize, usize) {
    let prefix = from
        .iter()
        .zip(to.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let suffix = from[prefix..]
        .iter()
        .rev()
        .zip(to[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    (prefix, from.len() - suffix, to.len() - suffix)
}

/// The shell's edit, `base` to `wanted`, replayed on the live block `current`.
///
/// A shell holding unsaved typing does not see a peer's edit that merged in
/// the meantime, so its `wanted` lacks it; diffing `wanted` against the live
/// block would delete it. Instead the peer's span (`base` to `current`) and the
/// user's span (`base` to `wanted`) are both taken against `base`, and the
/// user's span is moved past the peer's. Where the two overlap the peer's new
/// text is kept, as the CRDT merge of the two edits would keep it: the user's
/// delete removes what it covered around the peer's text, never the text.
fn rebase(base: &[char], current: &[char], wanted: &[char]) -> Vec<char> {
    let (peer_start, peer_end_base, peer_end_live) = changed_span(base, current);
    let (start, end_base, end_wanted) = changed_span(base, wanted);
    let inserted = &wanted[start..end_wanted];
    // A base position at or after the peer's span, in the live block.
    let shift = |position: usize| position + peer_end_live - peer_end_base;
    let (head, tail) = if end_base <= peer_start {
        (current[..start].to_vec(), end_base)
    } else if start >= peer_end_base {
        (current[..shift(start)].to_vec(), shift(end_base))
    } else {
        // Overlapping: the peer's new text survives, and the user's change
        // lands on whichever side of it the user's span started.
        let tail = shift(end_base).max(peer_end_live);
        if start <= peer_start {
            let mut out = current[..start].to_vec();
            out.extend_from_slice(inserted);
            out.extend_from_slice(&current[peer_start..peer_end_live]);
            out.extend_from_slice(&current[tail..]);
            return out;
        }
        (current[..peer_end_live].to_vec(), tail)
    };
    let mut out = head;
    out.extend_from_slice(inserted);
    out.extend_from_slice(&current[tail..]);
    out
}

/// Rewrites a block's text in place across its runs and inline nodes. See
/// [`BlockEdit::ReplaceText`].
pub(super) fn replace_text(
    txn: &mut TransactionMut,
    block_id: &str,
    text: &str,
    base: Option<&str>,
) -> Result<(), CrdtError> {
    let (_, block) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let kind = block.tag().clone();
    if let Some(name) = node_shapes::text_prop(kind.as_ref()) {
        block.insert_attribute(txn, name, text);
        return Ok(());
    }

    let (current, units) = flatten(txn, &block);
    let mut wanted: Vec<char> = text.chars().collect();
    if let Some(base) = base {
        let base: Vec<char> = base.chars().collect();
        if base != current {
            wanted = rebase(&base, &current, &wanted);
        }
    }
    let (prefix, removed_end, inserted_end) = changed_span(&current, &wanted);
    let removed = prefix..removed_end;
    let inserted: String = wanted[prefix..inserted_end]
        .iter()
        .filter(|character| **character != INLINE_NODE_PLACEHOLDER)
        .collect();
    if removed.is_empty() && inserted.is_empty() {
        return Ok(());
    }

    // Where the insert lands, resolved to the run itself before anything is
    // removed: removing a node shifts child indices, a run reference does not
    // move. Deletions only ever happen at or after the caret, so an offset to
    // its left stays valid.
    enum Anchor {
        /// Into this run at `offset`: after the character before the caret,
        /// so the new text takes that character's marks.
        Run(XmlTextRef, u32),
        /// A fresh run directly after this node, or at the start of the block
        /// when `None`: no text run touches the caret.
        Fresh(Option<XmlElementRef>),
    }
    let text_run = |txn: &TransactionMut, child: u32| match block.get(txn, child) {
        Some(XmlOut::Text(run)) => Some(run),
        _ => None,
    };
    let before = prefix.checked_sub(1).map(|index| units[index].clone());
    let after = units.get(removed.end).cloned();
    let anchor = match (before, after) {
        (Some(Unit::Text { child, offset, len }), _) => {
            let run = text_run(txn, child).ok_or_else(|| unrecognised_layout("a text run"))?;
            Anchor::Run(run, offset + len)
        }
        // Every character of that run before the caret is being removed, so
        // after the removal the caret is at its start.
        (_, Some(Unit::Text { child, .. })) => {
            let run = text_run(txn, child).ok_or_else(|| unrecognised_layout("a text run"))?;
            Anchor::Run(run, 0)
        }
        (Some(Unit::Node { child }), _) => match block.get(txn, child) {
            Some(XmlOut::Element(node)) => Anchor::Fresh(Some(node)),
            _ => return Err(unrecognised_layout("an inline node")),
        },
        (None, _) => Anchor::Fresh(None),
    };

    // Removal, back to front so every earlier position stays valid: one range
    // per run, one child per node.
    let mut spans: Vec<(u32, Option<(u32, u32)>)> = Vec::new();
    for unit in &units[removed.clone()] {
        match unit {
            Unit::Text { child, offset, len } => match spans.last_mut() {
                Some((last, Some((_, length)))) if *last == *child => *length += len,
                _ => spans.push((*child, Some((*offset, *len)))),
            },
            Unit::Node { child } => spans.push((*child, None)),
        }
    }
    for (child, span) in spans.into_iter().rev() {
        match span {
            Some((start, length)) => {
                if let Some(run) = text_run(txn, child) {
                    run.remove_range(txn, start, length);
                }
            }
            None => block.remove_range(txn, child, 1),
        }
    }

    if inserted.is_empty() {
        return Ok(());
    }
    match anchor {
        Anchor::Run(run, offset) => run.insert(txn, offset, &inserted),
        Anchor::Fresh(node) => {
            let index = match node {
                Some(node) => {
                    child_index(txn, &block, &node)
                        .ok_or_else(|| unrecognised_layout("an inline node"))?
                        + 1
                }
                None => 0,
            };
            block.insert(txn, index, XmlTextPrelim::new(inserted));
        }
    }
    Ok(())
}

/// Where `node` sits among `parent`'s children.
fn child_index(txn: &TransactionMut, parent: &XmlElementRef, node: &XmlElementRef) -> Option<u32> {
    parent
        .children(txn)
        .position(|child| matches!(child, XmlOut::Element(inner) if inner == *node))
        .map(|index| index as u32)
}

/// The block's inline content when it is exactly one text run with no marks
/// and no inline nodes (nested `blockGroup` children aside), with its text.
fn sole_plain_run(txn: &TransactionMut, element: &XmlElementRef) -> Option<(XmlTextRef, String)> {
    let mut found = None;
    for child in element.children(txn) {
        match child {
            XmlOut::Element(inner) if inner.tag().as_ref() == "blockGroup" => {}
            XmlOut::Text(run) if found.is_none() => found = Some(run),
            _ => return None,
        }
    }
    let run = found?;
    let mut plain = String::new();
    for chunk in run.diff(txn, yrs::types::text::YChange::identity) {
        if chunk.attributes.is_some() {
            return None;
        }
        match chunk.insert {
            yrs::Out::Any(Any::String(piece)) => plain.push_str(&piece),
            _ => return None,
        }
    }
    Some((run, plain))
}

/// Rewrites `run` from `current` to `wanted` by deleting and inserting only
/// the span between their common prefix and suffix. Offsets are UTF-8 bytes,
/// the document's offset kind, taken at char boundaries.
fn edit_in_place(txn: &mut TransactionMut, run: &XmlTextRef, current: &str, wanted: &str) {
    if current == wanted {
        return;
    }
    let prefix: usize = current
        .chars()
        .zip(wanted.chars())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum();
    let suffix: usize = current[prefix..]
        .chars()
        .rev()
        .zip(wanted[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum();
    let removed = current.len() - prefix - suffix;
    if removed > 0 {
        run.remove_range(txn, prefix as u32, removed as u32);
    }
    let inserted = &wanted[prefix..wanted.len() - suffix];
    if !inserted.is_empty() {
        run.insert(txn, prefix as u32, inserted);
    }
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
/// turned into a heading needs a `level` it never had.
///
/// The inline content is **moved, not re-typed**: its runs keep their marks
/// and its inline nodes (a tag, a wiki link, a date) stay nodes, in order.
/// Rebuilding it from `get_string` wrote marks as literal `<bold>` text and
/// dropped every node. A code block takes plain text only, because its schema
/// holds no marks and no nodes and a node y-prosemirror cannot build is
/// deleted (§12.5.0); a task block keeps its text in a prop.
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

    let source = block.tag().clone();
    let carried = snapshot_subtree(txn, &block);
    let plain = match node_shapes::text_prop(source.as_ref()) {
        Some(name) => attribute(txn, &block, name).unwrap_or_default(),
        None => carried.plain_text(),
    };
    let rich = node_shapes::text_prop(source.as_ref()).is_none() && kind != "codeBlock";

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
    if node_shapes::holds_inline(kind) {
        if rich {
            restore_pieces(txn, &rebuilt, &carried.children);
        } else if !plain.is_empty() {
            rebuilt.insert(txn, 0, XmlTextPrelim::new(&plain));
        }
    } else if let Some(name) = node_shapes::text_prop(kind)
        && !plain.is_empty()
    {
        rebuilt.insert_attribute(txn, name, plain.as_str());
    }
    Ok(())
}

// MARK: - Tables (N402, N403, N404)
