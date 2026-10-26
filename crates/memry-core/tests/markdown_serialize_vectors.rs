//! `markdown-convert/serialize.json`: `serializeBlocks` of the Electron
//! converter, blocks to markdown byte for byte. `serialize-seed` cases serialize
//! the blocks the seed builds from markdown; `serialize-blocks` cases hand the
//! serializer blocks directly. A case the oracle threw on (`status: error`) is
//! one the converter answers `null` to, so the Rust must return an error too.

#![cfg(feature = "markdown")]

mod support;

use std::collections::HashMap;

use memry_core::markdown::convert::EmbedResolver;
use memry_core::markdown::convert::seed::{SeedEnv, prepare_fragment_seed};
use memry_core::markdown::convert::serialize::{BlockNoteSerializer, serialize_blocks};
use memry_core::markdown::schema::callout_types::{CalloutTypeDefinition, CalloutTypes};
use memry_core::markdown::shared::writing_tools::read_writing_frontmatter;
use serde_json::Value as Json;
use support::vector_compare::{Failures, bytes_equal};
use support::vector_file;

struct Files(HashMap<String, String>);

impl EmbedResolver for Files {
    fn resolve(&self, target: &str, _note_path: Option<&str>) -> Option<String> {
        self.0.get(target).cloned()
    }
}

fn serialize_seed(input: &Json) -> Result<Option<String>, String> {
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
    let seed = prepare_fragment_seed(
        &env,
        input["markdown"].as_str().expect("markdown"),
        input["notePath"].as_str(),
        writing,
    )
    .map_err(|e| format!("seed failed: {e}"))?;
    serialize_blocks(&seed.blocks)
        .map(Some)
        .map_err(|e| format!("serialize failed: {e}"))
}

#[test]
fn serialize_vectors() {
    let vectors = vector_file("markdown-convert/serialize");
    let mut failures = Failures::default();
    let mut errors = 0;
    for case in vectors["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let input = &case["input"];
        let expected = &case["expected"];
        let actual: Result<Option<String>, String> = match case["op"].as_str() {
            Some("serialize-seed") => serialize_seed(input),
            Some("serialize-blocks") => {
                let blocks = input["blocks"].as_array().expect("blocks");
                serialize_blocks(blocks)
                    .map(Some)
                    .map_err(|e| format!("serialize failed: {e}"))
            }
            other => panic!("{id}: unknown op {other:?}"),
        };
        let outcome = match (expected["status"].as_str(), actual) {
            (Some("ok"), Ok(got)) => match (&expected["output"]["markdown"], got) {
                (Json::String(want), Some(got)) => bytes_equal(want, &got),
                (Json::Null, None) => Ok(()),
                (want, got) => Err(format!("expected {want:?}, got {got:?}")),
            },
            (Some("ok"), Err(e)) => Err(e),
            (Some("error"), Err(_)) => {
                errors += 1;
                Ok(())
            }
            (Some("error"), Ok(_)) => Err("the oracle threw, the Rust did not".into()),
            (other, _) => Err(format!("unknown status {other:?}")),
        };
        failures.check(id, outcome);
    }
    println!(
        "serialize: {} cases, {errors} fail closed",
        failures.checked()
    );
    failures.finish("serialize.json");
}
