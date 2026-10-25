//! The `markdown-convert/yxml.json` conformance file: y-prosemirror reading a
//! Yjs fragment into a ProseMirror document and writing one back.

#![cfg(feature = "markdown")]

mod support;

use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::markdown::pm::Schema;
use memry_core::markdown::yxml::{ReadFragment, YxmlError, read_fragment, write_fragment};
use serde_json::json;
use support::vector_compare::{Failures, bytes_equal};
use support::{hex_field, str_field, vector_file};

fn open(update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-yxml", sink);
    let document = registry.get_or_open("abc123def456").expect("open");
    document.apply_durable_update(update).expect("apply");
    document
}

fn read(document: &Document, fragment: &str) -> Result<ReadFragment, YxmlError> {
    document
        .read(|txn| {
            let fragment =
                yrs::ReadTxn::get_xml_fragment(txn, fragment).ok_or(YxmlError::Unconvertible)?;
            read_fragment(Schema::memry(), txn, &fragment)
        })
        .expect("read transaction")
}

/// Writes `doc` into a fresh document's `prosemirror` fragment and returns its
/// canonical form.
fn written_canonical(doc: &memry_core::markdown::pm::Node) -> String {
    let target = open(&[0, 0]);
    target
        .write(|txn| {
            let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, "prosemirror");
            write_fragment(Schema::memry(), txn, &fragment, doc)
        })
        .expect("write transaction")
        .expect("write");
    canonical_fragment(&target).expect("canonical")
}

#[test]
fn reading_a_fragment_matches_y_prosemirror() {
    let schema = Schema::memry();
    let file = vector_file("markdown-convert/yxml");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        if case["op"] != "yxml-read" {
            continue;
        }
        let id = str_field(case, "id");
        let input = &case["input"];
        let document = open(&hex_field(input, "updateHex"));
        let got = read(&document, str_field(input, "fragment"));
        let outcome = match (case["expected"]["status"].as_str(), got) {
            (Some("error"), Err(_)) => Ok(()),
            (Some("error"), Ok(_)) => Err("oracle threw, Rust read the fragment".to_owned()),
            (_, Err(error)) => Err(format!("Rust failed: {error}")),
            (_, Ok(read)) => {
                let expected = &case["expected"]["output"];
                let actual = json!({"doc": read.doc.to_json(schema), "removed": read.removed});
                if &actual == expected {
                    Ok(())
                } else {
                    Err(format!("expected {expected}\n  actual   {actual}"))
                }
            }
        };
        failures.check(id, outcome);
    }
    println!("yxml read cases: {}", failures.checked());
    failures.finish("yxml read");
}

#[test]
fn writing_the_read_document_matches_y_prosemirror() {
    let file = vector_file("markdown-convert/yxml");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        if case["op"] != "yxml-roundtrip" {
            continue;
        }
        let id = str_field(case, "id");
        let input = &case["input"];
        let document = open(&hex_field(input, "updateHex"));
        let outcome = match (
            case["expected"]["status"].as_str(),
            read(&document, str_field(input, "fragment")),
        ) {
            (Some("error"), Err(_)) => Ok(()),
            (Some("error"), Ok(_)) => Err("oracle threw, Rust read the fragment".to_owned()),
            (_, Err(error)) => Err(format!("Rust failed: {error}")),
            (_, Ok(read)) => bytes_equal(
                str_field(&case["expected"]["output"], "fragment"),
                &written_canonical(&read.doc),
            ),
        };
        failures.check(id, outcome);
    }
    println!("yxml roundtrip cases: {}", failures.checked());
    failures.finish("yxml roundtrip");
}

/// The 35 documents BlockNote itself authored read without repair and write
/// back to the canonical text the `note-blocks` class pins.
#[test]
fn note_blocks_documents_survive_a_round_trip_unchanged() {
    let file = vector_file("note-blocks");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        let id = str_field(case, "name");
        let document = open(&hex_field(case, "updateHex"));
        let outcome = match read(&document, "prosemirror") {
            Err(error) => Err(format!("read failed: {error}")),
            Ok(read) if read.removed != 0 => Err(format!("{} elements were removed", read.removed)),
            Ok(read) => bytes_equal(
                str_field(case, "expectedCanonical"),
                &written_canonical(&read.doc),
            ),
        };
        failures.check(id, outcome);
    }
    println!("note-blocks round trips: {}", failures.checked());
    failures.finish("note-blocks round trip");
}

#[test]
fn writing_into_a_non_empty_fragment_is_refused() {
    let target = open(&[0, 0]);
    let doc = Schema::memry();
    let node = doc
        .create(
            doc.top_node_type(),
            &[],
            memry_core::markdown::pm::Fragment::default(),
            Vec::new(),
        )
        .expect("doc");
    let result = target
        .write(|txn| {
            let fragment = yrs::WriteTxn::get_or_insert_xml_fragment(txn, "prosemirror");
            yrs::XmlFragment::push_back(&fragment, txn, yrs::XmlTextPrelim::new("x"));
            write_fragment(doc, txn, &fragment, &node)
        })
        .expect("write transaction");
    assert_eq!(result, Err(YxmlError::NotEmpty));
}
