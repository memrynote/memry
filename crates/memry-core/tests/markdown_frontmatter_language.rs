//! gray-matter 4.0.3's language line: `---<language>` names the engine that parses the block
//! (`matter.language` and `lib/engine.js`). A whole-file reader (an importer, a legacy
//! template, a `.folder.md`) meets it in files written by other tools.

#![cfg(feature = "markdown")]

use memry_core::markdown::frontmatter::{YamlMap, YamlValue, gray_matter_data, gray_matter_parts};
use memry_test_kit::{DEFAULT_CASES, on_small_stack, proptest_config};
use proptest::prelude::*;

fn one(key: &str, value: YamlValue) -> YamlValue {
    let mut map = YamlMap::new();
    map.insert(key.to_owned(), value);
    YamlValue::map(map)
}

#[test]
fn a_yaml_language_line_is_not_part_of_the_matter() {
    let text = "---yaml\na: 1\n---\nbody";
    assert_eq!(gray_matter_parts(text), Some(("\na: 1", "body")));
    assert_eq!(
        gray_matter_data(text).unwrap(),
        one("a", YamlValue::Number(1.0))
    );
}

#[test]
fn the_yaml_aliases_take_any_case_and_surrounding_space() {
    for open in ["---yml", "--- YAML ", "---Yml\r"] {
        let text = format!("{open}\r\na: 1\r\n---\r\nbody");
        assert_eq!(
            gray_matter_data(&text).unwrap(),
            one("a", YamlValue::Number(1.0)),
            "{open:?}"
        );
        assert_eq!(gray_matter_parts(&text).unwrap().1, "body", "{open:?}");
    }
}

#[test]
fn a_json_block_parses_as_json_parse_does() {
    let text = "---json\n{\"b\": [1, null], \"a\": \"x\", \"2\": true, \"1\": 0}\n---\nbody";
    let YamlValue::Map(map) = gray_matter_data(text).unwrap() else {
        panic!("not a map");
    };
    // JSON.parse puts integer keys first, ascending, then the rest in their order.
    let keys: Vec<String> = map.iter().map(|(key, _)| key.to_string()).collect();
    assert_eq!(keys, ["1", "2", "b", "a"]);
    assert_eq!(map.get("a"), Some(&YamlValue::String("x".into())));
    assert_eq!(gray_matter_parts(text).unwrap().1, "body");
    // `null` is gray-matter's empty data, and a JSON error is a parse error.
    assert_eq!(
        gray_matter_data("---json\nnull\n---\n").unwrap(),
        YamlValue::map(YamlMap::new())
    );
    assert!(gray_matter_data("---json\na: 1\n---\n").is_err());
    // Only the exact name: `aliase` returns `JSON` unchanged and no engine has it.
    assert!(gray_matter_data("---JSON\n{}\n---\n").is_err());
}

/// gray-matter's JavaScript engine `eval`s the block. Electron would run code from an imported
/// file; here the block is refused instead (a deliberate difference).
#[test]
fn a_javascript_block_is_refused_not_evaluated() {
    for open in ["---js", "---javascript", "---JS"] {
        let text = format!("{open}\n{{a: 1}}\n---\nbody");
        let error = gray_matter_data(&text).unwrap_err();
        assert!(error.message.contains("not evaluated"), "{open:?}: {error}");
        assert_eq!(gray_matter_parts(&text).unwrap().1, "body", "{open:?}");
    }
}

#[test]
fn an_unknown_language_is_not_registered_unless_the_block_is_blank() {
    let error = gray_matter_data("---toml\na = 1\n---\n").unwrap_err();
    assert!(
        error.message.contains("\"toml\" is not registered"),
        "{error}"
    );
    assert!(gray_matter_data("---coffee\na: 1\n---\n").is_err());
    // A long token is clipped in the message.
    let long = "x".repeat(100_000);
    let error = gray_matter_data(&format!("---{long}\na = 1\n---\n")).unwrap_err();
    assert!(error.message.len() < 200, "{} bytes", error.message.len());
    assert!(
        error
            .message
            .contains(&format!("\"{}…\" is not registered", "x".repeat(64)))
    );
    // A blank block is empty data before any engine is looked up.
    assert_eq!(
        gray_matter_data("---toml\n  # note\n---\nbody").unwrap(),
        YamlValue::map(YamlMap::new())
    );
}

/// `str.slice(0, str.search(/\r?\n/))`: with no line break the language is all but the last
/// UTF-16 unit, and the block runs to the end.
#[test]
fn without_a_line_break_the_language_drops_the_last_unit() {
    assert_eq!(gray_matter_parts("---yamlX"), Some(("X", "")));
    assert_eq!(
        gray_matter_data("---yamlX").unwrap(),
        YamlValue::String("X".into())
    );
    // A lone high surrogate names no engine.
    assert!(gray_matter_data("---yaml\u{1F600}").is_err());
    // One character after the delimiter leaves no language.
    assert_eq!(gray_matter_parts("---a"), Some(("a", "")));
}

/// A space-only language line is no language: the line stays in the matter.
#[test]
fn a_blank_language_line_keeps_its_bytes() {
    assert_eq!(
        gray_matter_parts("---  \na: 1\n---\n"),
        Some(("  \na: 1", ""))
    );
}

/// serde_json caps nesting at 128 levels, so a deep JSON block fails closed on a spawned
/// thread's stack instead of overflowing it.
#[test]
fn a_deep_json_block_fails_closed_on_a_small_stack() {
    let depth = 200_000;
    let text = format!("---json\n{}{}\n---\n", "[".repeat(depth), "]".repeat(depth));
    let outcome = on_small_stack(move || gray_matter_data(&text).map(|_| ()));
    assert!(outcome.is_err());
}

proptest! {
    #![proptest_config(proptest_config(DEFAULT_CASES))]

    /// A `yaml` language line changes nothing but where the matter starts.
    #[test]
    fn a_yaml_line_reads_as_no_line(matter in "[a-c: \\n#-]{0,40}", body in "[a-c\\n]{0,20}") {
        let plain = format!("---\n{matter}\n---\n{body}");
        let tagged = format!("---yaml\n{matter}\n---\n{body}");
        prop_assert_eq!(gray_matter_parts(&plain), gray_matter_parts(&tagged));
        prop_assert_eq!(
            gray_matter_data(&plain).map_err(|e| e.to_string()),
            gray_matter_data(&tagged).map_err(|e| e.to_string())
        );
    }
}
