//! Finding a block by its `blockContainer` id. Split from `mod.rs`.

#[allow(unused_imports)]
use super::*;

/// The `blockContainer` carrying `id`, and the block element inside it.
///
/// Returns both because an edit needs one or the other: a prop and text belong
/// to the block, a delete belongs to the container.
pub(super) fn locate(txn: &TransactionMut, id: &str) -> Option<(XmlElementRef, XmlElementRef)> {
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

pub(super) fn attribute(
    txn: &TransactionMut,
    element: &XmlElementRef,
    name: &str,
) -> Option<String> {
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
pub(super) fn missing(id: &str) -> CrdtError {
    CrdtError::Undecodable {
        doc_id: id.to_owned(),
        what: "this body holds no such block".to_owned(),
    }
}
