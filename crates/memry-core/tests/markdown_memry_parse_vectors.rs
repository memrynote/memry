//! `markdown-convert/memry-parse.json`: `prepareFragmentSeed` of the Electron
//! converter, markdown to blocks with every memry layer, as canonical JSON.
//!
//! Claiming a callout or a structured quote re-serializes the parsed body, so
//! every case runs through the real block serializer and every case is
//! compared: a case that is not compared fails the test.

#![cfg(feature = "markdown")]

mod support;

use std::collections::HashMap;

use memry_core::markdown::bn::node_to_block::canonical_blocks;
use memry_core::markdown::convert::EmbedResolver;
use memry_core::markdown::convert::seed::{SeedEnv, prepare_fragment_seed};
use memry_core::markdown::convert::serialize::BlockNoteSerializer;
use memry_core::markdown::schema::callout_types::{CalloutTypeDefinition, CalloutTypes};
use memry_core::markdown::shared::writing_tools::read_writing_frontmatter;
use serde_json::{Map, Value as Json, json};
use support::vector_compare::{Failures, json_equal};
use support::vector_file;

struct Files(HashMap<String, String>);

impl EmbedResolver for Files {
    fn resolve(&self, target: &str, _note_path: Option<&str>) -> Option<String> {
        self.0.get(target).cloned()
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Json {
    serde_json::to_value(value).expect("serialisable")
}

#[test]
fn memry_parse_vectors() {
    let vectors = vector_file("markdown-convert/memry-parse");
    let mut failures = Failures::default();
    let mut compared = 0;
    for case in vectors["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let input = &case["input"];
        let expected = &case["expected"];
        assert_eq!(expected["status"], "ok", "{id}: the oracle threw");
        let want = &expected["output"];
        assert!(want.get("deferred").is_none(), "{id}: a deferred marker");

        let defs: Vec<CalloutTypeDefinition> = input["calloutTypes"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|d| serde_json::from_value(d.clone()).expect("definition"))
                    .collect()
            })
            .unwrap_or_default();
        let types = CalloutTypes::new(defs);
        let files = Files(
            input["embedFiles"]
                .as_object()
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                        .collect()
                })
                .unwrap_or_default(),
        );
        let env = SeedEnv {
            callout_types: &types,
            embeds: &files,
            serializer: &BlockNoteSerializer,
            html_comments: true,
        };
        let writing = input.get("writing").and_then(read_writing_frontmatter);
        let result = prepare_fragment_seed(
            &env,
            input["markdown"].as_str().expect("markdown"),
            input["notePath"].as_str(),
            writing,
        );

        compared += 1;
        let outcome = match result {
            Err(e) => Err(format!("failed: {e}")),
            Ok(seed) => {
                let mut sentinels = Map::new();
                for (ch, marker) in &seed.writing_sentinels {
                    sentinels.insert(ch.to_string(), to_json(marker));
                }
                let actual = json!({
                    "blocks": canonical_blocks(&seed.blocks),
                    "criticMarks": to_json(&seed.marks),
                    "definitions": to_json(&seed.definitions),
                    "usages": to_json(&seed.usages),
                    "plainText": seed.plain_text,
                    "writingSentinels": sentinels,
                });
                json_equal(&want["seed"], &actual)
            }
        };
        failures.check(id, outcome);
    }
    let total = vectors["cases"].as_array().expect("cases").len();
    assert_eq!(compared, total, "every memry-parse case is compared");
    println!("memry-parse: {compared} of {total} compared");
    failures.finish("memry-parse.json");
}
