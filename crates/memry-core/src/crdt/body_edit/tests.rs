use std::sync::Arc;

use super::*;
use crate::crdt::DocumentRegistry;
use crate::crdt::canonical::canonical_fragment;
use crate::crdt::registry::UpdateSink;

fn empty_note() -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    DocumentRegistry::new("device-body-edit", sink)
        .get_or_open("abc123def456")
        .expect("open")
}

fn insert(document: &Document, kind: &str, after: Option<&str>, text: &str) {
    apply(
        document,
        &BlockEdit::InsertBlock {
            kind: kind.to_owned(),
            after_block_id: after.map(str::to_owned),
            text: text.to_owned(),
            new_block_id: "n1".to_owned(),
        },
    )
    .unwrap_or_else(|error| panic!("inserting {kind} was refused: {error}"));
}

fn note_with_a_paragraph() -> Arc<Document> {
    let document = empty_note();
    apply(
        &document,
        &BlockEdit::InsertParagraph {
            after_block_id: None,
            text: "Before.".to_owned(),
            new_block_id: "p1".to_owned(),
        },
    )
    .expect("paragraph");
    document
}

const PARAGRAPH: &str = "0 element blockGroup\n\
    1 element blockContainer id=\"p1\"\n\
    2 element paragraph backgroundColor=\"default\" textAlignment=\"left\" textColor=\"default\"\n\
    3 text \"Before.\"\n";

/// Each expected document is what desktop's `blocksToYXmlFragment` writes
/// for the same blocks, rendered through the vector class's canonical form.
#[test]
fn an_inserted_math_diagram_or_whiteboard_is_the_node_desktop_writes() {
    for (kind, text, node) in [
        ("mathBlock", "", "2 element mathBlock latex=\"\""),
        ("diagram", "", "2 element diagram"),
        (
            "diagram",
            "graph TD; A-->B",
            "2 element diagram\n3 text \"graph TD; A-->B\"",
        ),
        ("whiteboard", "", "2 element whiteboard canvasId=\"\""),
    ] {
        let document = note_with_a_paragraph();
        insert(&document, kind, Some("p1"), text);
        assert_eq!(
            canonical_fragment(&document).expect("canonical"),
            format!("{PARAGRAPH}1 element blockContainer id=\"n1\"\n{node}"),
            "{kind} {text:?}"
        );
    }
}

#[test]
fn a_math_block_inserted_into_an_empty_note_lands_inside_the_block_group() {
    let document = empty_note();
    insert(&document, "mathBlock", None, "");
    assert_eq!(
        canonical_fragment(&document).expect("canonical"),
        "0 element blockGroup\n\
         1 element blockContainer id=\"n1\"\n\
         2 element mathBlock latex=\"\""
    );
}

/// A diagram's content is plain, so a bold run carried across would build
/// a node y-prosemirror deletes. Only the text crosses.
#[test]
fn turning_a_formatted_paragraph_into_a_diagram_carries_plain_text_only() {
    let document = note_with_a_paragraph();
    apply(
        &document,
        &BlockEdit::SetMark {
            block_id: "p1".to_owned(),
            start: 0,
            end: 6,
            mark: "bold".to_owned(),
            value: None,
        },
    )
    .expect("bold");
    apply(
        &document,
        &BlockEdit::TurnInto {
            block_id: "p1".to_owned(),
            kind: "diagram".to_owned(),
        },
    )
    .expect("turn into diagram");
    assert_eq!(
        canonical_fragment(&document).expect("canonical"),
        "0 element blockGroup\n\
         1 element blockContainer id=\"p1\"\n\
         2 element diagram\n\
         3 text \"Before.\""
    );
}

/// Desktop's `/table` default, rendered from `blocksToDoc` with
/// `buildTableContent({ rows: 3, columns: 3 })`.
#[test]
fn inserted_and_turned_tables_are_the_empty_grid_desktop_writes() {
    const HEADER: &str = "4 element tableHeader backgroundColor=\"default\" colspan=1 rowspan=1 textAlignment=\"left\" textColor=\"default\"\n\
        5 element tableParagraph\n";
    const CELL: &str = "4 element tableCell backgroundColor=\"default\" colspan=1 rowspan=1 textAlignment=\"left\" textColor=\"default\"\n\
        5 element tableParagraph\n";
    let row = |cell: &str| format!("3 element tableRow\n{}", cell.repeat(3));
    let expected = format!(
        "{PARAGRAPH}1 element blockContainer id=\"n1\"\n2 element table textColor=\"default\"\n{}{}{}",
        row(HEADER),
        row(CELL),
        row(CELL)
    );

    let document = note_with_a_paragraph();
    insert(&document, "table", Some("p1"), "");
    assert_eq!(
        format!("{}\n", canonical_fragment(&document).expect("canonical")),
        expected
    );

    let turned = empty_note();
    insert(&turned, "paragraph", None, "");
    apply(
        &turned,
        &BlockEdit::TurnInto {
            block_id: "n1".to_owned(),
            kind: "table".to_owned(),
        },
    )
    .expect("turn into table");
    assert_eq!(
        format!("{}\n", canonical_fragment(&turned).expect("canonical")),
        expected.replacen(PARAGRAPH, "0 element blockGroup\n", 1)
    );
}

#[test]
fn inserted_tables_take_cell_text_at_row_and_column() {
    let document = empty_note();
    insert(&document, "table", None, "");
    apply(
        &document,
        &BlockEdit::SetCellText {
            table_id: "n1".to_owned(),
            row: 0,
            column: 0,
            text: "Name".to_owned(),
        },
    )
    .expect("cell 0,0");
    let canonical = canonical_fragment(&document).expect("canonical");
    assert!(
        canonical.contains("4 element tableHeader backgroundColor=\"default\" colspan=1 rowspan=1 textAlignment=\"left\" textColor=\"default\"\n5 element tableParagraph\n6 text \"Name\"\n"),
        "{canonical}"
    );
}
