//! `serialize-doc.json` (yDocToMarkdown over Yjs-authored and edited documents,
//! the source merge and file spelling, `repairEmptyBlockIds`) and
//! `replace-body.json` (`replaceDocBody`).

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::convert::api::{Converter, ReplaceOptions};
use memry_core::markdown::convert::apply::{ReplaceOutcome, fragment_snapshot};
use serde_json::{Value as Json, json};
use support::doc_case::{
    FRAGMENT, build_document, converter_for, files_of, fragment_text, open_document, roots_json,
    serialized, sorted,
};
use support::vector_compare::{Failures, bytes_equal, json_equal};
use support::vector_file;

fn same(want: &Json, got: &Json) -> Result<(), String> {
    json_equal(&sorted(want), &sorted(got))
}

fn check_serialized(want: &Json, got: &Json) -> Result<(), String> {
    for key in ["markdown", "outcome", "canonical"] {
        match (want[key].as_str(), got[key].as_str()) {
            (Some(w), Some(g)) => bytes_equal(w, g).map_err(|e| format!("{key}: {e}"))?,
            (None, None) => {}
            (w, g) => return Err(format!("{key}: expected {w:?}, got {g:?}")),
        }
    }
    let (w, g) = (&want["noteBody"], &got["noteBody"]);
    match (w.is_null(), g.is_null()) {
        (true, true) => {}
        (false, false) => {
            bytes_equal(
                w["markdown"].as_str().unwrap_or(""),
                g["markdown"].as_str().unwrap_or(""),
            )
            .map_err(|e| format!("note body: {e}"))?;
            same(&w["writing"], &g["writing"]).map_err(|e| format!("writing: {e}"))?;
            same(&w["outcome"], &g["outcome"]).map_err(|e| format!("note outcome: {e}"))?;
        }
        _ => return Err(format!("note body: expected {w}, got {g}")),
    }
    same(&want["unrepresentable"], &got["unrepresentable"])
        .map_err(|e| format!("unrepresentable: {e}"))
}

fn serialize_case(converter: &Converter, case: &Json) -> Result<(), String> {
    let input = &case["input"];
    let files = files_of(input);
    let built = build_document(converter, input, &files);
    let expected = &case["expected"];
    if input["updateHex"].is_string() && case["op"] == "doc-repair-ids" {
        let document = open_document();
        document
            .apply_durable_update(&hex::decode(input["updateHex"].as_str().unwrap_or("")).unwrap())
            .map_err(|e| e.to_string())?;
        let repaired = converter.repair_empty_block_ids(&document, FRAGMENT);
        let got = json!({"repaired": repaired, "fragment": fragment_text(&document)});
        return same(&expected["output"], &got);
    }
    match (expected["status"].as_str(), built) {
        (Some("error"), Err(_)) => Ok(()),
        (Some("error"), Ok(document)) => {
            // The oracle threw while serializing; the Rust must not answer either.
            let got = serialized(converter, &document, input, &files);
            if got["markdown"].is_null() {
                Ok(())
            } else {
                Err(format!(
                    "the oracle threw, the Rust answered {}",
                    got["markdown"]
                ))
            }
        }
        (_, Err(e)) => Err(e),
        (_, Ok(document)) => check_serialized(
            &expected["output"],
            &serialized(converter, &document, input, &files),
        ),
    }
}

#[test]
fn edited_documents_serialize_like_the_oracle() {
    let file = vector_file("markdown-convert/serialize-doc");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        let converter = converter_for(&case["input"]);
        failures.check(
            case["id"].as_str().expect("id"),
            serialize_case(&converter, case),
        );
    }
    println!("serialize-doc: {} cases", failures.checked());
    failures.finish("serialize-doc.json");
}

fn replace_case(case: &Json) -> Result<(), String> {
    let input = &case["input"];
    let converter = converter_for(input);
    let files = files_of(input);
    let base = json!({"markdown": input["baseMarkdown"]});
    let document = build_document(&converter, &base, &files)?;
    let before = document
        .read(|txn| fragment_snapshot(txn, FRAGMENT))
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let stale = "<stale/>".to_owned();
    let guard = match input["unlessChanged"].as_bool() {
        None => None,
        Some(true) => Some(before.clone()),
        Some(false) => Some(stale),
    };
    let writing = input
        .get("writing")
        .and_then(memry_core::markdown::shared::writing_tools::read_writing_frontmatter);
    let outcome = converter.replace_body(
        &document,
        input["markdown"].as_str().unwrap_or(""),
        ReplaceOptions {
            note_path: input["notePath"].as_str(),
            writing,
            unless_changed_from: guard.as_deref(),
            embeds: Some(&files),
        },
    );
    let name = match outcome {
        ReplaceOutcome::Replaced => "replaced",
        ReplaceOutcome::RefusedLargeFile => "refused",
        ReplaceOutcome::Changed => "changed",
        ReplaceOutcome::Failed => "failed",
    };
    let got = json!({
        "seeded": true, "outcome": name,
        "fragment": fragment_text(&document), "roots": roots_json(&document),
    });
    let want = &case["expected"]["output"];
    bytes_equal(want["outcome"].as_str().unwrap_or(""), name)?;
    bytes_equal(
        want["fragment"].as_str().unwrap_or(""),
        got["fragment"].as_str().unwrap_or(""),
    )
    .map_err(|e| format!("fragment: {e}"))?;
    same(&want["roots"], &got["roots"]).map_err(|e| format!("roots: {e}"))
}

#[test]
fn replacing_a_body_matches_the_oracle() {
    let file = vector_file("markdown-convert/replace-body");
    let mut failures = Failures::default();
    for case in file["cases"].as_array().expect("cases") {
        failures.check(case["id"].as_str().expect("id"), replace_case(case));
    }
    println!("replace-body: {} cases", failures.checked());
    failures.finish("replace-body.json");
}
