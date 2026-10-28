//! The `markdown-convert/yxml.json` conformance file: y-prosemirror reading a
//! Yjs fragment into a ProseMirror document and writing one back.

#![cfg(feature = "markdown")]

mod support;

use std::sync::Arc;

use memry_core::crdt::DocumentRegistry;
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::markdown::pm::Schema;
use memry_core::markdown::yxml::{
    RETIRED_MARK_ATTRS, ReadFragment, YxmlError, read_fragment, write_fragment,
};
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
            // What BlockNote writes, this build reads whole: nothing lost reads as "lossy".
            Ok(read) if read.lost != 0 => {
                Err(format!("{} runs or attributes were lost", read.lost))
            }
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

/// `lost` counts every text run, mark and attribute the read drops inside the elements it
/// keeps, so "removed 0" can never hide content: the external feed replaces a body only
/// when the read lost nothing (12e-1). The oracle's lossy reads are exactly these.
#[test]
fn a_read_counts_every_run_and_attribute_it_drops() {
    const LOSSY: &[&str] = &[
        "yxml/read/extra-attribute-dropped",
        "yxml/read/unknown-mark-drops-text",
    ];
    let file = vector_file("markdown-convert/yxml");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        if case["op"] != "yxml-read" || case["expected"]["status"] == "error" {
            continue;
        }
        let id = str_field(case, "id");
        let input = &case["input"];
        let document = open(&hex_field(input, "updateHex"));
        let outcome = match read(&document, str_field(input, "fragment")) {
            Err(error) => Err(format!("Rust failed: {error}")),
            Ok(read) if LOSSY.contains(&id) == (read.lost > 0) => Ok(()),
            Ok(read) => Err(format!("lost {}", read.lost)),
        };
        failures.check(id, outcome);
    }
    failures.finish("yxml lost counts");
}

/// The schema of every shipped release (`blocknote-<version>.json`, its real `pmSchema`)
/// against this one. Each node attribute it declared is still declared. Each mark attribute
/// it declared is declared, or listed in `RETIRED_MARK_ATTRS`, and every listed one comes from
/// a release. A mark this schema does not have at all (the AI suggestion marks) is not
/// retired: its text stays lost, and a feed refuses to replace it.
#[test]
fn every_attribute_a_shipped_release_wrote_is_declared_or_retired() {
    let schema = Schema::memry();
    let release = vector_file("markdown-convert/blocknote-0.47.1");
    let mut seen_retired = Vec::new();
    for (name, attrs) in release["nodes"].as_object().expect("nodes") {
        let Some(id) = schema.node_type(name) else {
            panic!("the release had node {name}, which this schema cannot build");
        };
        let declared = schema.node_ty(id).spec.attrs;
        for attr in attrs.as_object().expect("attrs").keys() {
            assert!(
                declared.iter().any(|a| a.name == attr),
                "{name}.{attr} was written by a release and is not declared"
            );
        }
    }
    for (name, attrs) in release["marks"].as_object().expect("marks") {
        let Some(id) = schema.mark_type(name) else {
            assert!(
                !RETIRED_MARK_ATTRS.iter().any(|(mark, _)| mark == name),
                "{name} is not in this schema; its text is content, not a retired attribute"
            );
            continue;
        };
        let declared = schema.mark_ty(id).spec.attrs;
        for attr in attrs.as_object().expect("attrs").keys() {
            if declared.iter().any(|a| a.name == attr) {
                continue;
            }
            let retired = RETIRED_MARK_ATTRS
                .iter()
                .any(|(mark, list)| mark == name && list.contains(&attr.as_str()));
            assert!(
                retired,
                "{name}.{attr} was written by a release and is neither declared nor retired"
            );
            seen_retired.push(format!("{name}.{attr}"));
        }
    }
    for (mark, list) in RETIRED_MARK_ATTRS {
        for attr in *list {
            assert!(
                seen_retired.contains(&format!("{mark}.{attr}")),
                "{mark}.{attr} is listed as retired but no release wrote it"
            );
        }
    }
}
