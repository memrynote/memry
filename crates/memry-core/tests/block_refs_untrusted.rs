//! The block reference derivation reads note bodies, vault data from any device, so it is held
//! to the untrusted-input guards: work linear in the body (the `[[` scan and the portal anchor
//! dedupe were quadratic), rows no larger than the text they came from, a nested portal fence
//! that fails closed on a 2 MiB stack, and no panic on any body.

#![cfg(feature = "markdown")]

use std::collections::HashMap;

use memry_core::crdt::blocks::{Block, BlockProp, InlineRun};
use memry_core::domain::search::block_refs::{self, BlockRefs};
use memry_core::domain::search::literal_link_steps;
use memry_core::portal::anchor_steps;
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

const N: usize = 50_000;

fn block(language: Option<&str>, runs: &[(&str, &[&str], Option<&str>)]) -> Block {
    Block {
        id: None,
        kind: if language.is_some() {
            "codeBlock"
        } else {
            "paragraph"
        }
        .to_owned(),
        depth: 0,
        props: language
            .map(|value| BlockProp {
                name: "language".to_owned(),
                value: value.to_owned(),
            })
            .into_iter()
            .collect(),
        inline: runs
            .iter()
            .map(|(text, marks, target)| InlineRun {
                text: (*text).to_owned(),
                marks: marks.iter().map(|mark| (*mark).to_owned()).collect(),
                mark_attrs: HashMap::new(),
                target: target.map(str::to_owned),
            })
            .collect(),
    }
}

fn steps() -> usize {
    block_refs::steps() + literal_link_steps() + anchor_steps()
}

fn input_len(blocks: &[Block]) -> usize {
    blocks
        .iter()
        .flat_map(|block| &block.inline)
        .map(|run| run.text.len() + run.target.as_ref().map_or(0, String::len))
        .sum()
}

fn output_len(refs: &BlockRefs) -> usize {
    let portals = refs.portals.iter().map(|fence| {
        fence.source.as_ref().map_or(0, String::len)
            + fence.anchors.iter().map(String::len).sum::<usize>()
    });
    let links = refs
        .links
        .iter()
        .map(|link| link.target.len() + link.anchor.len());
    portals.chain(links).sum()
}

#[test]
fn a_body_is_derived_in_steps_linear_in_its_size() {
    on_small_stack(|| {
        let opens = "[[".repeat(N);
        let unclosed = format!("{}x]", "[[x|".repeat(N));
        let anchors: Vec<String> = (0..N).map(|at| format!("\"a{at:05}\"")).collect();
        let distinct = format!(r#"{{"note":"n","blocks":[{}]}}"#, anchors.join(","));
        let same = format!(
            r#"{{"note":"n","blocks":[{}]}}"#,
            vec!["\"abcd\""; N].join(",")
        );
        let cases = [
            ("a run of [[", vec![block(None, &[(&opens, &[], None)])]),
            (
                "aliases that never close",
                vec![block(None, &[(&unclosed, &[], None)])],
            ),
            (
                "a portal of distinct roots",
                vec![block(Some("memry-portal"), &[(&distinct, &[], None)])],
            ),
            (
                "a portal of one root again",
                vec![block(Some("memry-portal"), &[(&same, &[], None)])],
            ),
        ];
        for (what, blocks) in cases {
            let bound = 4 * input_len(&blocks) + 64;
            assert_steps_at_most(what, steps, bound, || {
                block_refs::derive(&blocks);
            });
        }
    });
}

#[test]
fn a_dense_body_yields_rows_no_larger_than_its_text() {
    let links = "[[Target#^abcd]] ".repeat(N);
    let keys: Vec<String> = (0..N).map(|at| format!("[[T{at}#^a{at:05}]]")).collect();
    let anchors: Vec<String> = (0..N).map(|at| format!("\"a{at:05}\"")).collect();
    let portal = format!(r#"{{"note":"n","blocks":[{}]}}"#, anchors.join(","));
    let blocks = vec![
        block(None, &[(&links, &[], None)]),
        block(None, &[(&keys.join(" "), &[], None)]),
        block(Some("memry-portal"), &[(&portal, &[], None)]),
    ];
    let refs = block_refs::derive(&blocks);
    assert_eq!(
        (refs.links.len(), refs.portals[0].anchors.len()),
        (N + 1, N)
    );
    assert_output_bounded("dense references", input_len(&blocks), output_len(&refs));
}

#[test]
fn a_deeply_nested_portal_fence_fails_closed_on_a_small_stack() {
    let refs = on_small_stack(|| {
        let deep = format!(
            r#"{{"note":"n","x":{}{}}}"#,
            "[".repeat(200_000),
            "]".repeat(200_000)
        );
        let blocks = vec![
            block(Some("memry-portal"), &[(&deep, &[], None)]),
            block(Some("memry-portal"), &[(r#"{"note":"after"}"#, &[], None)]),
        ];
        block_refs::derive(&blocks)
    });
    let ordinals: Vec<u32> = refs.portals.iter().map(|fence| fence.ordinal).collect();
    assert_eq!(
        ordinals,
        [1],
        "the unreadable fence keeps its ordinal and has no row"
    );
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn any_body_derives_bounded_rows(
        text in r#"(\PC|[\[\]#^|{}":,/ a-z])*"#,
        json in r#"(\PC|[\[\]{}":,^ a-z])*"#,
        href in r#"(\PC|[%#^/:?a-z])*"#,
    ) {
        let blocks = vec![
            block(None, &[(&text, &[], None), ("x", &["link"], Some(&href)), ("y", &["wikiLink"], Some(&text))]),
            block(Some("memry-portal"), &[(&json, &[], None)]),
        ];
        let refs = block_refs::derive(&blocks);
        prop_assert!(output_len(&refs) <= output_bound(input_len(&blocks)));
    }
}
