//! `MergeBlocks`, Backspace at a block's start (iOS): the block's inline
//! content joins the end of the one above with its marks and nodes, and the
//! block goes.

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::extract_blocks;
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use yrs::{
    Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim,
};

fn opened(blocks: &[(&str, &str, &str)]) -> Arc<Document> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    for (index, (id, kind, text)) in blocks.iter().enumerate() {
        let container = group.insert(
            &mut txn,
            index as u32,
            XmlElementPrelim::empty("blockContainer"),
        );
        container.insert_attribute(&mut txn, "id", *id);
        let block = container.insert(&mut txn, 0, XmlElementPrelim::empty(*kind));
        if !text.is_empty() {
            block.insert(&mut txn, 0, XmlTextPrelim::new(*text));
        }
    }
    let update = txn.encode_state_as_update_v1(&yrs::StateVector::default());
    drop(txn);
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-body-merge", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(&update).expect("apply");
    document
}

fn edit(document: &Document, edit: BlockEdit) {
    apply(document, &edit).unwrap_or_else(|error| panic!("{edit:?}: {error:?}"));
}

fn merge(block_id: &str, into: &str) -> BlockEdit {
    BlockEdit::MergeBlocks {
        block_id: block_id.to_owned(),
        into_block_id: into.to_owned(),
    }
}

/// Each block as `id kind "text"`.
fn shown(document: &Document) -> Vec<String> {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .map(|block| {
            let text: String = block.inline.iter().map(|run| run.text.as_str()).collect();
            format!("{} {} {text:?}", block.id.unwrap_or_default(), block.kind)
        })
        .collect()
}

#[test]
fn the_text_joins_the_block_above_and_the_block_goes() {
    let document = opened(&[
        ("a", "heading", "ab"),
        ("b", "paragraph", "cd"),
        ("c", "paragraph", "ef"),
    ]);
    edit(&document, merge("b", "a"));
    assert_eq!(
        shown(&document),
        ["a heading \"abcd\"", "c paragraph \"ef\""]
    );
    let canonical = canonical_fragment(&document).expect("canonical");
    assert!(
        canonical.contains("text \"abcd\""),
        "the join is not one run:\n{canonical}"
    );
}

#[test]
fn an_empty_block_merges_into_an_empty_block_and_into_a_full_one() {
    let document = opened(&[
        ("a", "paragraph", "a"),
        ("b", "paragraph", ""),
        ("c", "paragraph", ""),
    ]);
    edit(&document, merge("c", "b"));
    edit(&document, merge("b", "a"));
    assert_eq!(shown(&document), ["a paragraph \"a\""]);
}

#[test]
fn text_merged_into_an_empty_block_lands_in_it() {
    let document = opened(&[("a", "paragraph", ""), ("b", "paragraph", "cd")]);
    edit(&document, merge("b", "a"));
    assert_eq!(shown(&document), ["a paragraph \"cd\""]);
}

#[test]
fn marks_and_inline_nodes_on_both_sides_survive_and_stay_their_own() {
    let document = opened(&[("a", "paragraph", "ab"), ("b", "paragraph", "cd ef")]);
    edit(
        &document,
        BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 2,
            mark: "bold".to_owned(),
            value: None,
        },
    );
    edit(
        &document,
        BlockEdit::SetMark {
            block_id: "b".to_owned(),
            start: 3,
            end: 5,
            mark: "italic".to_owned(),
            value: None,
        },
    );
    edit(
        &document,
        BlockEdit::InsertInline {
            block_id: "b".to_owned(),
            start: 3,
            end: 3,
            kind: "hashTag".to_owned(),
            text: "#work".to_owned(),
            attrs: HashMap::from([("tag".to_owned(), "work".to_owned())]),
        },
    );
    edit(&document, merge("b", "a"));

    let blocks = extract_blocks(&document).expect("blocks");
    assert_eq!(blocks.len(), 1);
    let runs: Vec<(String, Vec<String>)> = blocks[0]
        .inline
        .iter()
        .map(|run| (run.text.clone(), run.marks.clone()))
        .collect();
    let canonical = canonical_fragment(&document).expect("canonical");
    let has = |text: &str, mark: &str| {
        runs.iter()
            .any(|(run, marks)| run == text && marks.iter().any(|m| m == mark))
    };
    assert!(has("ab", "bold"), "{runs:?}\n{canonical}");
    assert!(has("ef", "italic"), "{runs:?}\n{canonical}");
    assert!(
        runs.iter()
            .any(|(run, marks)| run == "cd " && marks.is_empty()),
        "merged text took the mark before it: {runs:?}\n{canonical}"
    );
    assert!(
        canonical.contains("hashTag"),
        "the tag was lost:\n{canonical}"
    );
}

#[test]
fn a_block_with_nested_blocks_is_refused_and_left_as_it_was() {
    let document = opened(&[
        ("a", "paragraph", "ab"),
        ("b", "paragraph", "cd"),
        ("c", "paragraph", "ef"),
    ]);
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "c".to_owned(),
        },
    );
    let before = canonical_fragment(&document).expect("canonical");
    assert!(apply(&document, &merge("b", "a")).is_err());
    assert!(apply(&document, &merge("b", "c")).is_err());
    assert_eq!(canonical_fragment(&document).expect("canonical"), before);
}
