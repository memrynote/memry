//! The `portal-resolve` conformance class: a portal definition plus the source
//! note's flat blocks in, the blocks it shows out (chapter 12 §12.6.3).
//!
//! The vector's blocks are the subset the resolver reads (`id`, `kind`,
//! `depth`, `inline[].text`); they are lifted into the core's own `Block`, and
//! the ids that come back are compared with `expectedIds`.

mod support;

use std::collections::HashMap;

use memry_core::crdt::blocks::{Block, InlineRun};
use memry_core::portal::{PortalStatus, resolve_portal};
use serde_json::Value as Json;
use support::{str_field, vector_file};

fn block(raw: &Json) -> Block {
    Block {
        id: Some(str_field(raw, "id").to_string()),
        kind: str_field(raw, "kind").to_string(),
        depth: raw["depth"].as_u64().expect("depth") as u32,
        props: Vec::new(),
        inline: raw["inline"]
            .as_array()
            .expect("inline")
            .iter()
            .map(|run| InlineRun {
                text: str_field(run, "text").to_string(),
                marks: Vec::new(),
                mark_attrs: HashMap::new(),
                target: None,
            })
            .collect(),
    }
}

#[test]
fn portal_resolve_vectors() {
    let file = vector_file("portal-resolve");
    let cases = file["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = str_field(case, "name");
        let blocks: Vec<Block> = case["blocks"]
            .as_array()
            .expect("blocks")
            .iter()
            .map(block)
            .collect();
        let slice = resolve_portal(str_field(case, "definition"), blocks);

        let expected = match str_field(case, "expectedStatus") {
            "ok" => PortalStatus::Ok,
            "missing-block" => PortalStatus::MissingBlock,
            other => panic!("{name}: unknown expectedStatus {other}"),
        };
        assert_eq!(slice.status, expected, "{name}: status");
        let ids: Vec<&str> = slice
            .blocks
            .iter()
            .map(|b| b.id.as_deref().expect("id"))
            .collect();
        let want: Vec<&str> = case["expectedIds"]
            .as_array()
            .expect("expectedIds")
            .iter()
            .map(|id| id.as_str().expect("id"))
            .collect();
        assert_eq!(ids, want, "{name}: ids");
    }
}

#[test]
fn an_unreadable_definition_is_invalid_not_missing() {
    let slice = resolve_portal("{ nope", Vec::new());
    assert_eq!(slice.status, PortalStatus::Invalid);
    assert!(slice.blocks.is_empty());
}
