//! The `markdown-convert/frontmatter.json` conformance file: the Rust frontmatter
//! split, note read and write rules and the js-yaml 3.15.1 loader and dumper,
//! byte for byte against the Electron code that generated it.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::frontmatter::{
    Eol, ParsedMarkdownNote, YamlValue, parse_markdown_note, safe_load,
    serialize_parsed_markdown_note, split_frontmatter_block, stringify_frontmatter_block,
    write_markdown_note,
};
use serde_json::{Map, Value as Json};
use support::vector_compare::{Failures, bytes_equal, json_equal};
use support::vector_file;
use support::yaml_json::{decode, decode_map, encode};

fn eol_of(input: &Json) -> Eol {
    if input["eol"].as_str() == Some("\r\n") {
        Eol::CrLf
    } else {
        Eol::Lf
    }
}

fn string(input: &Json, key: &str) -> String {
    input[key]
        .as_str()
        .unwrap_or_else(|| panic!("input.{key} is not a string"))
        .to_owned()
}

fn map_of(input: &Json) -> memry_core::markdown::frontmatter::YamlMap {
    match &input["value"] {
        Json::Object(map) if map.len() == 1 && map.contains_key("$map") => {
            decode_map(map["$map"].as_object().expect("$map body"))
        }
        Json::Object(map) => decode_map(map),
        other => panic!("dump input is not a map: {other}"),
    }
}

/// `Ok(output)` is the oracle's `{status: "ok"}` payload as the Rust side would
/// have produced it; `Err(())` means the Rust call failed.
fn actual(op: &str, input: &Json) -> Result<Json, ()> {
    match op {
        "split" => {
            let raw = string(input, "raw");
            let split = split_frontmatter_block(&raw);
            assert_eq!(
                format!("{}{}", split.block.unwrap_or(""), split.body),
                raw,
                "block + body must be the input"
            );
            Ok(serde_json::json!({ "block": split.block, "body": split.body }))
        }
        "parse" => {
            let parsed = parse_markdown_note(&string(input, "raw")).map_err(|_| ())?;
            Ok(serde_json::json!({
                "frontmatter": encode(&parsed.frontmatter),
                "content": parsed.content,
                "rawFrontmatterBlock": parsed.raw_frontmatter_block,
                "eol": if parsed.eol == Eol::CrLf { "\r\n" } else { "\n" },
                "hadTrailingNewline": parsed.had_trailing_newline,
            }))
        }
        "serialize" => {
            let parsed: ParsedMarkdownNote =
                parse_markdown_note(&string(input, "raw")).map_err(|_| ())?;
            let content = input["content"]
                .as_str()
                .map_or_else(|| parsed.content.clone(), str::to_owned);
            let edited = input["frontmatterEdited"].as_bool() == Some(true);
            Ok(Json::String(serialize_parsed_markdown_note(
                &parsed, &content, edited,
            )))
        }
        "dump" => Ok(Json::String(stringify_frontmatter_block(
            &map_of(input),
            eol_of(input),
        ))),
        "write" => Ok(Json::String(write_markdown_note(
            &map_of(input),
            &string(input, "content"),
        ))),
        "load" => match safe_load(&string(input, "text")) {
            Ok(Some(value)) => Ok(encode(&value)),
            Ok(None) => Ok(encode(&YamlValue::Null)),
            Err(_) => Err(()),
        },
        other => panic!("unknown op {other}"),
    }
}

fn compare(expected: &Json, got: Result<Json, ()>) -> Result<(), String> {
    match (expected["status"].as_str(), got) {
        (Some("ok"), Ok(value)) => match &expected["output"] {
            Json::String(text) => bytes_equal(text, value.as_str().ok_or("not a string")?),
            other => json_equal(other, &value),
        },
        (Some("error"), Err(())) => Ok(()),
        (Some("ok"), Err(())) => Err("the oracle succeeded and the Rust call failed".to_owned()),
        (Some("error"), Ok(value)) => Err(format!(
            "the oracle threw and the Rust call returned {value}"
        )),
        (other, _) => panic!("unknown expected status {other:?}"),
    }
}

#[test]
fn every_frontmatter_case_matches_the_oracle() {
    let file = vector_file("markdown-convert/frontmatter");
    let cases = file["cases"].as_array().expect("cases");
    assert_eq!(file["meta"]["caseCount"].as_u64(), Some(cases.len() as u64));
    let mut failures = Failures::default();
    let mut per_op: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for case in cases {
        let id = case["id"].as_str().expect("id");
        let op = case["op"].as_str().expect("op");
        *per_op.entry(op.to_owned()).or_default() += 1;
        let got =
            std::panic::catch_unwind(|| actual(op, &case["input"])).unwrap_or_else(|_| Err(()));
        let outcome = compare(&case["expected"], got);
        failures.check(id, outcome);
    }
    println!(
        "frontmatter vectors: {} cases {per_op:?}",
        failures.checked()
    );
    failures.finish("markdown-convert/frontmatter");
}

#[test]
fn the_json_spelling_round_trips() {
    let mut body = Map::new();
    body.insert("$weird".to_owned(), Json::from(1));
    let value = decode(&serde_json::json!({ "$map": body, "x": 1 }));
    assert!(matches!(value, YamlValue::Map(_)));
    support::yaml_json::dates_round_trip("2024-01-15T10:30:45.123Z").expect("date");
    support::yaml_json::dates_round_trip("+012345-01-01T00:00:00.000Z").expect("far date");
}
