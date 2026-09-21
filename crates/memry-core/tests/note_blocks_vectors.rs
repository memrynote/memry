//! The `note-blocks` conformance class, read direction (N105).
//!
//! Document bytes in, the block list a shell renders out, plus the canonical
//! fragment rendering both ports must agree on.
//!
//! ## Why this file exists beside `crdt_blocks.rs`
//!
//! `crdt_blocks.rs` asserts that this port's block walk and its text walk
//! agree **with each other**. Two readings of one document agree whether or
//! not either is right, which is exactly how dropping `divider` and losing
//! every inline colour value both passed. SC-010's digest does not help
//! either: chapter 12 §12.11 defines it over `title + "\n" + extract_text`,
//! so a shell can lose every colour, every link target and every table
//! boundary and still match.
//!
//! This file compares against bytes **the TypeScript port produced**, from a
//! corpus authored through BlockNote itself. Nothing here recomputes an
//! expectation; the committed JSON is the only input (README rule 2).

mod support;

use std::sync::Arc;

use memry_core::crdt::blocks::{Block, extract_blocks};
use memry_core::crdt::canonical::canonical_fragment;
use memry_core::crdt::registry::{Document, UpdateSink};
use memry_core::crdt::DocumentRegistry;
use serde_json::Value as Json;
use support::{hex_field, str_field, vector_file};

/// One case's document, through the registry — the only door §12.5.1 allows.
fn opened(case_name: &str, update: &[u8]) -> Arc<Document> {
    let sink: UpdateSink = Arc::new(|_, _| {});
    let registry = DocumentRegistry::new("device-note-blocks", sink);
    let document = registry
        .get_or_open("abc123def456")
        .unwrap_or_else(|error| panic!("{case_name}: open: {error}"));
    document
        .apply_durable_update(update)
        .unwrap_or_else(|error| panic!("{case_name}: apply: {error}"));
    document
}

/// This port's blocks as the JSON shape the class records.
///
/// Rendered rather than deserialised into `Block`, because the file is the
/// contract and a `serde` derive would let a field rename pass by renaming
/// both sides at once.
fn blocks_to_json(blocks: &[Block]) -> Json {
    Json::Array(
        blocks
            .iter()
            .map(|block| {
                let props: Vec<Json> = block
                    .props
                    .iter()
                    .map(|prop| {
                        serde_json::json!({ "name": prop.name, "value": prop.value })
                    })
                    .collect();
                let inline: Vec<Json> = block
                    .inline
                    .iter()
                    .map(|run| {
                        let mut attrs: Vec<(&String, &String)> = run.mark_attrs.iter().collect();
                        attrs.sort_by(|left, right| left.0.cmp(right.0));
                        let attrs: serde_json::Map<String, Json> = attrs
                            .into_iter()
                            .map(|(key, value)| (key.clone(), Json::String(value.clone())))
                            .collect();
                        serde_json::json!({
                            "text": run.text,
                            "marks": run.marks,
                            "markAttrs": Json::Object(attrs),
                            "target": run.target,
                        })
                    })
                    .collect();
                serde_json::json!({
                    "id": block.id,
                    "kind": block.kind,
                    "depth": block.depth,
                    "props": props,
                    "inline": inline,
                })
            })
            .collect(),
    )
}

/// The committed `markAttrs` object, with its keys sorted the way this port
/// sorts them, so the comparison is about content rather than about a JSON
/// writer's ordering.
fn normalised(expected: &Json) -> Json {
    match expected {
        Json::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Json::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), normalised(&map[key])))
                    .collect(),
            )
        }
        Json::Array(values) => Json::Array(values.iter().map(normalised).collect()),
        other => other.clone(),
    }
}

#[test]
fn the_block_walk_matches_the_committed_vectors() {
    let file = vector_file("note-blocks");
    let cases = file["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty(), "the class must not be empty");
    assert_eq!(
        cases.len() as u64,
        file["meta"]["caseCount"].as_u64().expect("caseCount"),
        "the file disagrees with its own recorded case count"
    );

    for case in cases {
        let name = str_field(case, "name");
        let document = opened(name, &hex_field(case, "updateHex"));
        let blocks =
            extract_blocks(&document).unwrap_or_else(|error| panic!("{name}: blocks: {error}"));

        assert_eq!(
            normalised(&blocks_to_json(&blocks)),
            normalised(&case["expectedBlocks"]),
            "{name}: {}",
            str_field(case, "pins")
        );
    }
}

/// The canonical form is what the write class compares documents through, so
/// it is pinned here against a document this port can also read as blocks.
#[test]
fn the_canonical_fragment_matches_the_other_port() {
    let file = vector_file("note-blocks");
    for case in file["cases"].as_array().expect("cases") {
        let name = str_field(case, "name");
        let document = opened(name, &hex_field(case, "updateHex"));
        let rendered = canonical_fragment(&document)
            .unwrap_or_else(|error| panic!("{name}: canonical: {error}"));

        assert_eq!(
            rendered,
            str_field(case, "expectedCanonical"),
            "{name}: the two ports render this document differently"
        );
    }
}

/// The negative control. Every assertion above passes trivially against a walk
/// that returns nothing for a class of empty documents, so at least one case
/// has to carry real structure.
#[test]
fn the_class_exercises_real_structure() {
    let file = vector_file("note-blocks");
    let mut kinds: Vec<String> = Vec::new();
    let mut marks: Vec<String> = Vec::new();
    for case in file["cases"].as_array().expect("cases") {
        let document = opened(str_field(case, "name"), &hex_field(case, "updateHex"));
        let blocks = extract_blocks(&document).expect("blocks");
        for block in &blocks {
            kinds.push(block.kind.clone());
            for run in &block.inline {
                marks.extend(run.marks.iter().cloned());
            }
        }
    }
    kinds.sort();
    kinds.dedup();
    marks.sort();
    marks.dedup();

    // The two defects this class was built to catch, asserted directly so a
    // regression names itself rather than arriving as a diff.
    assert!(
        kinds.iter().any(|kind| kind == "divider"),
        "no case produced a divider; the walk is dropping it again"
    );
    assert!(
        kinds.iter().any(|kind| kind == "table") && kinds.iter().any(|kind| kind == "tableRow"),
        "a table must reach the shell with its rows: {kinds:?}"
    );
    assert!(
        marks.iter().any(|mark| mark == "textColor"),
        "no case produced a colour mark: {marks:?}"
    );
    assert!(
        kinds.len() > 10,
        "the class covers too little to measure parity: {kinds:?}"
    );
}

/// A colour mark's **value** reaches the shell, which is the whole point of
/// the attribute map. The name alone cannot tell red from blue.
#[test]
fn a_colour_mark_carries_its_value() {
    let file = vector_file("note-blocks");
    let case = file["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| str_field(case, "name") == "styles: textColor and backgroundColor")
        .expect("the colour case");

    let document = opened("colours", &hex_field(case, "updateHex"));
    let blocks = extract_blocks(&document).expect("blocks");
    let run = blocks
        .iter()
        .flat_map(|block| block.inline.iter())
        .find(|run| run.marks.iter().any(|mark| mark == "textColor"))
        .expect("a coloured run");

    assert_eq!(run.mark_attrs.get("textColor").map(String::as_str), Some("red"));
    assert_eq!(
        run.mark_attrs.get("backgroundColor").map(String::as_str),
        Some("yellow")
    );
}
