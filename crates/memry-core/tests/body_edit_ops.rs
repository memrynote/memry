//! The operations Phase E added, held to the shapes chapter 12 requires.
//!
//! The `block-edit` vector class holds the writer to desktop's exact document
//! for the operations it covers. These tests cover the rest — tables,
//! movement, marks — and the refusals, which a vector class cannot express
//! because a refused operation produces no document to compare.

use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::blocks::{extract_blocks, extract_table};
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use yrs::{
    Any, Doc, ReadTxn as _, Transact as _, Xml as _, XmlElementPrelim, XmlFragment as _,
    XmlTextPrelim,
};

/// Opens a document over an authored update.
fn opened(update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-body-edit", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

/// A body with the mandatory top-level `blockGroup` (§12.5.0) and the given
/// blocks, authored in a separate doc and applied as an update — the only
/// sanctioned way in (§12.5.1).
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

/// A body holding one 2x2 table, built the way BlockNote builds one:
/// `table > tableRow > tableCell > tableParagraph`, with no id below the
/// container (Q1).
fn table_body() -> Vec<u8> {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = doc.transact_mut();
    let group = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockGroup"));
    let container = group.insert(&mut txn, 0, XmlElementPrelim::empty("blockContainer"));
    container.insert_attribute(&mut txn, "id", "table-1");
    let table = container.insert(&mut txn, 0, XmlElementPrelim::empty("table"));
    table.insert_attribute(&mut txn, "textColor", "default");
    for row_index in 0..2u32 {
        let row = table.insert(&mut txn, row_index, XmlElementPrelim::empty("tableRow"));
        for column in 0..2u32 {
            let cell = row.insert(&mut txn, column, XmlElementPrelim::empty("tableCell"));
            cell.insert_attribute(&mut txn, "colspan", Any::Number(1.0));
            cell.insert_attribute(&mut txn, "rowspan", Any::Number(1.0));
            let paragraph = cell.insert(&mut txn, 0, XmlElementPrelim::empty("tableParagraph"));
            paragraph.insert(
                &mut txn,
                0,
                XmlTextPrelim::new(format!("r{row_index}c{column}")),
            );
        }
    }
    txn.encode_state_as_update_v1(&yrs::StateVector::default())
}

fn canonical(document: &Document) -> String {
    canonical_fragment(document).expect("canonical")
}

/// The ids of every block, in document order.
fn ids(document: &Document) -> Vec<String> {
    extract_blocks(document)
        .expect("blocks")
        .into_iter()
        .filter_map(|block| block.id)
        .collect()
}

/// A block's own text, as the reader sees it.
fn text_of(block: &memry_core::crdt::blocks::Block) -> String {
    block.inline.iter().map(|run| run.text.as_str()).collect()
}

/// A cell's text, which lives in the blocks it holds.
fn cell_text(cell: &memry_core::crdt::blocks::TableCell) -> String {
    cell.content.iter().map(text_of).collect()
}

// MARK: - §12.5.0, the rule whose damage is invisible

/// **The single most dangerous mistake a writing client can make.**
///
/// A `blockContainer` placed beside the fragment's `blockGroup` is a second
/// top-level child. y-prosemirror cannot construct a `doc` with two and
/// answers by deleting the element — silently. Every insert path has to land
/// inside the group.
#[test]
fn every_append_lands_inside_the_one_top_level_block_group() {
    let document = opened(&body(&[("a", "paragraph", "first")]));
    apply(
        &document,
        &BlockEdit::InsertParagraph {
            after_block_id: None,
            text: "appended".to_owned(),
            new_block_id: "b".to_owned(),
        },
    )
    .expect("append");
    apply(
        &document,
        &BlockEdit::InsertBlock {
            kind: "heading".to_owned(),
            after_block_id: None,
            text: "also appended".to_owned(),
            new_block_id: "c".to_owned(),
        },
    )
    .expect("append a heading");

    let rendered = canonical(&document);
    let top_level: Vec<&str> = rendered
        .lines()
        .filter(|line| line.starts_with("0 "))
        .collect();
    assert_eq!(
        top_level,
        ["0 element blockGroup"],
        "a second top-level child is deleted silently by y-prosemirror"
    );
    assert_eq!(ids(&document), ["a", "b", "c"]);
}

/// A body whose top level is not a single `blockGroup` is refused rather than
/// guessed at, because every guess writes into a document a peer cannot
/// construct.
#[test]
fn an_unrecognised_top_level_layout_is_refused_rather_than_guessed_at() {
    let doc = Doc::new();
    let fragment = doc.get_or_insert_xml_fragment("prosemirror");
    let update = {
        let mut txn = doc.transact_mut();
        // A bare container at the top: the very shape §12.5.0 warns about.
        let container = fragment.push_back(&mut txn, XmlElementPrelim::empty("blockContainer"));
        container.insert_attribute(&mut txn, "id", "loose");
        txn.encode_state_as_update_v1(&yrs::StateVector::default())
    };
    let document = opened(&update);

    let refused = apply(
        &document,
        &BlockEdit::InsertParagraph {
            after_block_id: None,
            text: "nope".to_owned(),
            new_block_id: "b".to_owned(),
        },
    );
    assert!(
        refused.is_err(),
        "appending into an unrecognised layout must be refused"
    );
}

/// A type this build cannot shape is refused, because the bare node it would
/// otherwise write is the one that gets deleted.
#[test]
fn a_block_type_this_build_cannot_shape_is_refused() {
    let document = opened(&body(&[("a", "paragraph", "first")]));
    let refused = apply(
        &document,
        &BlockEdit::InsertBlock {
            kind: "blockFromSomeFutureVersion".to_owned(),
            after_block_id: None,
            text: String::new(),
            new_block_id: "b".to_owned(),
        },
    );
    assert!(refused.is_err(), "an unknown type must be refused");
}

// MARK: - Prop types (N408)

/// **Unticking a box has to actually untick it.**
///
/// The reference writer stores `checked` as a boolean. Stored as the string
/// `"false"` it reads as *ticked* anywhere the prop is tested for truth,
/// because a non-empty string is truthy — the document is valid and wrong.
#[test]
fn a_boolean_prop_is_stored_as_a_boolean_not_as_its_text() {
    let document = opened(&body(&[("a", "checkListItem", "milk")]));
    apply(
        &document,
        &BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "checked".to_owned(),
            value: "true".to_owned(),
        },
    )
    .expect("tick");
    assert!(
        canonical(&document).contains("checked=true"),
        "checked must be the boolean true, not the string:\n{}",
        canonical(&document)
    );

    apply(
        &document,
        &BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "checked".to_owned(),
            value: "false".to_owned(),
        },
    )
    .expect("untick");
    assert!(
        canonical(&document).contains("checked=false"),
        "unticking must store the boolean false:\n{}",
        canonical(&document)
    );
}

/// `level` is a number. Stored as text it happens to survive `extract_text`,
/// whose heading parser reads a digit prefix either way — which is exactly
/// how a defect like this hides.
#[test]
fn a_numeric_prop_is_stored_as_a_number() {
    let document = opened(&body(&[("a", "heading", "Title")]));
    apply(
        &document,
        &BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "level".to_owned(),
            value: "3".to_owned(),
        },
    )
    .expect("set level");
    assert!(
        canonical(&document).contains("level=3"),
        "level must be the number 3:\n{}",
        canonical(&document)
    );
}

/// A prop this build has no declared type for is written as text, which is
/// the honest fallback for a schema that has moved on rather than a refusal.
#[test]
fn an_undeclared_prop_still_writes_as_text() {
    let document = opened(&body(&[("a", "paragraph", "hello")]));
    apply(
        &document,
        &BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "somePropFromTheFuture".to_owned(),
            value: "value".to_owned(),
        },
    )
    .expect("set");
    assert!(canonical(&document).contains("somePropFromTheFuture=\"value\""));
}

// MARK: - Turning a block into another (N405)

/// The text survives the change of type, and so does the container's id: a
/// caret or selection pointing at this block still resolves afterwards.
#[test]
fn turning_a_block_into_another_keeps_its_text_and_its_id() {
    let document = opened(&body(&[("a", "paragraph", "Chapter one")]));
    apply(
        &document,
        &BlockEdit::TurnInto {
            block_id: "a".to_owned(),
            kind: "heading".to_owned(),
        },
    )
    .expect("turn into");

    let blocks = extract_blocks(&document).expect("blocks");
    let heading = blocks.iter().find(|block| block.kind == "heading");
    let heading = heading.expect("the block is now a heading");
    assert_eq!(heading.id.as_deref(), Some("a"), "the id must survive");
    assert_eq!(text_of(heading), "Chapter one", "the text must survive");
    // And it gained the props its new type declares.
    assert!(canonical(&document).contains("level=1"));
}

/// **Nested children outlive a retype.** A list item turned into a paragraph
/// keeps everything indented under it; folding the `blockGroup` away would
/// delete blocks the user never touched.
#[test]
fn turning_a_block_into_another_keeps_the_blocks_nested_under_it() {
    let document = opened(&body(&[("parent", "bulletListItem", "outer")]));
    apply(
        &document,
        &BlockEdit::InsertParagraph {
            after_block_id: None,
            text: "child".to_owned(),
            new_block_id: "child".to_owned(),
        },
    )
    .expect("insert");
    apply(
        &document,
        &BlockEdit::Indent {
            block_id: "child".to_owned(),
        },
    )
    .expect("indent");

    apply(
        &document,
        &BlockEdit::TurnInto {
            block_id: "parent".to_owned(),
            kind: "paragraph".to_owned(),
        },
    )
    .expect("turn into");

    let blocks = extract_blocks(&document).expect("blocks");
    let child = blocks
        .iter()
        .find(|block| block.id.as_deref() == Some("child"));
    let child = child.expect("the nested child must survive the retype");
    assert_eq!(text_of(child), "child");
    assert!(child.depth > 0, "and it must still be nested");
}

// MARK: - Tables (N402, N403, N404)

/// **A cell has no id, which is why it is addressed by position (Q1).**
/// BlockNote builds `tableCell > tableParagraph` with no `blockContainer`
/// between, so there is nothing for an id-based operation to find.
#[test]
fn a_cells_text_is_set_by_position_because_a_cell_has_no_id() {
    let document = opened(&table_body());
    apply(
        &document,
        &BlockEdit::SetCellText {
            table_id: "table-1".to_owned(),
            row: 1,
            column: 0,
            text: "edited".to_owned(),
        },
    )
    .expect("set cell text");

    let table = extract_table(&document, "table-1")
        .expect("extract")
        .expect("a table");
    assert_eq!(cell_text(&table.rows[1].cells[0]), "edited");
    // The others are untouched.
    assert_eq!(cell_text(&table.rows[0].cells[0]), "r0c0");
    assert_eq!(cell_text(&table.rows[1].cells[1]), "r1c1");
    // And the cell still has no id of its own.
    assert!(table.rows[1].cells[0].block_id.is_none());
}

/// The text goes inside the cell's `tableParagraph`, not directly into the
/// cell: bare text in a `tableCell` is a node BlockNote cannot construct.
#[test]
fn a_cells_text_lands_inside_its_table_paragraph() {
    let document = opened(&table_body());
    apply(
        &document,
        &BlockEdit::SetCellText {
            table_id: "table-1".to_owned(),
            row: 0,
            column: 0,
            text: "inside".to_owned(),
        },
    )
    .expect("set cell text");

    let rendered = canonical(&document);
    let paragraph_line = rendered
        .lines()
        .position(|line| line.contains("tableParagraph"))
        .expect("a tableParagraph");
    let next = rendered.lines().nth(paragraph_line + 1).unwrap_or_default();
    assert!(
        next.contains("text \"inside\""),
        "the text must sit under the tableParagraph, not the cell:\n{rendered}"
    );
}

/// A new row takes its width from the table, so a table never gains a ragged
/// row that desktop would render short.
#[test]
fn an_inserted_row_is_as_wide_as_the_table() {
    let document = opened(&table_body());
    apply(
        &document,
        &BlockEdit::InsertRow {
            table_id: "table-1".to_owned(),
            at: 1,
        },
    )
    .expect("insert row");

    let table = extract_table(&document, "table-1")
        .expect("extract")
        .expect("a table");
    assert_eq!(table.rows.len(), 3);
    assert_eq!(
        table.rows[1].cells.len(),
        2,
        "the new row must be full width"
    );
    assert_eq!(cell_text(&table.rows[1].cells[0]), "");
    // Inserted at 1 means the old row 1 moved down rather than being replaced.
    assert_eq!(cell_text(&table.rows[2].cells[0]), "r1c0");
}

/// A column reaches every row, including rows added later.
#[test]
fn an_inserted_column_reaches_every_row() {
    let document = opened(&table_body());
    apply(
        &document,
        &BlockEdit::InsertColumn {
            table_id: "table-1".to_owned(),
            at: 1,
        },
    )
    .expect("insert column");

    let table = extract_table(&document, "table-1")
        .expect("extract")
        .expect("a table");
    for row in &table.rows {
        assert_eq!(row.cells.len(), 3, "every row must gain the column");
    }
    assert_eq!(cell_text(&table.rows[0].cells[0]), "r0c0");
    assert_eq!(
        cell_text(&table.rows[0].cells[1]),
        "",
        "the new cell is empty"
    );
    assert_eq!(cell_text(&table.rows[0].cells[2]), "r0c1");
}

#[test]
fn deleting_a_row_and_a_column_removes_exactly_one_of_each() {
    let document = opened(&table_body());
    apply(
        &document,
        &BlockEdit::DeleteRow {
            table_id: "table-1".to_owned(),
            at: 0,
        },
    )
    .expect("delete row");
    apply(
        &document,
        &BlockEdit::DeleteColumn {
            table_id: "table-1".to_owned(),
            at: 0,
        },
    )
    .expect("delete column");

    let table = extract_table(&document, "table-1")
        .expect("extract")
        .expect("a table");
    assert_eq!(table.rows.len(), 1);
    assert_eq!(table.rows[0].cells.len(), 1);
    assert_eq!(cell_text(&table.rows[0].cells[0]), "r1c1");
}

/// A bad index is refused **before** anything is removed, so a mistake cannot
/// leave the table half-narrowed.
#[test]
fn a_table_index_outside_the_table_is_refused_before_anything_changes() {
    let document = opened(&table_body());
    let before = canonical(&document);

    for edit in [
        BlockEdit::DeleteRow {
            table_id: "table-1".to_owned(),
            at: 9,
        },
        BlockEdit::DeleteColumn {
            table_id: "table-1".to_owned(),
            at: 9,
        },
        BlockEdit::SetCellText {
            table_id: "table-1".to_owned(),
            row: 9,
            column: 0,
            text: "nope".to_owned(),
        },
    ] {
        assert!(apply(&document, &edit).is_err(), "{edit:?} must be refused");
    }
    assert_eq!(
        canonical(&document),
        before,
        "a refused table operation must leave the document untouched"
    );
}

/// A table operation aimed at a block that is not a table is refused, rather
/// than writing rows into a paragraph.
#[test]
fn a_table_operation_on_a_paragraph_is_refused() {
    let document = opened(&body(&[("a", "paragraph", "hello")]));
    let refused = apply(
        &document,
        &BlockEdit::InsertRow {
            table_id: "a".to_owned(),
            at: 0,
        },
    );
    assert!(refused.is_err());
}

/// `colwidth` is an array of numbers, which is the shape prosemirror-tables
/// stores and desktop's column sizing reads.
#[test]
fn a_cells_column_width_is_stored_as_an_array_of_numbers() {
    let document = opened(&table_body());
    apply(
        &document,
        &BlockEdit::SetCellProp {
            table_id: "table-1".to_owned(),
            row: 0,
            column: 0,
            name: "colwidth".to_owned(),
            value: "180".to_owned(),
        },
    )
    .expect("set colwidth");
    assert!(
        canonical(&document).contains("colwidth=[180]"),
        "colwidth must be an array:\n{}",
        canonical(&document)
    );
}

// MARK: - Moving blocks (N406)

#[test]
fn a_moved_block_lands_after_its_anchor_and_leaves_the_rest_in_order() {
    let document = opened(&body(&[
        ("a", "paragraph", "one"),
        ("b", "paragraph", "two"),
        ("c", "paragraph", "three"),
    ]));
    apply(
        &document,
        &BlockEdit::MoveBlock {
            block_id: "a".to_owned(),
            after_block_id: Some("c".to_owned()),
        },
    )
    .expect("move");
    assert_eq!(ids(&document), ["b", "c", "a"]);

    // And to the very start, which is the case with no anchor.
    apply(
        &document,
        &BlockEdit::MoveBlock {
            block_id: "a".to_owned(),
            after_block_id: None,
        },
    )
    .expect("move to start");
    assert_eq!(ids(&document), ["a", "b", "c"]);
}

/// A move carries the block's text and props, not just its id.
#[test]
fn a_moved_block_keeps_what_it_said() {
    let document = opened(&body(&[
        ("a", "heading", "Title"),
        ("b", "paragraph", "body"),
    ]));
    apply(
        &document,
        &BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "level".to_owned(),
            value: "2".to_owned(),
        },
    )
    .expect("set level");
    apply(
        &document,
        &BlockEdit::MoveBlock {
            block_id: "a".to_owned(),
            after_block_id: Some("b".to_owned()),
        },
    )
    .expect("move");

    let blocks = extract_blocks(&document).expect("blocks");
    let heading = blocks
        .iter()
        .find(|block| block.id.as_deref() == Some("a"))
        .expect("the heading");
    assert_eq!(text_of(heading), "Title");
    assert_eq!(heading.kind, "heading");
    assert!(
        canonical(&document).contains("level=2"),
        "a move must carry the block's props"
    );
}

/// Moving a block after itself is a no-op rather than a churning
/// remove-and-reinsert.
#[test]
fn moving_a_block_after_itself_changes_nothing() {
    let document = opened(&body(&[
        ("a", "paragraph", "one"),
        ("b", "paragraph", "two"),
    ]));
    let before = canonical(&document);
    apply(
        &document,
        &BlockEdit::MoveBlock {
            block_id: "a".to_owned(),
            after_block_id: Some("a".to_owned()),
        },
    )
    .expect("no-op move");
    assert_eq!(canonical(&document), before);
}

#[test]
fn indenting_nests_a_block_under_its_previous_sibling_and_outdenting_lifts_it_back() {
    let document = opened(&body(&[
        ("a", "paragraph", "one"),
        ("b", "paragraph", "two"),
    ]));
    apply(
        &document,
        &BlockEdit::Indent {
            block_id: "b".to_owned(),
        },
    )
    .expect("indent");

    let blocks = extract_blocks(&document).expect("blocks");
    let nested = blocks
        .iter()
        .find(|block| block.id.as_deref() == Some("b"))
        .expect("b");
    assert!(nested.depth > 0, "b must be nested under a");
    assert_eq!(text_of(nested), "two", "and must keep its text");

    apply(
        &document,
        &BlockEdit::Outdent {
            block_id: "b".to_owned(),
        },
    )
    .expect("outdent");
    let blocks = extract_blocks(&document).expect("blocks");
    let lifted = blocks
        .iter()
        .find(|block| block.id.as_deref() == Some("b"))
        .expect("b");
    assert_eq!(lifted.depth, 0, "b must be back at the top level");
    assert_eq!(ids(&document), ["a", "b"]);
}

/// Desktop's rule, matched: with no previous sibling there is nothing to nest
/// under, and a top-level block has nothing to lift to.
#[test]
fn a_block_with_nowhere_to_go_is_refused_rather_than_moved_somewhere_odd() {
    let document = opened(&body(&[("a", "paragraph", "one")]));
    assert!(
        apply(
            &document,
            &BlockEdit::Indent {
                block_id: "a".to_owned()
            }
        )
        .is_err(),
        "the first block has no previous sibling to nest under"
    );
    assert!(
        apply(
            &document,
            &BlockEdit::Outdent {
                block_id: "a".to_owned()
            }
        )
        .is_err(),
        "a top-level block has nothing to lift to"
    );
}

#[test]
fn a_duplicate_lands_directly_after_the_original_and_says_the_same_thing() {
    let document = opened(&body(&[
        ("a", "heading", "Title"),
        ("b", "paragraph", "body"),
    ]));
    apply(
        &document,
        &BlockEdit::SetProp {
            block_id: "a".to_owned(),
            name: "level".to_owned(),
            value: "2".to_owned(),
        },
    )
    .expect("set level");
    apply(
        &document,
        &BlockEdit::Duplicate {
            block_id: "a".to_owned(),
            new_block_id: "a-copy".to_owned(),
        },
    )
    .expect("duplicate");

    assert_eq!(ids(&document), ["a", "a-copy", "b"]);
    let blocks = extract_blocks(&document).expect("blocks");
    let copy = blocks
        .iter()
        .find(|block| block.id.as_deref() == Some("a-copy"))
        .expect("the copy");
    assert_eq!(copy.kind, "heading");
    assert_eq!(text_of(copy), "Title");
    // The original's props, not the type's defaults: a level-2 heading
    // duplicates as a level-2 heading.
    assert_eq!(
        canonical(&document).matches("level=2").count(),
        2,
        "the copy must carry the original's props:\n{}",
        canonical(&document)
    );
}

// MARK: - Inline marks (N407)

/// **This is what removes `SetText`'s limitation.** Replacing a block's whole
/// text loses its marks; a range keeps every run outside it, so a shell with
/// a selection no longer has to choose between formatting and editing.
#[test]
fn a_mark_covers_its_range_and_leaves_the_rest_of_the_block_alone() {
    let document = opened(&body(&[("a", "paragraph", "hello world")]));
    apply(
        &document,
        &BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 5,
            mark: "bold".to_owned(),
            value: None,
        },
    )
    .expect("bold");

    let rendered = canonical(&document);
    assert!(
        rendered.contains("\"hello\"") && rendered.contains("bold"),
        "the first word must carry the mark:\n{rendered}"
    );
    assert!(
        rendered.contains("\" world\""),
        "the rest must be a separate unmarked run:\n{rendered}"
    );
}

/// A link carries its address under `href`, which is the attribute name
/// y-prosemirror writes and the reader already reads.
#[test]
fn a_link_carries_its_address_where_the_reader_looks_for_it() {
    let document = opened(&body(&[("a", "paragraph", "memry")]));
    apply(
        &document,
        &BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 5,
            mark: "link".to_owned(),
            value: Some("https://memry.app".to_owned()),
        },
    )
    .expect("link");

    let runs = extract_blocks(&document)
        .expect("blocks")
        .into_iter()
        .find(|block| block.id.as_deref() == Some("a"))
        .expect("a")
        .inline;
    let linked = runs
        .iter()
        .find(|run| run.mark_attrs.contains_key("link.href"))
        .expect("a run carrying the link");
    assert_eq!(
        linked.mark_attrs.get("link.href").map(String::as_str),
        Some("https://memry.app")
    );
}

/// A colour is a string style, whose value y-prosemirror wraps in
/// `stringValue` — and the reader collapses back to the bare mark name.
#[test]
fn a_colour_mark_is_stored_the_way_the_reader_reads_it() {
    let document = opened(&body(&[("a", "paragraph", "warning")]));
    apply(
        &document,
        &BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 7,
            mark: "textColor".to_owned(),
            value: Some("red".to_owned()),
        },
    )
    .expect("colour");

    let runs = extract_blocks(&document)
        .expect("blocks")
        .into_iter()
        .find(|block| block.id.as_deref() == Some("a"))
        .expect("a")
        .inline;
    assert_eq!(
        runs.iter()
            .find_map(|run| run.mark_attrs.get("textColor"))
            .map(String::as_str),
        Some("red"),
        "the reader must see the colour it was given"
    );
}

#[test]
fn removing_a_mark_leaves_the_text_and_drops_only_the_mark() {
    let document = opened(&body(&[("a", "paragraph", "hello world")]));
    apply(
        &document,
        &BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 11,
            mark: "bold".to_owned(),
            value: None,
        },
    )
    .expect("bold");
    apply(
        &document,
        &BlockEdit::RemoveMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 11,
            mark: "bold".to_owned(),
        },
    )
    .expect("unbold");

    let block = extract_blocks(&document)
        .expect("blocks")
        .into_iter()
        .find(|block| block.id.as_deref() == Some("a"))
        .expect("a");
    assert_eq!(text_of(&block), "hello world", "the text must survive");
    assert!(
        block
            .inline
            .iter()
            .all(|run| !run.marks.iter().any(|mark| mark == "bold")),
        "no run may still be bold"
    );
}

/// An empty range formats nothing; a caller that computed one should hear so
/// rather than watch the operation silently do nothing.
#[test]
fn an_empty_or_out_of_range_selection_is_refused() {
    let document = opened(&body(&[("a", "paragraph", "hello")]));
    for (start, end) in [(3u32, 3u32), (4, 2), (99, 120)] {
        assert!(
            apply(
                &document,
                &BlockEdit::SetMark {
                    block_id: "a".to_owned(),
                    start,
                    end,
                    mark: "bold".to_owned(),
                    value: None,
                },
            )
            .is_err(),
            "{start}..{end} must be refused"
        );
    }
}

/// A range running past the end of the block is clamped rather than refused:
/// a selection to the end of a line is an ordinary thing for a shell to send.
#[test]
fn a_range_running_past_the_end_is_clamped_to_the_block() {
    let document = opened(&body(&[("a", "paragraph", "hello")]));
    apply(
        &document,
        &BlockEdit::SetMark {
            block_id: "a".to_owned(),
            start: 0,
            end: 500,
            mark: "italic".to_owned(),
            value: None,
        },
    )
    .expect("clamped");
    let block = extract_blocks(&document)
        .expect("blocks")
        .into_iter()
        .find(|block| block.id.as_deref() == Some("a"))
        .expect("a");
    assert_eq!(text_of(&block), "hello");
}

// MARK: - A task block's text is a prop

/// `taskBlock` has `content: 'none'` and keeps its text in `title`. Writing it
/// as inline content produces a node real BlockNote refuses to build — which
/// is a bug the vector class caught by authoring through BlockNote itself.
#[test]
fn a_task_blocks_text_goes_to_its_title_prop() {
    let document = opened(&body(&[("a", "paragraph", "x")]));
    apply(
        &document,
        &BlockEdit::InsertBlock {
            kind: "taskBlock".to_owned(),
            after_block_id: Some("a".to_owned()),
            text: "Buy milk".to_owned(),
            new_block_id: "task".to_owned(),
        },
    )
    .expect("insert task");
    assert!(
        canonical(&document).contains("title=\"Buy milk\""),
        "a task's text is its title prop:\n{}",
        canonical(&document)
    );

    apply(
        &document,
        &BlockEdit::SetText {
            block_id: "task".to_owned(),
            text: "Buy oat milk".to_owned(),
        },
    )
    .expect("retitle");
    assert!(canonical(&document).contains("title=\"Buy oat milk\""));
}

// MARK: - The types desktop offers (N405)

/// Desktop's "turn into" menu, every entry of it. A type that cannot be
/// reached from here is a menu item iOS would have to grey out.
#[test]
fn every_type_desktops_menu_offers_can_be_turned_into() {
    // heading1..3 are one type plus a `level`, which is why the menu's eleven
    // entries are nine types here.
    for kind in [
        "paragraph",
        "heading",
        "bulletListItem",
        "numberedListItem",
        "checkListItem",
        "toggleListItem",
        "quote",
        "codeBlock",
        "callout",
    ] {
        let document = opened(&body(&[("a", "paragraph", "carried across")]));
        apply(
            &document,
            &BlockEdit::TurnInto {
                block_id: "a".to_owned(),
                kind: kind.to_owned(),
            },
        )
        .unwrap_or_else(|error| panic!("turning into {kind} was refused: {error}"));

        let blocks = extract_blocks(&document).expect("blocks");
        let block = blocks
            .iter()
            .find(|block| block.id.as_deref() == Some("a"))
            .unwrap_or_else(|| panic!("{kind}: the block vanished"));
        assert_eq!(block.kind, kind);
        assert_eq!(
            text_of(block),
            "carried across",
            "{kind}: the text must cross the change of type"
        );
    }
}

/// The three heading levels the menu offers are one type plus a number, and
/// that number has to land as a number.
#[test]
fn the_menus_three_heading_levels_are_reachable() {
    for level in ["1", "2", "3"] {
        let document = opened(&body(&[("a", "paragraph", "Title")]));
        apply(
            &document,
            &BlockEdit::TurnInto {
                block_id: "a".to_owned(),
                kind: "heading".to_owned(),
            },
        )
        .expect("turn into heading");
        apply(
            &document,
            &BlockEdit::SetProp {
                block_id: "a".to_owned(),
                name: "level".to_owned(),
                value: level.to_owned(),
            },
        )
        .expect("set level");
        assert!(
            canonical(&document).contains(&format!("level={level}")),
            "heading {level} must store its level as a number"
        );
    }
}

// MARK: - One update, one outbox row (N409)

/// **FR-030: an edit's update row and its outbox row commit together.**
///
/// A crash between them is the failure this rule exists for: an update stored
/// without an outbox row is an edit the device keeps and never sends, and an
/// outbox row without its update is a push of something that is not there.
#[test]
fn an_edit_authors_exactly_one_update_and_a_refused_one_authors_none() {
    let authored: Arc<std::sync::Mutex<Vec<Vec<u8>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = Arc::clone(&authored);
    let sink: UpdateSink = Arc::new(move |_, update: &[u8]| {
        seen.lock().expect("lock").push(update.to_vec());
    });
    let registry = DocumentRegistry::new("device-outbox", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document
        .apply_durable_update(&body(&[("a", "paragraph", "one")]))
        .expect("seed");

    let after_seed = authored.lock().expect("lock").len();

    apply(
        &document,
        &BlockEdit::SetText {
            block_id: "a".to_owned(),
            text: "two".to_owned(),
        },
    )
    .expect("edit");
    assert_eq!(
        authored.lock().expect("lock").len(),
        after_seed + 1,
        "one edit must author exactly one update"
    );

    // A refused edit authors nothing: there is no half-written document to
    // store and nothing to push.
    let refused = apply(
        &document,
        &BlockEdit::SetText {
            block_id: "no-such-block".to_owned(),
            text: "three".to_owned(),
        },
    );
    assert!(refused.is_err());
    assert_eq!(
        authored.lock().expect("lock").len(),
        after_seed + 1,
        "a refused edit must store and push nothing"
    );
}
