//! The in-place frontmatter edit (`serialize_updated_note`) byte for byte against the Electron
//! property edits in `fixtures/frontmatter-edit.json` (captured by
//! `scripts/electron-fixtures/capture-frontmatter-edit.mjs`): every golden vault file and a few
//! handmade ones, each taking a property set, a property merge and a header tag edit as
//! Electron's `updateNote` writes them.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, deep_strict_equal, edit_frontmatter_block, equal_visits, gray_matter_data,
    parse_markdown_note, serialize_updated_note,
};
use memry_test_kit::{
    DEFAULT_CASES, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;
use serde_json::Value as Json;
use support::vector_compare::{Failures, bytes_equal};
use support::yaml_json::decode;

fn map(value: &Json) -> YamlMap {
    match decode(value) {
        YamlValue::Map(map) => (*map).clone(),
        other => panic!("not a map: {other:?}"),
    }
}

fn fixture() -> Json {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/frontmatter-edit.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).expect("JSON")
}

fn case_outcome(files: &Json, case: &Json) -> Result<(), String> {
    let raw = files[case["file"].as_str().expect("file")]
        .as_str()
        .expect("file text");
    let parsed = parse_markdown_note(raw).map_err(|error| error.to_string())?;
    let (reading, next) = (map(&case["reading"]), map(&case["next"]));
    let edited = case["edited"].as_bool().expect("edited");
    // Electron's `edited` for these edits is "the frontmatter changed".
    if edited
        == deep_strict_equal(
            &YamlValue::map(reading.clone()),
            &YamlValue::map(next.clone()),
        )
    {
        return Err(format!(
            "edited is {edited}, the frontmatter says otherwise"
        ));
    }
    if let (Some(block), Some(in_place)) =
        (&parsed.raw_frontmatter_block, case["inPlace"].as_bool())
    {
        let edit = edit_frontmatter_block(block, &reading, &next).map_err(|e| e.to_string())?;
        if edit.is_some() != in_place {
            return Err(format!(
                "in place: Electron {in_place}, Rust {}",
                edit.is_some()
            ));
        }
    }
    let content = parsed.content.clone();
    let output = serialize_updated_note(parsed, &reading, next, &content, edited)
        .map_err(|error| error.to_string())?;
    bytes_equal(case["output"].as_str().expect("output"), &output)
}

#[test]
fn every_electron_property_edit_writes_the_same_bytes() {
    let fixture = fixture();
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(
        cases.len() as u64,
        fixture["meta"]["caseCount"].as_u64().expect("count")
    );
    // The fixture covers both ways out of the in-place edit.
    let in_place = |want: bool| cases.iter().filter(|c| c["inPlace"] == want).count();
    assert!(in_place(true) > 200 && in_place(false) > 10);
    let mut failures = Failures::default();
    for case in cases {
        let id = case["id"].as_str().expect("id");
        failures.check(id, case_outcome(&fixture["files"], case));
    }
    assert_eq!(failures.checked(), cases.len());
    failures.finish("frontmatter-edit.json");
}

fn reading_of(block: &str) -> YamlMap {
    match gray_matter_data(block).expect("the block parses") {
        YamlValue::Map(map) => (*map).clone(),
        other => panic!("not a map: {other:?}"),
    }
}

/// A value built of aliases is a tree exponential in its text. Each pair of shared collections
/// is compared once, so a no-op edit of 20 levels visits a few values per level, not 2^20.
#[test]
fn an_alias_bomb_is_compared_once_per_shared_pair() {
    const LEVELS: usize = 20;
    let mut block = String::from("---\nbomb:\n  a0: &a0 [x, x]\n");
    for level in 1..LEVELS {
        block.push_str(&format!(
            "  a{level}: &a{level} [*a{p}, *a{p}]\n",
            p = level - 1
        ));
    }
    block.push_str("---\n");
    let reading = reading_of(&block);
    // Two comparisons (the entry against the block, the old value against the new) of three
    // values per level, plus the root and the scalars of the first level.
    assert_steps_at_most("alias bomb", equal_visits, 2 * (3 * LEVELS + 10), || {
        let edited = edit_frontmatter_block(&block, &reading, &reading).unwrap();
        assert_eq!(edited.as_deref(), Some(block.as_str()));
    });
}

/// A frontmatter one level inside the loader's depth limit edits on a spawned thread's stack, and a value
/// nested past what the dumper writes is refused as an error, not a stack overflow.
#[test]
fn deep_values_edit_or_fail_closed_on_a_small_stack() {
    on_small_stack(|| {
        let deep = format!("{}1{}", "[".repeat(98), "]".repeat(98));
        let block = format!("---\ndeep: {deep}\nstatus: x\n---\n");
        let reading = reading_of(&block);
        let mut next = reading.clone();
        next.insert("status".to_owned(), YamlValue::String("z".to_owned()));
        let edited = edit_frontmatter_block(&block, &reading, &next).unwrap();
        assert_eq!(edited, Some(block.replace("status: x", "status: z")));

        let nested = || {
            let mut nested = YamlValue::Null;
            for _ in 0..1000 {
                nested = YamlValue::seq(vec![nested]);
            }
            nested
        };
        assert!(!deep_strict_equal(&nested(), &nested()));
        next.insert("status".to_owned(), nested());
        assert!(edit_frontmatter_block(&block, &reading, &next).is_err());
    });
}

/// A reading equal to the next frontmatter is the block back unchanged, whatever its comments,
/// quoting and line ends; a changed value reads back as the new value with every other key's
/// lines kept.
fn scalar() -> impl Strategy<Value = (String, YamlValue)> {
    prop_oneof![
        "[a-z ]{0,8}".prop_map(|text| (format!("'{text}'"), YamlValue::String(text))),
        (0u16..1000).prop_map(|n| (n.to_string(), YamlValue::Number(f64::from(n)))),
        any::<bool>().prop_map(|b| (b.to_string(), YamlValue::Bool(b))),
    ]
}

proptest! {
    #![proptest_config(proptest_config(DEFAULT_CASES))]

    #[test]
    fn an_edit_changes_only_its_key(
        entries in prop::collection::vec(("k[a-z]{0,5}", scalar(), any::<bool>()), 1..8),
        crlf in any::<bool>(),
        changed in any::<prop::sample::Index>(),
        value in scalar(),
    ) {
        let eol = if crlf { "\r\n" } else { "\n" };
        let mut block = format!("---{eol}");
        let mut reading = YamlMap::new();
        for (key, (spelling, parsed), comment) in &entries {
            if reading.contains_key(key) {
                continue;
            }
            if *comment {
                block.push_str(&format!("# about {key}{eol}"));
            }
            block.push_str(&format!("{key}:  {spelling}{eol}"));
            reading.insert(key.clone(), parsed.clone());
        }
        block.push_str(&format!("---{eol}"));
        prop_assert_eq!(
            edit_frontmatter_block(&block, &reading, &reading).unwrap(),
            Some(block.clone())
        );

        let keys: Vec<String> = reading.iter().map(|(key, _)| key.to_owned()).collect();
        let key = &keys[changed.index(keys.len())];
        let mut next = reading.clone();
        next.insert(key.clone(), value.1.clone());
        let edited = edit_frontmatter_block(&block, &reading, &next).unwrap().expect("in place");
        prop_assert!(edited.len() <= output_bound(block.len()));
        let parsed = parse_markdown_note(&format!("{edited}body")).unwrap();
        prop_assert!(deep_strict_equal(&parsed.frontmatter, &YamlValue::map(next.clone())));
        let kept = |text: &str| -> Vec<String> {
            text.split(eol)
                .filter(|line| !line.starts_with(&format!("{key}:")))
                .map(str::to_owned)
                .collect()
        };
        prop_assert_eq!(kept(&edited), kept(&block));
    }
}
