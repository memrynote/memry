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
