//! `SplitBlock`, Return inside a block's text (iOS, as desktop's
//! `splitBlockTr`): the content from the caret on moves, marks and inline
//! nodes kept, to a new block below; `MergeBlocks` puts it back.

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::extract_blocks;
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::Document;
use memry_core::crdt::registry::UpdateSink;
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
    let registry = DocumentRegistry::new("device-body-split", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(&update).expect("apply");
    document
}

fn edit(document: &Document, edit: BlockEdit) {
    apply(document, &edit).unwrap_or_else(|error| panic!("{edit:?}: {error:?}"));
}

fn split(block_id: &str, at: u32, kind: Option<&str>) -> BlockEdit {
    BlockEdit::SplitBlock {
        block_id: block_id.to_owned(),
        at,
        kind: kind.map(str::to_owned),
        new_block_id: "n".to_owned(),
    }
}

/// Each block as `id kind "text"`, inline nodes as `[kind]`.
fn shown(document: &Document) -> Vec<String> {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .map(|block| {
            let text: String = block
                .inline
                .iter()
                .map(|run| {
                    let node = run.marks.iter().find(|mark| {
                        ["hashTag", "dateMention", "wikiLink"].contains(&mark.as_str())
                    });
                    match node {
                        Some(kind) => format!("[{kind}]"),
                        None => run.text.clone(),
                    }
                })
                .collect();
            format!("{} {} {text:?}", block.id.unwrap_or_default(), block.kind)
        })
        .collect()
}

fn tag(block_id: &str, at: u32) -> BlockEdit {
    BlockEdit::InsertInline {
        block_id: block_id.to_owned(),
        start: at,
        end: at,
        kind: "hashTag".to_owned(),
        text: "#work".to_owned(),
        attrs: HashMap::from([("tag".to_owned(), "work".to_owned())]),
    }
}

fn date(block_id: &str, at: u32) -> BlockEdit {
    BlockEdit::InsertInline {
        block_id: block_id.to_owned(),
        start: at,
        end: at,
        kind: "dateMention".to_owned(),
        text: String::new(),
        attrs: HashMap::from([("date".to_owned(), "2026-01-02".to_owned())]),
    }
}

#[test]
fn the_text_after_the_caret_moves_to_a_new_block_below() {
    let document = opened(&[("a", "heading", "helloworld"), ("b", "paragraph", "x")]);
    edit(&document, split("a", 5, Some("paragraph")));
    assert_eq!(
        shown(&document),
        [
            "a heading \"hello\"",
            "n paragraph \"world\"",
            "b paragraph \"x\""
        ]
    );
}

#[test]
fn a_merge_puts_the_split_back_exactly() {
    let document = opened(&[("a", "paragraph", "hello world")]);
    edit(
        &document,
        BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 3,
            end: 8,
            mark: "bold".to_owned(),
            value: None,
        },
    );
    edit(&document, tag("a", 9));
    let before = canonical_fragment(&document).expect("canonical");
    edit(&document, split("a", 5, Some("paragraph")));
    edit(
        &document,
        BlockEdit::MergeBlocks {
            block_id: "n".to_owned(),
            into_block_id: "a".to_owned(),
        },
    );
    assert_eq!(canonical_fragment(&document).expect("canonical"), before);
}

#[test]
fn marks_and_inline_nodes_go_with_their_side() {
    let document = opened(&[("a", "paragraph", "ab cd ef")]);
    edit(
        &document,
        BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 5,
            mark: "bold".to_owned(),
            value: None,
        },
    );
    edit(&document, tag("a", 6));
    // `ab cd ` [tag] `ef`: split inside the bold run, after `ab c`.
    edit(&document, split("a", 4, Some("paragraph")));
    assert_eq!(
        shown(&document),
        ["a paragraph \"ab c\"", "n paragraph \"d [hashTag]ef\""]
    );
    let blocks = extract_blocks(&document).expect("blocks");
    let marked = |index: usize, text: &str| {
        blocks[index]
            .inline
            .iter()
            .any(|run| run.text == text && run.marks.iter().any(|mark| mark == "bold"))
    };
    assert!(marked(0, "ab c"), "{:?}", blocks[0].inline);
    assert!(marked(1, "d"), "{:?}", blocks[1].inline);
}

#[test]
fn a_textless_node_goes_with_the_side_its_placeholder_is_on() {
    // `ab` [date] `cd`: the caret after the date keeps it above, before it
    // moves it below. A byte offset cannot tell the two apart.
    for (at, expected) in [
        (3, ["a paragraph \"ab[dateMention]\"", "n paragraph \"cd\""]),
        (2, ["a paragraph \"ab\"", "n paragraph \"[dateMention]cd\""]),
    ] {
        let document = opened(&[("a", "paragraph", "abcd")]);
        edit(&document, date("a", 2));
        edit(&document, split("a", at, Some("paragraph")));
        assert_eq!(shown(&document), expected, "at {at}");
    }
}

#[test]
fn at_the_start_the_new_block_takes_the_type_and_props() {
    let document = opened(&[("a", "checkListItem", "milk")]);
    edit(
        &document,
        BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "checked".to_owned(),
            value: "true".to_owned(),
        },
    );
    edit(&document, split("a", 0, None));
    let blocks = extract_blocks(&document).expect("blocks");
    assert_eq!(
        shown(&document),
        ["a checkListItem \"\"", "n checkListItem \"milk\""]
    );
    let checked = |index: usize| {
        blocks[index]
            .props
            .iter()
            .any(|prop| prop.name == "checked" && prop.value == "true")
    };
    assert!(checked(0) && checked(1), "{blocks:?}");
}

#[test]
fn a_named_kind_takes_its_defaults() {
    let document = opened(&[("a", "checkListItem", "milkeggs")]);
    edit(
        &document,
        BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "checked".to_owned(),
            value: "true".to_owned(),
        },
    );
    edit(&document, split("a", 4, Some("checkListItem")));
    let blocks = extract_blocks(&document).expect("blocks");
    assert!(
        !blocks[1]
            .props
            .iter()
            .any(|prop| prop.name == "checked" && prop.value == "true"),
        "{blocks:?}"
    );
}

#[test]
fn a_multibyte_character_before_the_caret_counts_once() {
    let document = opened(&[("a", "paragraph", "héllo😀wörld")]);
    edit(&document, split("a", 6, Some("paragraph")));
    assert_eq!(
        shown(&document),
        ["a paragraph \"héllo😀\"", "n paragraph \"wörld\""]
    );
}

#[test]
fn a_block_with_nested_blocks_or_an_offset_past_its_end_is_refused() {
    let document = opened(&[("a", "paragraph", "ab"), ("c", "paragraph", "cd")]);
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "c".to_owned(),
        },
    );
    let before = canonical_fragment(&document).expect("canonical");
    assert!(apply(&document, &split("a", 1, Some("paragraph"))).is_err());
    assert!(apply(&document, &split("c", 3, Some("paragraph"))).is_err());
    assert!(apply(&document, &split("c", 1, Some("divider"))).is_err());
    assert_eq!(canonical_fragment(&document).expect("canonical"), before);
}

#[test]
fn a_block_with_marks_or_inline_nodes_does_not_split_into_plain_text() {
    let document = opened(&[("a", "paragraph", "ab cd")]);
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
    edit(&document, tag("a", 3));
    let before = canonical_fragment(&document).expect("canonical");
    assert!(apply(&document, &split("a", 1, Some("codeBlock"))).is_err());
    assert!(apply(&document, &split("a", 4, Some("diagram"))).is_err());
    assert_eq!(canonical_fragment(&document).expect("canonical"), before);
}
