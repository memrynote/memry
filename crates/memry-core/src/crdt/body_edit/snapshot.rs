//! A block's whole subtree as text, so an undo can put it back (iOS undo).
//!
//! A delete cannot be undone from an operation: yrs collects what it deleted,
//! and the shell never held the subtree. So before deleting, or before
//! changing a block's type, the shell reads a snapshot and its undo step
//! carries it back as [`BlockEdit::RestoreBlock`].
//!
//! **The snapshot lives in the shell's undo stack and nowhere else.** It is
//! never stored or synced; what reaches the log is the ordinary update the
//! restore authors. Its format is private to this module and may change
//! between builds, which is safe because an undo stack does not outlive the
//! open note.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[allow(unused_imports)]
use super::*;

/// The snapshot: the container with everything under it, and where it sat.
#[derive(Serialize, Deserialize)]
struct BlockSnapshot {
    /// The container's own id, kept on restore so a peer's reference to the
    /// block, and the shell's redo, still resolve.
    id: String,
    /// The container this block was nested in, `None` at the top level.
    parent: Option<String>,
    /// The sibling it followed, `None` when it was first.
    previous: Option<String>,
    container: Node,
}

#[derive(Serialize, Deserialize)]
struct Node {
    tag: String,
    props: Vec<(String, Value)>,
    children: Vec<Part>,
}

/// A run's formatting: mark name to its attributes.
type Marks = Vec<(String, Value)>;

#[derive(Serialize, Deserialize)]
enum Part {
    Text(Vec<(String, Option<Marks>)>),
    Element(Node),
}

/// An [`Any`], tagged, so a number stays a number and `undefined` stays
/// distinct from `null`: plain JSON would lose both, and a prop restored in the
/// wrong type reads differently (N408).
#[derive(Serialize, Deserialize)]
enum Value {
    Null,
    Undefined,
    Bool(bool),
    Number(f64),
    BigInt(i64),
    String(String),
    Buffer(Vec<u8>),
    Array(Vec<Value>),
    Map(Vec<(String, Value)>),
}

impl From<&Any> for Value {
    fn from(any: &Any) -> Self {
        match any {
            Any::Null => Value::Null,
            Any::Undefined => Value::Undefined,
            Any::Bool(value) => Value::Bool(*value),
            Any::Number(value) => Value::Number(*value),
            Any::BigInt(value) => Value::BigInt(*value),
            Any::String(value) => Value::String(value.to_string()),
            Any::Buffer(value) => Value::Buffer(value.to_vec()),
            Any::Array(values) => Value::Array(values.iter().map(Value::from).collect()),
            Any::Map(entries) => Value::Map(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), Value::from(value)))
                    .collect(),
            ),
        }
    }
}

impl From<&Value> for Any {
    fn from(value: &Value) -> Self {
        match value {
            Value::Null => Any::Null,
            Value::Undefined => Any::Undefined,
            Value::Bool(value) => Any::Bool(*value),
            Value::Number(value) => Any::Number(*value),
            Value::BigInt(value) => Any::BigInt(*value),
            Value::String(value) => Any::String(value.as_str().into()),
            Value::Buffer(value) => Any::Buffer(value.as_slice().into()),
            Value::Array(values) => Any::Array(values.iter().map(Any::from).collect()),
            Value::Map(entries) => Any::Map(
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), Any::from(value)))
                    .collect::<HashMap<_, _>>()
                    .into(),
            ),
        }
    }
}

fn props_out(props: &[(String, Any)]) -> Vec<(String, Value)> {
    props
        .iter()
        .map(|(name, value)| (name.clone(), Value::from(value)))
        .collect()
}

fn node_of(subtree: &Subtree) -> Node {
    Node {
        tag: subtree.tag.clone(),
        props: props_out(&subtree.props),
        children: subtree
            .children
            .iter()
            .map(|piece| match piece {
                Piece::Text(chunks) => Part::Text(
                    chunks
                        .iter()
                        .map(|(text, attrs)| {
                            let attrs = attrs.as_deref().map(|attrs| {
                                attrs
                                    .iter()
                                    .map(|(name, value)| (name.to_string(), Value::from(value)))
                                    .collect()
                            });
                            (text.clone(), attrs)
                        })
                        .collect(),
                ),
                Piece::Element(child) => Part::Element(node_of(child)),
            })
            .collect(),
    }
}

fn subtree_of(node: &Node) -> Subtree {
    Subtree {
        tag: node.tag.clone(),
        props: node
            .props
            .iter()
            .map(|(name, value)| (name.clone(), Any::from(value)))
            .collect(),
        children: node
            .children
            .iter()
            .map(|part| match part {
                Part::Text(chunks) => Piece::Text(
                    chunks
                        .iter()
                        .map(|(text, attrs)| {
                            let attrs = attrs.as_ref().map(|attrs| {
                                Box::new(
                                    attrs
                                        .iter()
                                        .map(|(name, value)| {
                                            (name.as_str().into(), Any::from(value))
                                        })
                                        .collect::<yrs::types::Attrs>(),
                                )
                            });
                            (text.clone(), attrs)
                        })
                        .collect(),
                ),
                Part::Element(child) => Piece::Element(subtree_of(child)),
            })
            .collect(),
    }
}

fn unreadable(what: String) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: "block snapshot".to_owned(),
        what,
    }
}

/// The container id of the container `group` belongs to, when it is nested.
fn enclosing_id(txn: &TransactionMut, group: &XmlElementRef) -> Option<String> {
    let container = parent_of(group)?;
    (container.tag().as_ref() == "blockContainer")
        .then(|| attribute(txn, &container, "id"))
        .flatten()
}

/// Reads `block_id`'s container, with everything under it, as a snapshot
/// [`BlockEdit::RestoreBlock`] takes back. Writes nothing.
pub(super) fn snapshot_block(txn: &TransactionMut, block_id: &str) -> Result<String, CrdtError> {
    let (container, _) = locate(txn, block_id).ok_or_else(|| missing(block_id))?;
    let group = parent_of(&container).ok_or_else(|| missing(block_id))?;
    let index = child_index(txn, &group, &container).ok_or_else(|| missing(block_id))?;
    let previous = index
        .checked_sub(1)
        .and_then(|before| match group.get(txn, before) {
            Some(XmlOut::Element(sibling)) => attribute(txn, &sibling, "id"),
            _ => None,
        });
    let snapshot = BlockSnapshot {
        id: block_id.to_owned(),
        parent: enclosing_id(txn, &group),
        previous,
        container: node_of(&snapshot_subtree(txn, &container)),
    };
    serde_json::to_string(&snapshot).map_err(|error| unreadable(error.to_string()))
}

/// Puts a snapshot back. See [`BlockEdit::RestoreBlock`].
pub(super) fn restore_block(txn: &mut TransactionMut, snapshot: &str) -> Result<(), CrdtError> {
    let snapshot: BlockSnapshot =
        serde_json::from_str(snapshot).map_err(|error| unreadable(error.to_string()))?;
    let container = subtree_of(&snapshot.container);

    if let Some((existing, block)) = locate(txn, &snapshot.id) {
        // The block is still here (a type change being undone): only its own
        // element goes back. The children beside it are their own blocks, and
        // may have been edited since.
        let saved = container
            .children
            .iter()
            .find_map(|piece| match piece {
                Piece::Element(child) if child.tag != "blockGroup" => Some(child),
                _ => None,
            })
            .ok_or_else(|| unreadable("the snapshot holds no block".to_owned()))?;
        let index =
            child_index(txn, &existing, &block).ok_or_else(|| missing(snapshot.id.as_str()))?;
        existing.remove_range(txn, index, 1);
        restore_subtree(txn, &existing, index, saved);
        return Ok(());
    }

    // Gone (a delete being undone): back after the sibling it followed, else
    // first in the block it was nested in, else first in the body.
    let after_previous = snapshot.previous.as_deref().and_then(|id| {
        let (anchor, _) = locate(txn, id)?;
        let group = parent_of(&anchor)?;
        let index = child_index(txn, &group, &anchor)?;
        Some((group, index + 1))
    });
    let (group, index) = match after_previous {
        Some(found) => found,
        None => match snapshot.parent.as_deref().and_then(|id| locate(txn, id)) {
            Some((parent, _)) => {
                let group = child_block_group(txn, &parent).unwrap_or_else(|| {
                    parent.push_back(txn, XmlElementPrelim::empty("blockGroup"))
                });
                (group, 0)
            }
            None => (block_group(txn)?, 0),
        },
    };
    restore_subtree(txn, &group, index, &container);
    Ok(())
}

/// Appends a snapshot's container to the end of the body. See
/// [`super::append_snapshot`].
pub(super) fn append_block(txn: &mut TransactionMut, snapshot: &str) -> Result<(), CrdtError> {
    let snapshot: BlockSnapshot =
        serde_json::from_str(snapshot).map_err(|error| unreadable(error.to_string()))?;
    let mut container = subtree_of(&snapshot.container);
    if container.tag != "blockContainer" {
        return Err(unreadable("the snapshot holds no block".to_owned()));
    }
    let mut taken = HashSet::new();
    collect_container_ids(txn, &mut taken);
    container.mint_taken_container_ids(&taken);
    let group = block_group(txn)?;
    let at = group.len(txn);
    restore_subtree(txn, &group, at, &container);
    Ok(())
}

/// Every `blockContainer` id in the body.
fn collect_container_ids(txn: &TransactionMut, ids: &mut HashSet<String>) {
    fn walk(txn: &TransactionMut, element: &XmlElementRef, ids: &mut HashSet<String>) {
        if element.tag().as_ref() == "blockContainer"
            && let Some(id) = attribute(txn, element, "id")
        {
            ids.insert(id);
        }
        for child in element.children(txn) {
            if let XmlOut::Element(inner) = child {
                walk(txn, &inner, ids);
            }
        }
    }
    let Some(fragment) = txn.get_xml_fragment(BODY_FRAGMENT) else {
        return;
    };
    for child in fragment.children(txn) {
        if let XmlOut::Element(element) = child {
            walk(txn, &element, ids);
        }
    }
}
