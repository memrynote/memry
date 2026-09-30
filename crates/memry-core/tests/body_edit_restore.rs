//! Turn into, duplicate and the snapshot `RestoreBlock` puts back (iOS undo),
//! held to the document they leave: marks stay marks, inline nodes stay nodes,
//! nested blocks travel with their parent, and ids are kept or minted as each
//! operation requires.

use std::collections::HashMap;
use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::extract_blocks;
use memry_core::crdt::body_edit::{BlockEdit, apply, snapshot_block};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use yrs::{
    Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _, XmlTextPrelim,
};

fn opened(update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-body-restore", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

fn body(blocks: &[(&str, &str, &str)]) -> Vec<u8> {
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
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

fn canonical(document: &Document) -> String {
    canonical_fragment(document).expect("canonical")
}

fn ids(document: &Document) -> Vec<String> {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .filter_map(|block| block.id)
        .collect()
}

fn edit(document: &Document, edit: BlockEdit) {
    apply(document, &edit).unwrap_or_else(|error| panic!("{edit:?}: {error:?}"));
}

/// "hello and end" becomes "hello" (bold), " ", a date mention, "and ", a tag,
/// "end". The tag goes in first: an offset addresses one run.
fn formatted(document: &Document, block_id: &str) {
    edit(
        document,
        BlockEdit::SetMark {
            block_id: block_id.to_owned(),
            start: 0,
            end: 5,
            mark: "bold".to_owned(),
            value: None,
        },
    );
    edit(
        document,
        BlockEdit::InsertInline {
            block_id: block_id.to_owned(),
            start: 10,
            end: 10,
            kind: "hashTag".to_owned(),
            text: "#work".to_owned(),
            attrs: HashMap::from([("tag".to_owned(), "work".to_owned())]),
        },
    );
    edit(
        document,
        BlockEdit::InsertInline {
            block_id: block_id.to_owned(),
            start: 6,
            end: 6,
            kind: "dateMention".to_owned(),
            text: "tomorrow".to_owned(),
            attrs: HashMap::from([("date".to_owned(), "2026-09-23".to_owned())]),
        },
    );
}

/// The block's own content in the canonical form, from its container on.
fn block_of<'a>(canonical: &'a str, id: &str) -> &'a str {
    canonical
        .split(&format!("blockContainer id=\"{id}\""))
        .nth(1)
        .unwrap_or_else(|| panic!("no block {id} in:\n{canonical}"))
}

#[test]
fn turning_a_formatted_block_into_another_keeps_its_marks_and_inline_nodes() {
    let document = opened(&body(&[("a", "paragraph", "hello and end")]));
    formatted(&document, "a");
    edit(
        &document,
        BlockEdit::TurnInto {
            block_id: "a".to_owned(),
            kind: "heading".to_owned(),
        },
    );

    let after = canonical(&document);
    let block = block_of(&after, "a");
    assert!(block.contains("heading"), "{after}");
    assert!(
        block.contains("text \"hello\" bold={}"),
        "the mark was lost:\n{after}"
    );
    assert!(block.contains("dateMention"), "the date was lost:\n{after}");
    assert!(block.contains("hashTag"), "the tag was lost:\n{after}");
    assert!(
        !after.contains("<bold>"),
        "a mark was written as text:\n{after}"
    );
    // In order: the date sits between "hello " and " and ", not at the end.
    let date = block.find("dateMention").expect("date");
    let tag = block.find("hashTag").expect("tag");
    let and = block.find("\"and \"").expect("and");
    assert!(date < and && and < tag, "the nodes moved:\n{after}");
}

#[test]
fn a_code_block_takes_plain_text_because_its_schema_holds_no_marks_or_nodes() {
    let document = opened(&body(&[("a", "paragraph", "hello and end")]));
    formatted(&document, "a");
    edit(
        &document,
        BlockEdit::TurnInto {
            block_id: "a".to_owned(),
            kind: "codeBlock".to_owned(),
        },
    );
    let blocks = extract_blocks(&document).expect("blocks");
    let code = &blocks[0];
    assert_eq!(code.kind, "codeBlock");
    let text: String = code.inline.iter().map(|run| run.text.as_str()).collect();
    assert_eq!(text, "hello tomorrowand #workend");
    assert!(
        code.inline.iter().all(|run| run.marks.is_empty()),
        "{:?}",
        code.inline
    );
}

#[test]
fn a_duplicate_copies_nested_children_under_fresh_ids() {
    let document = opened(&body(&[
        ("a", "bulletListItem", "parent"),
        ("a1", "bulletListItem", "child"),
        ("b", "paragraph", "after"),
    ]));
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "a1".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::Duplicate {
            block_id: "a".to_owned(),
            new_block_id: "a-copy".to_owned(),
        },
    );

    let blocks = extract_blocks(&document).expect("blocks");
    let summary: Vec<(u32, String)> = blocks
        .iter()
        .map(|block| {
            let text: String = block.inline.iter().map(|run| run.text.as_str()).collect();
            (block.depth, text)
        })
        .collect();
    assert_eq!(
        summary,
        [
            (0, "parent".to_owned()),
            (1, "child".to_owned()),
            (0, "parent".to_owned()),
            (1, "child".to_owned()),
            (0, "after".to_owned()),
        ]
    );
    let all = ids(&document);
    assert_eq!(all[..3], ["a", "a1", "a-copy"]);
    assert_eq!(all[4], "b");
    let minted = &all[3];
    assert_ne!(minted, "a1", "the copied child kept its original's id");
    // BlockNote's format: a lowercase UUID v4.
    let parts: Vec<&str> = minted.split('-').collect();
    assert_eq!(
        parts.iter().map(|part| part.len()).collect::<Vec<_>>(),
        [8, 4, 4, 4, 12],
        "{minted}"
    );
    assert!(parts[2].starts_with('4'), "{minted}");
    assert!(
        minted
            .chars()
            .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c))
    );
}

#[test]
fn a_deleted_block_comes_back_whole_from_its_snapshot() {
    let document = opened(&body(&[
        ("z", "paragraph", "first"),
        ("a", "paragraph", "hello and end"),
        ("a1", "paragraph", "nested"),
        ("b", "paragraph", "after"),
    ]));
    formatted(&document, "a");
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "a1".to_owned(),
        },
    );
    let original = canonical(&document);

    let snapshot = snapshot_block(&document, "a").expect("snapshot");
    assert_eq!(
        canonical(&document),
        original,
        "reading a snapshot changed the body"
    );
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "a".to_owned(),
        },
    );
    assert_eq!(ids(&document), ["z", "b"]);

    edit(
        &document,
        BlockEdit::RestoreBlock {
            snapshot: snapshot.clone(),
        },
    );
    assert_eq!(
        canonical(&document),
        original,
        "the restore did not round trip"
    );
    assert_eq!(ids(&document), ["z", "a", "a1", "b"]);

    // Redo is the delete again, by the same id.
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "a".to_owned(),
        },
    );
    assert_eq!(ids(&document), ["z", "b"]);
}

#[test]
fn undoing_a_type_change_brings_back_the_heading_level_and_marks() {
    let document = opened(&body(&[
        ("a", "heading", "hello and end"),
        ("a1", "paragraph", "nested"),
    ]));
    edit(
        &document,
        BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "level".to_owned(),
            value: "2".to_owned(),
        },
    );
    formatted(&document, "a");
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "a1".to_owned(),
        },
    );
    let original = canonical(&document);

    let before = snapshot_block(&document, "a").expect("snapshot");
    edit(
        &document,
        BlockEdit::TurnInto {
            block_id: "a".to_owned(),
            kind: "paragraph".to_owned(),
        },
    );
    assert!(!canonical(&document).contains("level=2"));
    edit(
        &document,
        BlockEdit::SetText {
            block_id: "a1".to_owned(),
            text: "nested edited".to_owned(),
        },
    );

    edit(&document, BlockEdit::RestoreBlock { snapshot: before });
    let restored = canonical(&document);
    assert!(restored.contains("level=2"), "{restored}");
    // Only the block itself goes back: the child edited since keeps its edit.
    assert_eq!(
        restored,
        original.replace("\"nested\"", "\"nested edited\"")
    );
}

#[test]
fn a_restore_whose_sibling_is_gone_lands_first_in_its_parent() {
    let document = opened(&body(&[
        ("p", "bulletListItem", "parent"),
        ("x", "bulletListItem", "x"),
        ("y", "bulletListItem", "y"),
        ("z", "paragraph", "after"),
    ]));
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "x".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "y".to_owned(),
        },
    );
    let snapshot = snapshot_block(&document, "y").expect("snapshot");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "y".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "x".to_owned(),
        },
    );
    // The emptied group goes with its last child: BlockNote requires a group
    // to hold a block.
    assert_eq!(
        canonical(&document).matches("element blockGroup").count(),
        1,
        "an empty group was left:\n{}",
        canonical(&document)
    );

    edit(&document, BlockEdit::RestoreBlock { snapshot });
    let blocks = extract_blocks(&document).expect("blocks");
    let shape: Vec<(String, u32)> = blocks
        .iter()
        .map(|block| (block.id.clone().unwrap_or_default(), block.depth))
        .collect();
    assert_eq!(
        shape,
        [
            ("p".to_owned(), 0),
            ("y".to_owned(), 1),
            ("z".to_owned(), 0)
        ]
    );
}

#[test]
fn a_restore_with_no_anchor_left_lands_first_in_the_body() {
    let document = opened(&body(&[
        ("p", "bulletListItem", "parent"),
        ("x", "bulletListItem", "x"),
        ("y", "bulletListItem", "y"),
        ("z", "paragraph", "after"),
    ]));
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "x".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "y".to_owned(),
        },
    );
    let nested = snapshot_block(&document, "y").expect("snapshot");
    let top = snapshot_block(&document, "z").expect("snapshot");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "p".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "z".to_owned(),
        },
    );
    assert!(ids(&document).is_empty());

    // Parent and sibling both gone: the top of the body.
    edit(&document, BlockEdit::RestoreBlock { snapshot: nested });
    assert_eq!(ids(&document), ["y"]);
    // Its previous sibling, p, is gone too: again the top of the body.
    edit(&document, BlockEdit::RestoreBlock { snapshot: top });
    assert_eq!(ids(&document), ["z", "y"]);
    let blocks = extract_blocks(&document).expect("blocks");
    assert!(blocks.iter().all(|block| block.depth == 0));
}

#[test]
fn a_snapshot_of_a_missing_block_is_refused() {
    let document = opened(&body(&[("a", "paragraph", "hello")]));
    assert!(snapshot_block(&document, "nope").is_err());
    assert!(
        apply(
            &document,
            &BlockEdit::RestoreBlock {
                snapshot: "not json".to_owned()
            }
        )
        .is_err()
    );
}
