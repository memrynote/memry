//! The seed promotes every `((mention:…))` token `parseLinkMentionToken`
//! accepts to a `linkMention` node, legacy ones with `_ * ! ~ '` raw included,
//! as Electron's `prepareFragmentSeed` does since #3871 and #4478. The source
//! record keeps a legacy token's bytes until its own paragraph is edited.

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
    XmlFragment as _, XmlOut, XmlTextPrelim, XmlTextRef,
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
fn a_legacy_token_with_a_raw_underscore_becomes_a_link_mention() {
    let blocks = seed_blocks("See ((mention:https%3A%2F%2Fexample.com%2Fa_b)) here.");
    assert_eq!(
        content(&blocks[0]),
        &json!([
            {"type": "text", "text": "See ", "styles": {}},
            {"type": "linkMention", "props": {
                "url": "https://example.com/a_b", "domain": "example.com",
                "title": "", "favicon": "", "siteName": ""
            }},
            {"type": "text", "text": " here.", "styles": {}},
        ])
    );
}

#[test]
fn a_stray_space_or_backslash_is_repaired_and_a_non_url_stays_text() {
    let blocks = seed_blocks(
        "A ((mention:https%3A%2F%2Fx.test%2Fpage )) B ((mention:https%3A%2F%2Fx.test%2Fa\\_b)) C ((mention: see below)).",
    );
    let urls: Vec<&str> = content(&blocks[0])
        .as_array()
        .expect("inline")
        .iter()
        .filter(|item| item["type"] == "linkMention")
        .map(|item| item["props"]["url"].as_str().expect("url"))
        .collect();
    assert_eq!(urls, ["https://x.test/page", "https://x.test/a_b"]);
    assert!(
        content(&blocks[0])
            .to_string()
            .contains("((mention: see below))"),
        "{}",
        blocks[0]
    );
}

/// Node's `new URL` fails an authority with credentials and no host; the
/// `url` crate parses it with an empty host.
#[test]
fn credentials_without_a_host_fail_the_url_check_as_in_node() {
    let blocks = seed_blocks("A ((mention:a%3A%2F%2F%40 )) B ((mention:a%3A%2F%2F%3A%40%2Fx)).");
    assert_eq!(
        content(&blocks[0]),
        &json!([
            {"type": "text", "text": "A ((mention:a%3A%2F%2F%40 )) B ", "styles": {}},
            {"type": "linkMention", "props": {
                "url": "a://:@/x", "domain": "a://:@/x",
                "title": "", "favicon": "", "siteName": ""
            }},
            {"type": "text", "text": ".", "styles": {}},
        ])
    );
}

#[test]
fn a_legacy_token_in_a_fenced_code_block_or_a_link_label_stays_text() {
    let token = "((mention:https%3A%2F%2Fexample.com%2Fa_b))";
    let code = seed_blocks(&format!("```\n{token}\n```"));
    assert!(!code[0].to_string().contains("linkMention"), "{}", code[0]);
    assert!(code[0].to_string().contains(token), "{}", code[0]);

    let label = seed_blocks(&format!("See [{token}](https://x.test) here."));
    assert!(
        !label[0].to_string().contains("linkMention"),
        "{}",
        label[0]
    );
    assert!(label[0].to_string().contains(token), "{}", label[0]);
}

/// The `legacy link mention token` rows of the `markdown-roundtrip` vectors
/// (#4478): the source record keeps a legacy token's bytes, and house style
/// writes it in the closed alphabet.
const LEGACY_ROWS: [(&str, &str); 3] = [
    (
        "Intro ((mention:https%3A%2F%2Fexample.com%2Fa_b)) outro.",
        "Intro ((mention:https%3A%2F%2Fexample.com%2Fa%5Fb)) outro.",
    ),
    (
        "See ((mention:https%3A%2F%2Fx.test%2Fa*b_c'd)) and ((mention:https%3A%2F%2Fx.test%2Fe*f~g!)) here.",
        "See ((mention:https%3A%2F%2Fx.test%2Fa%2Ab%5Fc%27d)) and ((mention:https%3A%2F%2Fx.test%2Fe%2Af%7Eg%21)) here.",
    ),
    (
        "Intro ((mention:https%3A%2F%2Fx.test%2Fpage )) outro.",
        "Intro ((mention:https%3A%2F%2Fx.test%2Fpage)) outro.",
    ),
];

#[test]
fn legacy_rows_keep_their_bytes_with_the_source_record_and_re_encode_without() {
    let converter = Converter::new(Default::default());
    for (markdown, canonical) in LEGACY_ROWS {
        let doc = replica("device-a");
        assert!(converter.seed_body(&doc, markdown, None, None, &NoEmbeds));
        let tokens = markdown.matches("((mention:").count();
        assert_eq!(link_mentions(&doc), tokens, "{markdown}");
        assert_eq!(body(&converter, &doc), markdown);
        assert_eq!(
            converter
                .doc_to_canonical_markdown(&doc, BODY_FRAGMENT)
                .expect("serializes"),
            canonical
        );
    }
}

const LEGACY: &str = "((mention:https%3A%2F%2Fexample.com%2Fa_b))";

#[test]
fn a_legacy_token_keeps_its_bytes_when_another_block_is_edited() {
    let converter = Converter::new(Default::default());
    let doc = replica("device-a");
    let file = format!("See {LEGACY} here.\n\nOther paragraph.");
    assert!(converter.seed_body(&doc, &file, None, None, &NoEmbeds));

    append_to_run(&doc, "Other paragraph.", " Edited.");

    assert_eq!(
        body(&converter, &doc),
        format!("See {LEGACY} here.\n\nOther paragraph. Edited.")
    );
}

#[test]
fn a_legacy_token_is_re_encoded_when_its_own_paragraph_is_edited() {
    let converter = Converter::new(Default::default());
    let doc = replica("device-a");
    let file = format!("See {LEGACY} here.\n\nOther paragraph.");
    assert!(converter.seed_body(&doc, &file, None, None, &NoEmbeds));

    append_to_run(&doc, " here.", " Edited.");

    assert_eq!(
        body(&converter, &doc),
        "See ((mention:https%3A%2F%2Fexample.com%2Fa%5Fb)) here. Edited.\n\nOther paragraph."
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
    two_replicas_merge_one_chip_per_mention(
        "See ((mention:https%3A%2F%2Fexample.com%2Fa)) and ((mention:https%3A%2F%2Fexample.org)).\n",
    );
}

/// The same race for tokens an older build wrote with `_ * ! ~ '` raw (#4478).
#[test]
fn two_replicas_merge_one_chip_per_legacy_mention_and_keep_the_file_bytes() {
    two_replicas_merge_one_chip_per_mention(&format!(
        "See {LEGACY} and ((mention:https%3A%2F%2Fx.test%2Fe*f~g!)).\n\nOther paragraph.\n"
    ));
}

fn two_replicas_merge_one_chip_per_mention(file: &str) {
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
        assert_eq!(body(&converter, doc), file);
    }
}

fn body(converter: &Converter, doc: &Document) -> String {
    converter
        .doc_to_markdown(doc, BODY_FRAGMENT, &SerializeOptions::default())
        .expect("serializes")
        .markdown
}

/// Append `suffix` to the first text run that reads exactly `run`.
fn append_to_run(doc: &Document, run: &str, suffix: &str) {
    fn find<T: ReadTxn>(txn: &T, node: &XmlElementRef, run: &str) -> Option<XmlTextRef> {
        (0..node.len(txn)).find_map(|i| match node.get(txn, i) {
            Some(XmlOut::Text(text)) if text.get_string(txn) == run => Some(text),
            Some(XmlOut::Element(child)) => find(txn, &child, run),
            _ => None,
        })
    }
    doc.write(|txn| {
        let fragment = txn.get_or_insert_xml_fragment(BODY_FRAGMENT);
        let text = (0..fragment.len(txn))
            .find_map(|i| match fragment.get(txn, i) {
                Some(XmlOut::Element(child)) => find(txn, &child, run),
                _ => None,
            })
            .unwrap_or_else(|| panic!("a text run reading {run:?}"));
        let end = text.len(txn);
        text.insert(txn, end, suffix);
    })
    .expect("write");
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
