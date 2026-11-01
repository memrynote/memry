//! A note's header tags as an app edit changes them, against Electron's own results in
//! `fixtures/header-tags.json.gz` (captured by `scripts/electron-fixtures/capture-header-tags.mjs`):
//! a body's `#tags`, a delta on a list, and the header an `updateNote` writes for an explicit
//! delta, the agent API's whole `tags` list and a body change, with and without tags with fields.
//! The `tags` key they set is checked against the header tag edits of `frontmatter-edit.json`.

#![cfg(feature = "markdown")]

mod support;

use std::collections::HashSet;
use std::io::Read as _;

use flate2::read::GzDecoder;
use memry_core::domain::body_tags;
use memry_core::domain::header_tags::{
    self, Existing, HeaderTagChange, HeaderTagEdit, Update, compare,
};
use memry_core::domain::note_stats;
use memry_core::markdown::frontmatter::{YamlMap, YamlValue, deep_strict_equal};
use serde_json::Value as Json;
use support::vector_compare::Failures;
use support::yaml_json::decode;

fn fixture() -> Json {
    let mut text = String::new();
    GzDecoder::new(&include_bytes!("fixtures/header-tags.json.gz")[..])
        .read_to_string(&mut text)
        .expect("the fixture");
    serde_json::from_str(&text).expect("JSON")
}

fn strings(value: &Json) -> Vec<String> {
    serde_json::from_value(value.clone()).expect("a list of strings")
}

fn edit(value: &Json) -> HeaderTagEdit {
    serde_json::from_value(value.clone()).expect("an edit")
}

fn change(value: &Json) -> Option<HeaderTagChange> {
    (!value.is_null()).then(|| HeaderTagChange {
        added: strings(&value["added"]),
        removed: strings(&value["removed"]),
    })
}

fn equal<T: PartialEq + std::fmt::Debug>(expected: &T, actual: &T) -> Result<(), String> {
    if expected == actual {
        Ok(())
    } else {
        Err(format!("Electron {expected:?}, Rust {actual:?}"))
    }
}

#[test]
fn a_body_reads_the_tags_electron_reads() {
    let fixture = fixture();
    let bodies = fixture["bodies"].as_array().expect("bodies");
    let inline = fixture["inline"].as_array().expect("inline");
    assert_eq!(bodies.len(), inline.len());
    let mut failures = Failures::default();
    for (at, (body, tags)) in bodies.iter().zip(inline).enumerate() {
        let body = body.as_str().expect("body");
        failures.check(
            &format!("body {at}"),
            equal(&strings(tags), &body_tags::extract_markdown(body)),
        );
    }
    // Every reading rule is exercised: some bodies hold tags, some none.
    assert!(
        inline
            .iter()
            .filter(|tags| tags.as_array().unwrap().is_empty())
            .count()
            > 2
    );
    assert!(
        inline
            .iter()
            .filter(|tags| tags.as_array().unwrap().len() > 1)
            .count()
            > 10
    );
    failures.finish("header-tags.json.gz inline");
}

#[test]
fn a_delta_changes_a_list_as_electron_changes_it() {
    let fixture = fixture();
    let mut failures = Failures::default();
    for (at, case) in fixture["apply"]
        .as_array()
        .expect("apply")
        .iter()
        .enumerate()
    {
        let actual = header_tags::apply(&strings(&case["current"]), &edit(&case["edit"]));
        failures.check(
            &format!("apply {at}"),
            equal(&strings(&case["next"]), &actual),
        );
    }
    assert!(failures.checked() > 50);
    failures.finish("header-tags.json.gz apply");
}

#[test]
fn an_update_writes_the_header_tags_electron_writes() {
    let fixture = fixture();
    let index = |case: &Json, key: &str| case.get(key).and_then(Json::as_u64).map(|at| at as usize);
    let bodies: Vec<&str> = fixture["bodies"]
        .as_array()
        .expect("bodies")
        .iter()
        .map(|body| body.as_str().expect("body"))
        .collect();
    let headers: Vec<Vec<String>> = fixture["headers"]
        .as_array()
        .expect("headers")
        .iter()
        .map(strings)
        .collect();
    let with_fields: Vec<HashSet<String>> = fixture["withFields"]
        .as_array()
        .expect("with fields")
        .iter()
        .map(|keys| strings(keys).into_iter().collect())
        .collect();
    let edits: Vec<HeaderTagEdit> = fixture["edits"]
        .as_array()
        .expect("edits")
        .iter()
        .map(edit)
        .collect();
    let lists: Vec<Vec<String>> = fixture["lists"]
        .as_array()
        .expect("lists")
        .iter()
        .map(strings)
        .collect();

    let cases = fixture["updates"].as_array().expect("updates");
    let mut failures = Failures::default();
    for (at, case) in cases.iter().enumerate() {
        let header = &headers[index(case, "header").expect("header")];
        let existing = Existing {
            header_tags: header,
            content: bodies[index(case, "body").expect("body")],
        };
        let update = Update {
            header_tags: index(case, "edit").map(|at| &edits[at]),
            tags: index(case, "list").map(|at| lists[at].as_slice()),
            content: index(case, "content").map(|at| bodies[at]),
            ignore_inline_tags: case.get("ignoreInlineTags") == Some(&Json::Bool(true)),
        };
        let fields = &with_fields[index(case, "withFields").expect("with fields")];
        let next = header_tags::next(&existing, &update, fields);
        let outcome = equal(&strings(&case["next"]), &next)
            .and_then(|()| equal(&change(&case["change"]), &compare(header, &next)));
        failures.check(&format!("update {at}"), outcome);
    }
    // Both outcomes, and the body's tags changing the header, are in the fixture.
    let changed = cases
        .iter()
        .filter(|case| !case["change"].is_null())
        .count();
    assert!(
        changed > 1000 && cases.len() - changed > 1000,
        "{changed} of {}",
        cases.len()
    );
    failures.finish("header-tags.json.gz updates");
}

fn map(value: &Json) -> YamlMap {
    match decode(value) {
        YamlValue::Map(map) => (*map).clone(),
        other => panic!("not a map: {other:?}"),
    }
}

#[test]
fn a_header_tag_edit_sets_the_tags_key_electron_sets() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/frontmatter-edit.json"
    );
    let fixture: Json =
        serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("JSON");
    let mut failures = Failures::default();
    for case in fixture["cases"].as_array().expect("cases") {
        let op = map(&case["op"]);
        if op.get("kind") != Some(&YamlValue::String("tags".into())) {
            continue;
        }
        let Some(YamlValue::Seq(wanted)) = op.get("headerTags") else {
            panic!("a tag edit names its list");
        };
        let tags: Vec<String> = wanted
            .iter()
            .map(|tag| match tag {
                YamlValue::String(tag) => tag.clone(),
                other => panic!("not a tag: {other:?}"),
            })
            .collect();
        let mut next = map(&case["reading"]);
        let before = note_stats::header_tags(&next);
        header_tags::set_tags(&mut next, &tags, compare(&before, &tags).as_ref());
        // Only the `tags` key: the rest of `next` is the property normalization's.
        let (expected, actual) = (map(&case["next"]), next.get("tags").cloned());
        let outcome = match (expected.get("tags"), &actual) {
            (None, None) => Ok(()),
            (Some(want), Some(got)) if deep_strict_equal(want, got) => Ok(()),
            (want, got) => Err(format!("Electron {want:?}, Rust {got:?}")),
        };
        failures.check(case["id"].as_str().expect("id"), outcome);
    }
    assert!(failures.checked() > 30, "{} tag edits", failures.checked());
    failures.finish("frontmatter-edit.json tag edits");
}

#[test]
fn an_unchanged_list_leaves_the_tags_key_as_the_file_spells_it() {
    for raw in [
        YamlValue::String("solo".into()),
        YamlValue::seq(vec![
            YamlValue::String(" a ".into()),
            YamlValue::String("A".into()),
        ]),
    ] {
        let mut frontmatter = YamlMap::new();
        frontmatter.insert("tags".into(), raw.clone());
        let tags = note_stats::header_tags(&frontmatter);
        header_tags::set_tags(&mut frontmatter, &tags, compare(&tags, &tags).as_ref());
        assert_eq!(frontmatter.get("tags"), Some(&raw));
    }
}
