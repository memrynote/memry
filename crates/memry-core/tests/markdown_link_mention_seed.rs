//! The seed promotes a byte-neutral `((mention:…))` token to a `linkMention`
//! node, as Electron's `prepareFragmentSeed` does since #3871, and keeps every
//! other token as text.

#![cfg(feature = "markdown")]

use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::convert::canonical::BODY_FRAGMENT;
use memry_core::markdown::convert::restore::SerializeOptions;
use serde_json::{Value as Json, json};
use yrs::{
    GetString as _, ReadTxn, Text as _, WriteTxn as _, Xml as _, XmlElementPrelim, XmlElementRef,
    XmlFragment as _, XmlOut, XmlTextPrelim,
};

fn seed_blocks(markdown: &str) -> Vec<Json> {
    Converter::new(Default::default())
        .prepare_seed(markdown, None, None, &NoEmbeds)
        .expect("seeds")
        .blocks
}

fn content(block: &Json) -> &Json {
    &block["content"]
}

#[test]
fn a_byte_neutral_token_becomes_one_link_mention_with_url_and_domain() {
    let blocks = seed_blocks("See ((mention:https%3A%2F%2Fwww.example.com%2Fa%5Fb)) now");
    assert_eq!(
        content(&blocks[0]),
        &json!([
            {"type": "text", "text": "See ", "styles": {}},
            {"type": "linkMention", "props": {
                "url": "https://www.example.com/a_b", "domain": "example.com",
                "title": "", "favicon": "", "siteName": ""
            }},
            {"type": "text", "text": " now", "styles": {}},
        ])
    );
}

#[test]
fn a_token_with_a_raw_underscore_stays_text() {
    let markdown = "See ((mention:https%3A%2F%2Fexample.com%2Fa_b))";
    let blocks = seed_blocks(markdown);
    let text = serde_json::to_string(content(&blocks[0])).expect("json");
    assert!(!text.contains("linkMention"), "{text}");
    assert!(
        text.contains("((mention:https%3A%2F%2Fexample.com%2Fa_b))"),
        "{text}"
    );
}

#[test]
fn a_code_block_keeps_its_token_as_text_and_a_table_cell_promotes() {
    let token = "((mention:https%3A%2F%2Fexample.com))";
    let code = seed_blocks(&format!("```\n{token}\n```"));
    assert!(!code[0].to_string().contains("linkMention"), "{}", code[0]);

    let table = seed_blocks(&format!("| a |\n| - |\n| {token} |"));
    assert!(table[0].to_string().contains("linkMention"), "{}", table[0]);
}

/// One device seeds the note from its file and syncs the doc; then both devices
/// open it before they hear from each other. Opening promotes any
/// `((mention:…))` text left in the doc, as the renderer does
/// (`promoteLinkMentionsInSharedDoc`); here that is a y-prosemirror-shaped
/// split of the text run around a new `linkMention` element. When the seed
/// left the token as text, each device promoted it on its own replica and the
/// merge held two chips (#3871).
#[test]
fn two_replicas_that_open_the_seeded_note_before_syncing_merge_to_one_chip_per_mention() {
    let file = "See ((mention:https%3A%2F%2Fexample.com%2Fa)) and ((mention:https%3A%2F%2Fexample.org)).\n";
    let converter = Converter::new(Default::default());
    let a = replica("device-a");
    assert!(converter.seed_body(&a, file, None, None, &NoEmbeds));
    let b = replica("device-b");
    b.apply_durable_update(&a.encode_state().expect("state"))
        .expect("apply");

    open(&a);
    open(&b);
    let from_a = a.encode_state().expect("state");
    let from_b = b.encode_state().expect("state");
    a.apply_durable_update(&from_b).expect("apply");
    b.apply_durable_update(&from_a).expect("apply");

    for doc in [&a, &b] {
        assert_eq!(link_mentions(doc), 2);
        let body = converter
            .doc_to_markdown(doc, BODY_FRAGMENT, &SerializeOptions::default())
            .expect("serializes");
        assert_eq!(body.markdown, file);
    }
}

fn replica(device: &str) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    DocumentRegistry::new(device, sink)
        .get_or_open("note-3871")
        .expect("open")
}

fn link_mentions(doc: &Document) -> usize {
    fn count<T: ReadTxn>(txn: &T, node: &XmlElementRef) -> usize {
        let own = usize::from(&**node.tag() == "linkMention");
        own + (0..node.len(txn))
            .filter_map(|i| match node.get(txn, i) {
                Some(XmlOut::Element(child)) => Some(count(txn, &child)),
                _ => None,
            })
            .sum::<usize>()
    }
    doc.read(|txn| {
        let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("body");
        (0..fragment.len(txn))
            .filter_map(|i| match fragment.get(txn, i) {
                Some(XmlOut::Element(child)) => Some(count(txn, &child)),
                _ => None,
            })
            .sum()
    })
    .expect("read")
}

/// Promote the first `((mention:…))` text run found, until none is left.
fn open(doc: &Document) {
    fn find<T: ReadTxn>(txn: &T, node: &XmlElementRef) -> Option<(XmlElementRef, u32)> {
        for i in 0..node.len(txn) {
            match node.get(txn, i) {
                Some(XmlOut::Text(text)) if text.get_string(txn).contains("((mention:") => {
                    return Some((node.clone(), i));
                }
                Some(XmlOut::Element(child)) => {
                    if let Some(found) = find(txn, &child) {
                        return Some(found);
                    }
                }
                _ => {}
            }
        }
        None
    }
    doc.write(|txn| {
        let fragment = txn.get_or_insert_xml_fragment(BODY_FRAGMENT);
        loop {
            let found = (0..fragment.len(txn)).find_map(|i| match fragment.get(txn, i) {
                Some(XmlOut::Element(child)) => find(txn, &child),
                _ => None,
            });
            let Some((parent, index)) = found else { break };
            let Some(XmlOut::Text(text)) = parent.get(txn, index) else {
                unreachable!()
            };
            let string = text.get_string(txn);
            let start = string.find("((mention:").expect("token");
            let end = start + string[start..].find("))").expect("token end") + 2;
            let rest = string[end..].to_owned();
            let len = u32::try_from(string.len() - start).expect("len");
            let start = u32::try_from(start).expect("start");
            text.remove_range(txn, start, len);
            let chip = parent.insert(txn, index + 1, XmlElementPrelim::empty("linkMention"));
            chip.insert_attribute(txn, "url", "promoted-on-open");
            if !rest.is_empty() {
                parent.insert(txn, index + 2, XmlTextPrelim::new(rest));
            }
        }
    })
    .expect("write");
}
