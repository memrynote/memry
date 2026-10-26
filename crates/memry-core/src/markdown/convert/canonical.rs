//! `serializeCanonical`, `yFragmentToBlocks` and `findUnrepresentableNodes`
//! (`blocknote-converter.ts`): the document re-derived into house-style
//! markdown, nothing of the source kept.

use serde_json::Value as Json;
use yrs::updates::decoder::Decode as _;
use yrs::{Doc, ReadTxn, StateVector, Transact as _, Update, XmlFragment, XmlFragmentRef, XmlOut};

use super::preserve::blocks_to_markdown_preserving;
use super::roots::read_link_references;
use super::seed::{SeedEnv, prepare_fragment_seed};
use super::serialize::BlockNoteSerializer;
use super::{Env, apply};
use crate::markdown::bn::dom_parser::ParseError;
use crate::markdown::bn::node_to_block::node_to_block;
use crate::markdown::pm::{Node, Schema};
use crate::markdown::shared::link_references::restore_link_references;
use crate::markdown::yxml::read_fragment;

/// The `prosemirror` fragment every note body lives in.
pub const BODY_FRAGMENT: &str = "prosemirror";

/// `new Y.Doc()` plus `Y.applyUpdate(snapshot, Y.encodeStateAsUpdate(doc))`: a
/// detached copy a serialization may read and mutate without touching the live
/// document.
pub fn detach<T: ReadTxn>(txn: &T) -> Option<Doc> {
    let snapshot = Doc::new();
    let update = Update::decode_v1(&txn.encode_state_as_update_v1(&StateVector::default())).ok()?;
    snapshot.transact_mut().apply_update(update).ok()?;
    Some(snapshot)
}

/// `docToBlocks`: the children of the document's first child, each a bnBlock.
pub fn doc_to_blocks(schema: &Schema, root: &Node) -> Result<Vec<Json>, ParseError> {
    match root.children().first() {
        Some(first) => first
            .children()
            .iter()
            .map(|child| node_to_block(schema, child))
            .collect(),
        None => Ok(Vec::new()),
    }
}

/// `yXmlFragmentToBlocks`: `None` where the TypeScript throws.
pub fn y_fragment_to_blocks<T: ReadTxn>(txn: &T, fragment: &XmlFragmentRef) -> Option<Vec<Json>> {
    let schema = Schema::memry();
    let read = read_fragment(schema, txn, fragment).ok()?;
    doc_to_blocks(schema, &read.doc).ok()
}

/// True when the fragment holds at least one block, at any depth. Reads only.
fn holds_block_container<F: XmlFragment, T: ReadTxn>(node: &F, txn: &T) -> bool {
    node.children(txn).any(|child| match child {
        XmlOut::Element(element) => {
            element.tag().as_ref() == "blockContainer" || holds_block_container(&element, txn)
        }
        _ => false,
    })
}

/// `serializeCanonical`. `prepare` runs on the detached copy before it is
/// read (the writing tools insert their sentinels there).
pub fn serialize_canonical<T: ReadTxn>(
    txn: &T,
    fragment: &str,
    prepare: Option<&mut dyn FnMut(&Doc)>,
) -> Option<String> {
    // y-prosemirror deletes any element it cannot build. This port never does,
    // but the read still happens on a copy so the writing tools can edit it.
    let snapshot = detach(txn)?;
    if let Some(prepare) = prepare {
        prepare(&snapshot);
    }
    let blocks = {
        let frag = snapshot.get_or_insert_xml_fragment(fragment);
        let snap_txn = snapshot.transact();
        y_fragment_to_blocks(&snap_txn, &frag)?
    };
    if blocks.is_empty() {
        // `''` is a real body, but only when the fragment is empty too: a
        // fragment that holds a block and converts to none was emptied by the
        // repair on the way out, and writing it would empty the user's file.
        let held = txn
            .get_xml_fragment(fragment)
            .is_some_and(|original| holds_block_container(&original, txn));
        return if held { None } else { Some(String::new()) };
    }
    let body = blocks_to_markdown_preserving(&blocks).ok()?;
    let (definitions, usages) = read_link_references(txn);
    Some(restore_link_references(&body, &definitions, &usages))
}

/// `canonicalMarkdown`: what a body canonicalizes to, i.e. what a document
/// seeded from it would serialize to with no source record. The proof oracle of
/// the source merge.
pub fn canonical_markdown(
    env: &Env,
    markdown: &str,
    note_path: Option<&str>,
    html_comments: bool,
) -> Option<String> {
    let scratch = Doc::new();
    let fragment = scratch.get_or_insert_xml_fragment(BODY_FRAGMENT);
    let seed_env = SeedEnv {
        callout_types: env.callout_types,
        embeds: env.embeds,
        serializer: &BlockNoteSerializer,
        html_comments,
    };
    let prepared = prepare_fragment_seed(&seed_env, markdown, note_path, None).ok()?;
    {
        let mut txn = scratch.transact_mut();
        if !apply::apply_fragment_seed(env, &prepared, &mut txn, &fragment) {
            return None;
        }
    }
    let txn = scratch.transact();
    serialize_canonical(&txn, BODY_FRAGMENT, None)
}

/// `findUnrepresentableNodes`: node names in the fragment the schema cannot
/// construct, in first-seen order.
pub fn find_unrepresentable_nodes<T: ReadTxn>(txn: &T, fragment: &str) -> Vec<String> {
    fn visit<F: XmlFragment, T: ReadTxn>(node: &F, txn: &T, unknown: &mut Vec<String>) {
        let schema = Schema::memry();
        for child in node.children(txn) {
            if let XmlOut::Element(element) = child {
                let name = element.tag().to_string();
                if schema.node_type(&name).is_none() && !unknown.contains(&name) {
                    unknown.push(name);
                }
                visit(&element, txn, unknown);
            }
        }
    }
    let mut unknown = Vec::new();
    if let Some(root) = txn.get_xml_fragment(fragment) {
        visit(&root, txn, &mut unknown);
    }
    unknown
}
