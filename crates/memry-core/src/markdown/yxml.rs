//! The Yjs `XmlFragment` and the ProseMirror document it holds, in both
//! directions, with y-prosemirror 1.3.7 semantics (`sync-plugin.js`).
//!
//! **Reading** is `createNodeFromYElement`: every element is built through
//! `schema.node`, and an element the schema cannot build is *removed* (y-prosemirror
//! deletes it from the shared document) together with everything under it.
//! The parent is then built from what is left, so one unbuildable child can
//! take the whole branch with it, e.g. a `tableRow` that ends up childless.
//! This function reads and never deletes: [`ReadFragment::removed`] counts
//! what the TypeScript repair would have deleted, and the caller reads from a
//! detached copy of the document (`blocknote-converter.ts:365-380`).
//!
//! **Writing** is `prosemirrorToYXmlFragment` into an empty fragment: one
//! element per node with its attributes (an `Undefined` value is written, a
//! `Null` one is skipped), one `XmlText` per run of adjacent text nodes with
//! the marks as formatting attributes.
//!
//! Known divergences, none reachable from a document y-prosemirror wrote: a
//! text run that is not a string insert is dropped like a failed `XmlText`,
//! and two marks of one type on one run are ordered by their attributes
//! instead of their key order in the JavaScript object.

use yrs::types::text::YChange;
use yrs::types::xml::{XmlElementPrelim, XmlTextPrelim};
use yrs::{
    Any, Out, ReadTxn, Text as _, TransactionMut, Xml as _, XmlElementRef, XmlFragment,
    XmlFragmentRef, XmlOut, XmlTextRef,
};

use super::pm::{Fragment, Mark, Node, Schema};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum YxmlError {
    /// A text node directly under the fragment, or a nested fragment anywhere:
    /// y-prosemirror throws and the whole conversion fails.
    #[error("the fragment holds a node y-prosemirror cannot convert")]
    Unconvertible,
    #[error("the target fragment is not empty")]
    NotEmpty,
    #[error("mark type {0} does not exclude itself; its name needs a content hash")]
    OverlappingMark(String),
}

pub struct ReadFragment {
    /// The document node (`schema.topNodeType.create(null, children)`, which
    /// does not check the content).
    pub doc: Node,
    /// Elements that were in the fragment and are not in `doc`.
    pub removed: usize,
}

/// `yXmlFragmentToProseMirrorRootNode`.
pub fn read_fragment<T: ReadTxn>(
    schema: &Schema,
    txn: &T,
    fragment: &XmlFragmentRef,
) -> Result<ReadFragment, YxmlError> {
    if crate::markdown::limits::fragment_too_deep(txn, fragment) {
        return Err(YxmlError::Unconvertible);
    }
    let mut children = Vec::new();
    let mut total = 0;
    for child in fragment.children(txn) {
        match child {
            XmlOut::Element(element) => {
                total += count_elements(&element, txn);
                if let Some(node) = build_element(schema, txn, &element)? {
                    children.push(node);
                }
            }
            XmlOut::Text(_) | XmlOut::Fragment(_) => return Err(YxmlError::Unconvertible),
        }
    }
    let kept: usize = children.iter().map(count_nodes).sum();
    let doc = schema
        .create(
            schema.top_node_type(),
            &[],
            Fragment::from_array(children),
            Vec::new(),
        )
        .map_err(|_| YxmlError::Unconvertible)?;
    Ok(ReadFragment {
        doc,
        removed: total - kept,
    })
}

fn count_elements<T: ReadTxn>(element: &XmlElementRef, txn: &T) -> usize {
    1 + element
        .children(txn)
        .map(|child| match child {
            XmlOut::Element(inner) => count_elements(&inner, txn),
            _ => 0,
        })
        .sum::<usize>()
}

fn count_nodes(node: &Node) -> usize {
    if node.is_text() {
        return 0;
    }
    1 + node.children().iter().map(count_nodes).sum::<usize>()
}

/// `createNodeFromYElement`: `None` is the element y-prosemirror deletes.
fn build_element<T: ReadTxn>(
    schema: &Schema,
    txn: &T,
    element: &XmlElementRef,
) -> Result<Option<Node>, YxmlError> {
    let mut children = Vec::new();
    for child in element.children(txn) {
        match child {
            XmlOut::Element(inner) => children.extend(build_element(schema, txn, &inner)?),
            XmlOut::Text(text) => {
                children.extend(text_nodes(schema, txn, &text).into_iter().flatten())
            }
            XmlOut::Fragment(_) => return Err(YxmlError::Unconvertible),
        }
    }
    let attrs: Vec<(String, Any)> = element
        .attributes(txn)
        .map(|(name, value)| (name.to_owned(), out_to_any(value, txn)))
        .collect();
    Ok(schema.node(element.tag(), &attrs, children).ok())
}

/// `createTextNodesFromYText`: `None` when a mark is unknown (the text is
/// deleted), otherwise one text node per formatting run.
fn text_nodes<T: ReadTxn>(schema: &Schema, txn: &T, text: &XmlTextRef) -> Option<Vec<Node>> {
    let mut nodes = Vec::new();
    for chunk in text.diff(txn, YChange::identity) {
        let Out::Any(Any::String(value)) = &chunk.insert else {
            return None;
        };
        let mut marks = Vec::new();
        if let Some(attributes) = chunk.attributes.as_deref() {
            let mut entries: Vec<(&str, &Any)> =
                attributes.iter().map(|(k, v)| (k.as_ref(), v)).collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            for (name, value) in entries {
                let ty = schema.mark_type(mark_name(name))?;
                marks.push(schema.create_mark(ty, value).ok()?);
            }
        }
        marks.sort_by_key(|m: &Mark| (schema.mark_ty(m.ty).rank, format!("{:?}", m.attrs)));
        nodes.push(schema.text(value, marks).ok()?);
    }
    Some(nodes)
}

/// `yattr2markname`: `name--<8 chars of [a-zA-Z0-9+/=]>` is a hashed key.
fn mark_name(attribute: &str) -> &str {
    let Some(split) = attribute.len().checked_sub(10) else {
        return attribute;
    };
    let (name, suffix) = attribute.split_at_checked(split).unwrap_or((attribute, ""));
    let hashed = suffix.len() == 10
        && suffix.starts_with("--")
        && suffix[2..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
    if hashed { name } else { attribute }
}

fn out_to_any<T: ReadTxn>(value: Out, txn: &T) -> Any {
    match value {
        Out::Any(any) => any,
        other => Any::String(other.to_string(txn).into()),
    }
}

/// `prosemirrorToYXmlFragment(doc, fragment)` for an empty `fragment`: the
/// children of `doc` become the fragment's children.
pub fn write_fragment(
    schema: &Schema,
    txn: &mut TransactionMut,
    fragment: &XmlFragmentRef,
    doc: &Node,
) -> Result<(), YxmlError> {
    if fragment.len(txn) != 0 {
        return Err(YxmlError::NotEmpty);
    }
    write_children(schema, txn, fragment, doc)
}

fn write_children<F: XmlFragment>(
    schema: &Schema,
    txn: &mut TransactionMut,
    parent: &F,
    node: &Node,
) -> Result<(), YxmlError> {
    let children = node.children();
    let mut index = 0;
    while index < children.len() {
        let child = &children[index];
        if child.is_text() {
            let run_end = children[index..]
                .iter()
                .position(|n| !n.is_text())
                .map_or(children.len(), |offset| index + offset);
            write_text_run(schema, txn, parent, &children[index..run_end])?;
            index = run_end;
        } else {
            let name = schema.node_ty(child.ty).name;
            let element = parent.push_back(txn, XmlElementPrelim::empty(name));
            for (key, value) in &child.attrs {
                if !matches!(value, Any::Null) {
                    element.insert_attribute(txn, key.as_str(), value.clone());
                }
            }
            write_children(schema, txn, &element, child)?;
            index += 1;
        }
    }
    Ok(())
}

fn write_text_run<F: XmlFragment>(
    schema: &Schema,
    txn: &mut TransactionMut,
    parent: &F,
    run: &[Node],
) -> Result<(), YxmlError> {
    let text = parent.push_back(txn, XmlTextPrelim::new(""));
    for node in run {
        let attributes = mark_attributes(schema, &node.marks)?;
        let at = text.len(txn);
        text.insert_with_attributes(txn, at, node.text.as_deref().unwrap_or(""), attributes);
    }
    Ok(())
}

/// `marksToAttributes` for marks that exclude themselves, which is every mark
/// of the memry schema. A mark that does not would be keyed
/// `name--<hash of its JSON>`; no such mark exists, so it is an error rather
/// than a guessed key.
fn mark_attributes(schema: &Schema, marks: &[Mark]) -> Result<yrs::types::Attrs, YxmlError> {
    let mut out = yrs::types::Attrs::new();
    for mark in marks {
        let mark_ty = schema.mark_ty(mark.ty);
        if !schema.mark_excludes(mark.ty, mark.ty) {
            return Err(YxmlError::OverlappingMark(mark_ty.name.to_owned()));
        }
        let values: std::collections::HashMap<String, Any> = mark.attrs.iter().cloned().collect();
        out.insert(mark_ty.name.into(), Any::from(values));
    }
    Ok(out)
}
