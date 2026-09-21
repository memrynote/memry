//! The `block-edit` conformance class, write direction (N107).
//!
//! A base document, one operation, and the document the operation must leave
//! behind.
//!
//! ## What is compared, and what is deliberately not
//!
//! **Not the update bytes.** An update encodes `clientID` and per-client
//! clocks, and struct ordering, origin ids and run-length packing are free
//! choices an implementation may make differently while still converging. Two
//! different updates that converge are *both correct*, so a byte comparison
//! would fail on correct ports and catch nothing extra.
//! `specs/003-ios-note-parity/research.md` records the argument in full.
//!
//! So this applies the operation and renders the result through the canonical
//! fragment form, against a string the TypeScript port produced from a
//! document **BlockNote authored**. That makes the assertion "the writer
//! produces the document BlockNote would have produced", which is what chapter
//! 12 §12.5.0 actually demands: y-prosemirror answers a node its schema cannot
//! construct by DELETING the element, silently — the update applies, the
//! document encodes, `extract_text` may still return the text, and the next
//! desktop to open the note renders it without the block.
//!
//! ## Pending cases run inverted
//!
//! A case carrying `pending` fails against the writer as it stands today. It
//! is asserted to **fail**, so the moment the writer is fixed the expectation
//! turns red and forces the flag's removal. Remove the flag, never the case —
//! the convention `ROUNDTRIP_CASES` already uses on the TypeScript side.

mod support;

use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::body_edit::{BlockEdit, apply};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use serde_json::Value as Json;
use support::{hex_field, str_field, vector_file};

fn opened(case_name: &str, update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-block-edit", sink);
    let document = registry
        .get_or_open("abc123def456")
        .unwrap_or_else(|error| panic!("{case_name}: open: {error}"));
    document
        .apply_durable_update(update)
        .unwrap_or_else(|error| panic!("{case_name}: apply: {error}"));
    document
}

/// The committed operation descriptor as the core's own enum.
///
/// A `match` on the recorded `kind` rather than a `serde` derive on
/// `BlockEdit`: the file is the contract, and a derive would let a rename pass
/// by renaming both sides at once.
fn operation(case_name: &str, op: &Json) -> BlockEdit {
    let kind = op["kind"].as_str().unwrap_or_else(|| {
        panic!("{case_name}: the operation has no kind: {op}");
    });
    let text = |field: &str| op[field].as_str().unwrap_or_default().to_owned();
    match kind {
        "setText" => BlockEdit::SetText {
            block_id: text("blockId"),
            text: text("text"),
        },
        "setProp" => BlockEdit::SetProp {
            block_id: text("blockId"),
            name: text("name"),
            value: text("value"),
        },
        "insertParagraph" => BlockEdit::InsertParagraph {
            after_block_id: op["afterBlockId"].as_str().map(str::to_owned),
            text: text("text"),
            new_block_id: text("newBlockId"),
        },
        "delete" => BlockEdit::Delete {
            block_id: text("blockId"),
        },
        other => panic!("{case_name}: unknown operation kind {other}"),
    }
}

/// Applies one case and returns the resulting canonical document.
fn applied(case: &Json) -> (String, String) {
    let name = str_field(case, "name");
    let document = opened(name, &hex_field(case, "baseUpdateHex"));

    // The base has to be what the file says it is before the operation runs,
    // or a mismatch afterwards says nothing about the writer.
    assert_eq!(
        canonical_fragment(&document).expect("base canonical"),
        str_field(case, "baseCanonical"),
        "{name}: the base document does not render as the file records it"
    );

    apply(&document, &operation(name, &case["op"]))
        .unwrap_or_else(|error| panic!("{name}: the operation was refused: {error}"));

    (
        canonical_fragment(&document).expect("result canonical"),
        str_field(case, "expectedCanonical").to_owned(),
    )
}

#[test]
fn every_operation_produces_the_document_the_class_records() {
    let file = vector_file("block-edit");
    let cases = file["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty(), "the class must not be empty");
    assert_eq!(
        cases.len() as u64,
        file["meta"]["caseCount"].as_u64().expect("caseCount"),
        "the file disagrees with its own recorded case count"
    );

    let mut checked = 0;
    for case in cases {
        if case.get("pending").is_some() {
            continue;
        }
        let name = str_field(case, "name");
        let (actual, expected) = applied(case);
        assert_eq!(
            actual, expected,
            "{name}: {}\n  got\n{actual}\n  want\n{expected}",
            str_field(case, "pins")
        );
        checked += 1;
    }
    // The live half of the class. Four cases are `pending` against the writer
    // as it stands (two on the declared-default props and the second
    // top-level child, two on prop types), and the inverted test below holds
    // those. This floor is what stops the class from quietly becoming all
    // pending and measuring nothing.
    assert!(
        checked >= 6,
        "only {checked} cases ran; a class that skips itself measures nothing"
    );
}

/// The inverted half. A pending case must still fail, or its flag is stale.
#[test]
fn every_pending_case_still_fails() {
    let file = vector_file("block-edit");
    let pending: Vec<&Json> = file["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .filter(|case| case.get("pending").is_some())
        .collect();
    assert!(
        !pending.is_empty(),
        "no pending cases left — delete this test with the last flag"
    );

    for case in pending {
        let name = str_field(case, "name");
        let (actual, expected) = applied(case);
        assert_ne!(
            actual,
            expected,
            "{name} now passes. Delete its `pending` flag in \
             packages/editor-schema/src/conformance.ts and regenerate the class; \
             the flag is the stale thing, never the case.\n  reason was: {}",
            case["pending"]["reason"].as_str().unwrap_or_default()
        );
    }
}

/// §12.5.0's central rule, asserted directly rather than only through a
/// canonical diff: a writer must never leave a `blockContainer` as a direct
/// child of the fragment beside the existing `blockGroup`.
///
/// This is the one mistake whose damage is invisible at every layer a naive
/// client can see, which is why it gets its own assertion naming it.
#[test]
fn the_append_path_does_not_add_a_second_top_level_child() {
    let file = vector_file("block-edit");
    let case = file["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| str_field(case, "name") == "insertParagraph at the end of the body")
        .expect("the append case");

    let (actual, _) = applied(case);
    let top_level: Vec<&str> = actual
        .lines()
        .filter(|line| line.starts_with("0 "))
        .collect();

    // Recorded as the defect it currently is. When N400 fixes the writer this
    // becomes `assert_eq!(top_level, ["0 element blockGroup"])` and the
    // pending flags come off.
    assert!(
        top_level.len() > 1,
        "the append path is fixed — tighten this test to assert a single \
         top-level blockGroup and drop the pending flags. Top level: {top_level:?}"
    );
}
