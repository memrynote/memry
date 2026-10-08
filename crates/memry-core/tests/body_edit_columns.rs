//! Side-by-side columns (chapter 12 §12.9) under every body edit.
//!
//! `columnList` is `column column+` and `column` is `blockContainer+`. A node
//! y-prosemirror cannot build is deleted, and a deleted `columnList` takes
//! every block in it along, so each test here ends by checking the body still
//! satisfies both content expressions.

use std::sync::Arc;

use memry_core::crdt::blocks::{Block, blocks_to_text, extract_blocks};
use memry_core::crdt::body_edit::{
    BlockEdit, append_snapshot, apply, snapshot_block, top_level_block_ids,
};
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::{CrdtError, DocumentRegistry, extract_text};
use yrs::{
    Any, Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlElementRef,
    XmlFragment as _, XmlTextPrelim,
};

fn opened(update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-body-columns", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

fn empty() -> Arc<Document> {
    opened(&body(&[]))
}

fn paragraph(txn: &mut yrs::TransactionMut, parent: &XmlElementRef, at: u32, id: &str) {
    let container = parent.insert(txn, at, XmlElementPrelim::empty("blockContainer"));
    container.insert_attribute(txn, "id", id);
    let block = container.insert(txn, 0, XmlElementPrelim::empty("paragraph"));
    block.insert(txn, 0, XmlTextPrelim::new(id.to_uppercase()));
}

/// A top-level body: each entry is a paragraph id, or a column list given as
/// `(list id, [(column id, [paragraph ids])])`.
enum Row<'a> {
    P(&'a str),
    Columns(&'a str, &'a [(&'a str, &'a [&'a str])]),
}

fn body(rows: &[Row]) -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    for (index, row) in rows.iter().enumerate() {
        match row {
            Row::P(id) => paragraph(&mut txn, &group, index as u32, id),
            Row::Columns(list_id, columns) => {
                let list = group.insert(
                    &mut txn,
                    index as u32,
                    XmlElementPrelim::empty("columnList"),
                );
                list.insert_attribute(&mut txn, "id", *list_id);
                list.insert_attribute(&mut txn, "regionId", "");
                list.insert_attribute(&mut txn, "settings", "");
                for (position, (column_id, ids)) in columns.iter().enumerate() {
                    let column =
                        list.insert(&mut txn, position as u32, XmlElementPrelim::empty("column"));
                    column.insert_attribute(&mut txn, "id", *column_id);
                    column.insert_attribute(&mut txn, "width", Any::Number(1.0));
                    for (at, id) in ids.iter().enumerate() {
                        paragraph(&mut txn, &column, at as u32, id);
                    }
                }
            }
        }
    }
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

/// `[p0, cl[c1[a1, a2], c2[b1]], p9]`.
fn two_columns() -> Arc<Document> {
    opened(&body(&[
        Row::P("p0"),
        Row::Columns("cl", &[("c1", &["a1", "a2"]), ("c2", &["b1"])]),
        Row::P("p9"),
    ]))
}

fn prop<'a>(block: &'a Block, name: &str) -> Option<&'a str> {
    block
        .props
        .iter()
        .find(|prop| prop.name == name)
        .map(|prop| prop.value.as_str())
}

/// Each block as `depth kind id`, the id read from the props for a column
/// layout row (which carries it there, not in `Block::id`).
fn outline(document: &Document) -> Vec<String> {
    extract_blocks(document)
        .expect("blocks")
        .iter()
        .map(|block| {
            let id = block
                .id
                .clone()
                .or_else(|| prop(block, "id").map(str::to_owned))
                .unwrap_or_default();
            format!("{} {} {id}", block.depth, block.kind)
        })
        .collect()
}

/// Every `columnList` holds two or more columns and nothing else, and every
/// column one or more blockContainers and nothing else.
fn assert_valid(document: &Document) {
    let blocks = extract_blocks(document).expect("blocks");
    for (index, block) in blocks.iter().enumerate() {
        let children: Vec<&Block> = blocks[index + 1..]
            .iter()
            .take_while(|later| later.depth > block.depth)
            .filter(|later| later.depth == block.depth + 1)
            .collect();
        match block.kind.as_str() {
            "columnList" => {
                assert!(children.len() >= 2, "{:?}", outline(document));
                assert!(children.iter().all(|child| child.kind == "column"));
            }
            "column" => {
                assert!(!children.is_empty(), "{:?}", outline(document));
                assert!(children.iter().all(|child| child.id.is_some()));
            }
            _ => assert!(
                children.iter().all(|child| child.kind != "column"),
                "{:?}",
                outline(document)
            ),
        }
    }
}

fn edit(document: &Document, edit: BlockEdit) {
    apply(document, &edit).unwrap_or_else(|error| panic!("{edit:?}: {error:?}"));
    assert_valid(document);
}

fn refused(document: &Document, edit: BlockEdit) -> String {
    let before = outline(document);
    let error = apply(document, &edit).expect_err("refused");
    assert_eq!(outline(document), before, "a refusal changes nothing");
    match error {
        CrdtError::Undecodable { what, .. } => what,
        other => panic!("{other:?}"),
    }
}

fn lines(items: &[&str]) -> Vec<String> {
    items.iter().map(|line| (*line).to_owned()).collect()
}

// MARK: - InsertColumnList

#[test]
fn an_inserted_column_list_is_columns_of_one_empty_paragraph_each() {
    let document = empty();
    edit(
        &document,
        BlockEdit::InsertColumnList {
            after_block_id: None,
            columns: 3,
            new_block_id: "list".to_owned(),
        },
    );
    let blocks = extract_blocks(&document).expect("blocks");
    let shape: Vec<(u32, &str)> = blocks
        .iter()
        .map(|block| (block.depth, block.kind.as_str()))
        .collect();
    assert_eq!(
        shape,
        [
            (0, "columnList"),
            (1, "column"),
            (2, "paragraph"),
            (1, "column"),
            (2, "paragraph"),
            (1, "column"),
            (2, "paragraph"),
        ]
    );
    assert_eq!(prop(&blocks[0], "id"), Some("list"));
    assert_eq!(prop(&blocks[0], "regionId"), Some(""));
    assert_eq!(prop(&blocks[0], "settings"), Some(""));
    for column in blocks.iter().filter(|block| block.kind == "column") {
        assert_eq!(prop(column, "width"), Some("1"));
        assert!(prop(column, "id").is_some_and(|id| !id.is_empty()));
    }
    for paragraph in blocks.iter().filter(|block| block.kind == "paragraph") {
        assert!(paragraph.id.as_deref().is_some_and(|id| id.len() == 36));
        assert!(paragraph.inline.is_empty());
        assert_eq!(prop(paragraph, "textAlignment"), Some("left"));
    }
}

#[test]
fn a_column_list_with_no_anchor_lands_at_the_start_of_the_body() {
    let document = opened(&body(&[Row::P("p0")]));
    edit(
        &document,
        BlockEdit::InsertColumnList {
            after_block_id: None,
            columns: 2,
            new_block_id: "list".to_owned(),
        },
    );
    assert_eq!(outline(&document)[0], "0 columnList list");
    assert_eq!(
        outline(&document).last().map(String::as_str),
        Some("0 paragraph p0")
    );
}

#[test]
fn a_column_list_anchored_inside_a_column_lands_after_the_enclosing_list() {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::InsertColumnList {
            after_block_id: Some("a2".to_owned()),
            columns: 2,
            new_block_id: "list".to_owned(),
        },
    );
    let outline = outline(&document);
    let lists: Vec<&String> = outline
        .iter()
        .filter(|line| line.contains("columnList"))
        .collect();
    assert_eq!(lists, ["0 columnList cl", "0 columnList list"]);
    assert_eq!(outline.last().map(String::as_str), Some("0 paragraph p9"));
}

#[test]
fn a_column_count_outside_two_to_three_is_refused() {
    for columns in [0, 1, 4] {
        let what = refused(
            &empty(),
            BlockEdit::InsertColumnList {
                after_block_id: None,
                columns,
                new_block_id: "list".to_owned(),
            },
        );
        assert!(what.starts_with("column layout:"), "{what}");
    }
}

// MARK: - Edits that address a column layout row

#[test]
fn text_prop_and_type_edits_on_a_column_layout_row_are_refused_as_column_layout() {
    let document = two_columns();
    for id in ["cl", "c1"] {
        for edit in [
            BlockEdit::SetText {
                block_id: id.to_owned(),
                text: "x".to_owned(),
            },
            BlockEdit::ReplaceText {
                block_id: id.to_owned(),
                text: "x".to_owned(),
                base: None,
            },
            BlockEdit::SetProp {
                block_id: id.to_owned(),
                name: "width".to_owned(),
                value: "2".to_owned(),
            },
            BlockEdit::TurnInto {
                block_id: id.to_owned(),
                kind: "heading".to_owned(),
            },
            BlockEdit::SetMark {
                block_id: id.to_owned(),
                start: 0,
                end: 1,
                mark: "bold".to_owned(),
                value: None,
            },
            BlockEdit::Duplicate {
                block_id: id.to_owned(),
                new_block_id: "dup".to_owned(),
            },
            BlockEdit::Indent {
                block_id: id.to_owned(),
            },
            BlockEdit::Outdent {
                block_id: id.to_owned(),
            },
        ] {
            let what = refused(&document, edit);
            assert!(what.starts_with("column layout:"), "{id}: {what}");
        }
    }
}

#[test]
fn a_column_is_neither_deleted_moved_nor_an_anchor_on_its_own() {
    let document = two_columns();
    for edit in [
        BlockEdit::Delete {
            block_id: "c1".to_owned(),
        },
        BlockEdit::MoveBlock {
            block_id: "c1".to_owned(),
            after_block_id: None,
        },
        BlockEdit::MoveBlock {
            block_id: "p0".to_owned(),
            after_block_id: Some("c2".to_owned()),
        },
        BlockEdit::InsertParagraph {
            after_block_id: Some("c1".to_owned()),
            text: String::new(),
            new_block_id: "n".to_owned(),
        },
    ] {
        let what = refused(&document, edit);
        assert!(what.starts_with("column layout:"), "{what}");
    }
}

#[test]
fn a_column_layout_is_never_a_block_type() {
    let document = two_columns();
    for kind in ["columnList", "column"] {
        let what = refused(
            &document,
            BlockEdit::InsertBlock {
                kind: kind.to_owned(),
                after_block_id: Some("p0".to_owned()),
                text: String::new(),
                new_block_id: "n".to_owned(),
            },
        );
        assert!(what.starts_with("column layout:"), "{what}");
        let what = refused(
            &document,
            BlockEdit::TurnInto {
                block_id: "p0".to_owned(),
                kind: kind.to_owned(),
            },
        );
        assert!(what.starts_with("column layout:"), "{what}");
    }
}

#[test]
fn a_block_inserted_after_a_column_list_is_its_sibling_and_after_a_column_block_stays_in_the_column()
 {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::InsertParagraph {
            after_block_id: Some("cl".to_owned()),
            text: "after".to_owned(),
            new_block_id: "n1".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::InsertParagraph {
            after_block_id: Some("b1".to_owned()),
            text: "in".to_owned(),
            new_block_id: "n2".to_owned(),
        },
    );
    assert_eq!(
        outline(&document),
        lines(&[
            "0 paragraph p0",
            "0 columnList cl",
            "1 column c1",
            "2 paragraph a1",
            "2 paragraph a2",
            "1 column c2",
            "2 paragraph b1",
            "2 paragraph n2",
            "0 paragraph n1",
            "0 paragraph p9",
        ])
    );
}

#[test]
fn the_blocks_inside_a_column_take_text_edits_as_any_block_does() {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::SetText {
            block_id: "b1".to_owned(),
            text: "Right side".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::TurnInto {
            block_id: "a1".to_owned(),
            kind: "heading".to_owned(),
        },
    );
    assert_eq!(
        extract_text(&document).expect("text"),
        "P0\n# A1\nA2\nRight side\nP9"
    );
}

// MARK: - Emptying a column

#[test]
fn deleting_the_last_block_of_one_of_two_columns_unwraps_the_list_in_place() {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "b1".to_owned(),
        },
    );
    assert_eq!(
        outline(&document),
        lines(&[
            "0 paragraph p0",
            "0 paragraph a1",
            "0 paragraph a2",
            "0 paragraph p9"
        ])
    );
    assert_eq!(extract_text(&document).expect("text"), "P0\nA1\nA2\nP9");
}

#[test]
fn deleting_the_last_block_of_one_of_three_columns_removes_only_that_column() {
    let document = opened(&body(&[Row::Columns(
        "cl",
        &[("c1", &["a1"]), ("c2", &["b1"]), ("c3", &["d1"])],
    )]));
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "b1".to_owned(),
        },
    );
    assert_eq!(
        outline(&document),
        lines(&[
            "0 columnList cl",
            "1 column c1",
            "2 paragraph a1",
            "1 column c3",
            "2 paragraph d1"
        ])
    );
}

#[test]
fn deleting_one_of_several_blocks_in_a_column_leaves_the_column() {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "a1".to_owned(),
        },
    );
    assert_eq!(
        outline(&document)[1..4],
        lines(&["0 columnList cl", "1 column c1", "2 paragraph a2"])
    );
}

#[test]
fn moving_the_last_block_out_of_a_column_unwraps_the_list() {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::MoveBlock {
            block_id: "b1".to_owned(),
            after_block_id: Some("p9".to_owned()),
        },
    );
    assert_eq!(
        outline(&document),
        lines(&[
            "0 paragraph p0",
            "0 paragraph a1",
            "0 paragraph a2",
            "0 paragraph p9",
            "0 paragraph b1"
        ])
    );
}

#[test]
fn moving_a_columns_last_block_into_the_other_column_keeps_it_through_the_unwrap() {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::MoveBlock {
            block_id: "b1".to_owned(),
            after_block_id: Some("a1".to_owned()),
        },
    );
    assert_eq!(
        outline(&document),
        lines(&[
            "0 paragraph p0",
            "0 paragraph a1",
            "0 paragraph b1",
            "0 paragraph a2",
            "0 paragraph p9"
        ])
    );
}

#[test]
fn a_columns_top_level_block_cannot_be_outdented() {
    // Desktop's `liftItem` is a no-op on a column's own block; lifting it past
    // the list would move it out of its column.
    let document = two_columns();
    for id in ["a1", "b1"] {
        let what = refused(
            &document,
            BlockEdit::Outdent {
                block_id: id.to_owned(),
            },
        );
        assert!(what.starts_with("column layout:"), "{what}");
    }
}

#[test]
fn a_block_nested_inside_a_column_outdents_within_that_column() {
    let document = two_columns();
    let before = outline(&document);
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "a2".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::Outdent {
            block_id: "a2".to_owned(),
        },
    );
    assert_eq!(outline(&document), before);
}

#[test]
fn a_block_cannot_be_indented_under_a_column_list() {
    let what = refused(
        &two_columns(),
        BlockEdit::Indent {
            block_id: "p9".to_owned(),
        },
    );
    assert!(what.starts_with("column layout:"), "{what}");
}

#[test]
fn indenting_inside_a_column_nests_under_the_previous_block_there() {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::Indent {
            block_id: "a2".to_owned(),
        },
    );
    assert_eq!(
        outline(&document)[1..5],
        lines(&[
            "0 columnList cl",
            "1 column c1",
            "2 paragraph a1",
            "3 paragraph a2"
        ])
    );
}

// MARK: - Whole column lists

#[test]
fn a_column_list_moves_whole_among_top_level_blocks() {
    let document = two_columns();
    edit(
        &document,
        BlockEdit::MoveBlock {
            block_id: "cl".to_owned(),
            after_block_id: Some("p9".to_owned()),
        },
    );
    assert_eq!(
        outline(&document)[0..2],
        lines(&["0 paragraph p0", "0 paragraph p9"])
    );
    assert_eq!(outline(&document)[2], "0 columnList cl");
    assert_eq!(outline(&document).len(), 8);
}

#[test]
fn a_column_list_is_never_moved_inside_itself_or_into_a_column() {
    let document = two_columns();
    let what = refused(
        &document,
        BlockEdit::MoveBlock {
            block_id: "cl".to_owned(),
            after_block_id: Some("a1".to_owned()),
        },
    );
    assert!(what.contains("inside itself"), "{what}");

    let nested = opened(&body(&[
        Row::Columns("x", &[("x1", &["xa"]), ("x2", &["xb"])]),
        Row::Columns("cl", &[("c1", &["a1"]), ("c2", &["b1"])]),
    ]));
    let what = refused(
        &nested,
        BlockEdit::MoveBlock {
            block_id: "cl".to_owned(),
            after_block_id: Some("xa".to_owned()),
        },
    );
    assert!(what.starts_with("column layout:"), "{what}");
}

#[test]
fn a_deleted_column_list_is_restored_whole_with_its_ids() {
    let document = two_columns();
    let before = outline(&document);
    let snapshot = snapshot_block(&document, "cl").expect("snapshot");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "cl".to_owned(),
        },
    );
    assert_eq!(
        outline(&document),
        lines(&["0 paragraph p0", "0 paragraph p9"])
    );
    edit(&document, BlockEdit::RestoreBlock { snapshot });
    assert_eq!(outline(&document), before);
}

#[test]
fn a_column_alone_cannot_be_snapshotted() {
    let error = snapshot_block(&two_columns(), "c1").expect_err("refused");
    assert!(
        matches!(error, CrdtError::Undecodable { what, .. } if what.starts_with("column layout:"))
    );
}

#[test]
fn undoing_the_delete_of_a_columns_first_block_puts_it_back_in_that_column() {
    let document = two_columns();
    let before = outline(&document);
    let snapshot = snapshot_block(&document, "a1").expect("snapshot");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "a1".to_owned(),
        },
    );
    edit(&document, BlockEdit::RestoreBlock { snapshot });
    assert_eq!(outline(&document), before);
}

#[test]
fn undoing_the_delete_of_a_columns_only_block_lands_it_where_the_unwrapped_list_stood() {
    // b1 is column two's only block: deleting it removes the column and
    // unwraps the list, so neither is there to go back into.
    let document = two_columns();
    let snapshot = snapshot_block(&document, "b1").expect("snapshot");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "b1".to_owned(),
        },
    );
    assert_eq!(
        outline(&document),
        lines(&[
            "0 paragraph p0",
            "0 paragraph a1",
            "0 paragraph a2",
            "0 paragraph p9"
        ])
    );
    edit(&document, BlockEdit::RestoreBlock { snapshot });
    assert_eq!(
        outline(&document),
        lines(&[
            "0 paragraph p0",
            "0 paragraph a1",
            "0 paragraph a2",
            "0 paragraph b1",
            "0 paragraph p9"
        ])
    );
}

#[test]
fn a_snapshot_without_a_column_place_still_restores_at_the_start_of_the_body() {
    // Snapshots taken before `column_place` existed carry no such field.
    let document = two_columns();
    let snapshot = snapshot_block(&document, "b1").expect("snapshot");
    let mut older: serde_json::Value = serde_json::from_str(&snapshot).expect("json");
    older
        .as_object_mut()
        .expect("object")
        .remove("column_place")
        .expect("recorded");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "b1".to_owned(),
        },
    );
    edit(
        &document,
        BlockEdit::RestoreBlock {
            snapshot: older.to_string(),
        },
    );
    assert_eq!(outline(&document)[0], "0 paragraph b1");
}

#[test]
fn undoing_the_delete_of_a_first_columns_only_block_lands_it_before_the_unwrapped_blocks() {
    let document = opened(&body(&[
        Row::Columns("cl", &[("c1", &["a1"]), ("c2", &["b1", "b2"])]),
        Row::P("p9"),
    ]));
    let snapshot = snapshot_block(&document, "a1").expect("snapshot");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "a1".to_owned(),
        },
    );
    edit(&document, BlockEdit::RestoreBlock { snapshot });
    assert_eq!(
        outline(&document),
        lines(&[
            "0 paragraph a1",
            "0 paragraph b1",
            "0 paragraph b2",
            "0 paragraph p9"
        ])
    );
}

#[test]
fn undoing_the_delete_of_a_columns_only_block_rebuilds_the_column_when_the_list_remains() {
    let document = opened(&body(&[
        Row::P("p0"),
        Row::Columns("cl", &[("c1", &["a1"]), ("c2", &["b1"]), ("c3", &["d1"])]),
    ]));
    let before = outline(&document);
    let snapshot = snapshot_block(&document, "b1").expect("snapshot");
    edit(
        &document,
        BlockEdit::Delete {
            block_id: "b1".to_owned(),
        },
    );
    assert!(!outline(&document).contains(&"1 column c2".to_owned()));
    edit(&document, BlockEdit::RestoreBlock { snapshot });
    assert_eq!(outline(&document), before);
    let blocks = extract_blocks(&document).expect("blocks");
    let column = blocks
        .iter()
        .find(|block| prop(block, "id") == Some("c2"))
        .expect("column rebuilt");
    assert_eq!(prop(column, "width"), Some("1"));
}

#[test]
fn a_whole_body_copy_keeps_its_column_lists() {
    let source = two_columns();
    let ids = top_level_block_ids(&source).expect("ids");
    assert_eq!(ids, ["p0", "cl", "p9"]);
    let copy = empty();
    for id in &ids {
        let snapshot = snapshot_block(&source, id).expect("snapshot");
        append_snapshot(&copy, &snapshot).expect("append");
    }
    assert_valid(&copy);
    assert_eq!(outline(&copy), outline(&source));
}

#[test]
fn an_appended_column_list_whose_ids_are_taken_is_given_fresh_ones() {
    let document = two_columns();
    let snapshot = snapshot_block(&document, "cl").expect("snapshot");
    append_snapshot(&document, &snapshot).expect("append");
    assert_valid(&document);
    let outline = outline(&document);
    let mut ids: Vec<&str> = outline
        .iter()
        .map(|line| line.rsplit(' ').next().unwrap_or_default())
        .collect();
    let total = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), total, "{outline:?}");
}

// MARK: - Text

#[test]
fn columns_contribute_their_blocks_lines_and_nothing_of_their_own() {
    let document = two_columns();
    let text = extract_text(&document).expect("text");
    assert_eq!(text, "P0\nA1\nA2\nB1\nP9");
    assert_eq!(
        blocks_to_text(&extract_blocks(&document).expect("blocks")),
        text
    );
}
