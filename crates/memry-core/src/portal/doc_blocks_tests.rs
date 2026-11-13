use std::sync::Arc;

use yrs::XmlOut;
use yrs::types::text::YChange;

use super::*;
use crate::crdt::DocumentRegistry;
use crate::crdt::markdown_seed::append_markdown_in;
use crate::crdt::registry::UpdateSink;
use crate::portal::anchor::strip_anchor;

fn note(markdown: &str) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let document = DocumentRegistry::new("device-doc-blocks", sink)
        .get_or_open("abc123def456")
        .expect("open");
    document
        .write(|txn| append_markdown_in(txn, markdown).map(|_| ()))
        .expect("transact")
        .expect("seed");
    document
}

fn block<'a>(blocks: &'a [DocBlock], text: &str) -> &'a DocBlock {
    blocks
        .iter()
        .find(|block| strip_anchor(&block.text) == text)
        .unwrap_or_else(|| panic!("no block {text:?} in {blocks:?}"))
}

#[test]
fn lists_blocks_in_order_with_their_parent() {
    let document = note("Intro ^intro1\n\n- parent\n    - child\n\n```js\nlet a = 1\n```\n");
    let blocks = list_doc_blocks(&document).expect("list");
    let texts: Vec<&str> = blocks.iter().map(|block| block.text.as_str()).collect();
    assert_eq!(texts, ["Intro ^intro1", "parent", "child", ""]);
    let parent = block(&blocks, "parent");
    assert_eq!(block(&blocks, "child").parent_id.as_ref(), Some(&parent.id));
    assert_eq!(parent.parent_id, None);
    assert!(!blocks[3].stampable, "a code block cannot carry an anchor");
}

#[test]
fn stamps_a_fresh_anchor_without_the_tail_marks() {
    let document = note("Some **bold**\n\nOther ^taken1\n");
    let id = block(&list_doc_blocks(&document).expect("list"), "Some bold")
        .id
        .clone();

    let StampOutcome::Stamped(anchor) = stamp_anchor(&document, &id).expect("stamp") else {
        panic!("not stamped");
    };
    let blocks = list_doc_blocks(&document).expect("list");
    let stamped = block(&blocks, "Some bold");
    assert_eq!(stamped.text, format!("Some bold ^{anchor}"));
    assert_ne!(anchor, "taken1");

    let tail_marks = document
        .read(|txn| {
            let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("body");
            let mut marks = None;
            for node in fragment.successors(txn) {
                if let XmlOut::Text(run) = node {
                    for chunk in run.diff(txn, YChange::identity) {
                        if let Out::Any(Any::String(text)) = &chunk.insert
                            && text.contains('^')
                            && text.contains(anchor.as_str())
                        {
                            marks = Some(chunk.attributes.map(|attrs| attrs.len()).unwrap_or(0));
                        }
                    }
                }
            }
            marks
        })
        .expect("read");
    assert_eq!(tail_marks, Some(0), "the anchor takes no bold");

    assert_eq!(
        stamp_anchor(&document, &id).expect("again"),
        StampOutcome::Existing(anchor),
        "a second stamp reports the anchor and writes nothing"
    );
}

#[test]
fn refuses_a_block_without_inline_text_or_an_unknown_id() {
    let document = note("```js\nlet a = 1\n```\n");
    let code = list_doc_blocks(&document).expect("list")[0].id.clone();
    assert_eq!(
        stamp_anchor(&document, &code).expect("stamp"),
        StampOutcome::MissingBlock
    );
    assert_eq!(
        stamp_anchor(&document, "nope").expect("stamp"),
        StampOutcome::MissingBlock
    );
}

#[test]
fn an_empty_paragraph_takes_a_new_run() {
    let document = note("Text\n");
    let id = list_doc_blocks(&document).expect("list")[0].id.clone();
    document
        .write(|txn| {
            let fragment = txn.get_xml_fragment(BODY_FRAGMENT).expect("body");
            let run = fragment
                .successors(txn)
                .find_map(|node| match node {
                    XmlOut::Text(run) => Some(run),
                    _ => None,
                })
                .expect("run");
            let parent = run.parent().expect("parent");
            let XmlOut::Element(paragraph) = parent else {
                panic!("run outside a paragraph");
            };
            paragraph.remove_range(txn, 0, 1);
        })
        .expect("clear");
    let StampOutcome::Stamped(anchor) = stamp_anchor(&document, &id).expect("stamp") else {
        panic!("not stamped");
    };
    assert_eq!(
        list_doc_blocks(&document).expect("list")[0].text,
        format!(" ^{anchor}")
    );
}

#[test]
fn a_deep_body_is_walked_on_a_small_stack() {
    let mut markdown = String::new();
    for depth in 0..400 {
        markdown.push_str(&"    ".repeat(depth));
        markdown.push_str("- item\n");
    }
    let document = note(&markdown);
    let count = memry_test_kit::on_small_stack(move || list_doc_blocks(&document).map(|b| b.len()));
    assert!(count.expect("list") >= 1);
}
