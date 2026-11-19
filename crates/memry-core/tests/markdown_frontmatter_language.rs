//! gray-matter 4.0.3's language line: `---<language>` names the engine that parses the block
//! (`matter.language` and `lib/engine.js`). A whole-file reader (an importer, a legacy
//! template, a `.folder.md`) meets it in files written by other tools. Only YAML is read.

#![cfg(feature = "markdown")]

use memry_core::markdown::frontmatter::{
    YamlMap, YamlValue, gray_matter_data, gray_matter_parts, parse_markdown_note,
};
use memry_test_kit::{DEFAULT_CASES, proptest_config};

/// Opening lines that name a language other than YAML, as gray-matter reads them: the name is
/// trimmed, and `lib/engine.js` aliases it case-insensitively.
const NOT_YAML: [&str; 14] = [
    "---json",
    "---JSON",
    "---Json",
    "---json  ",
    "--- json",
    "---json\r",
    "---js",
    "---JS",
    "--- javascript",
    "---Javascript ",
    "---coffee",
    "---CoffeeScript",
    "---cson",
    "---toml",
];
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

/// Every language but YAML leaves the frontmatter unreadable, as Electron's patched
/// gray-matter does (#5154): a `json` block is never parsed and a `javascript` one never run.
/// The split still ends at the closing delimiter, so none of it becomes body text.
#[test]
fn every_language_but_yaml_is_refused() {
    for open in NOT_YAML {
        let text = format!("{open}\n{{\"a\": 1}}\n---\nbody");
        let error = gray_matter_data(&text).unwrap_err();
        assert!(
            error.message.contains("is not supported"),
            "{open:?}: {error}"
        );
        assert_eq!(gray_matter_parts(&text).unwrap().1, "body", "{open:?}");
    }
}

/// The note reader takes only a bare `---` line as an opener (`splitFrontmatterBlock`), so a
/// language line there, YAML's included, starts plain body text.
#[test]
fn the_note_reader_reads_a_language_line_as_body() {
    for open in NOT_YAML.iter().chain(&["---yaml"]) {
        let text = format!("{open}\na: 1\n---\nbody\n");
        let note = parse_markdown_note(&text).unwrap();
        assert_eq!(note.frontmatter, YamlValue::map(YamlMap::new()), "{open:?}");
        assert_eq!(note.raw_frontmatter_block, None, "{open:?}");
        assert_eq!(note.content, text, "{open:?}");
    }
}

#[test]
fn a_refused_language_is_named_unless_the_block_is_blank() {
    let error = gray_matter_data("---toml\na = 1\n---\n").unwrap_err();
    assert!(
        error.message.contains("\"toml\" is not supported"),
        "{error}"
    );
    // A long token is clipped in the message.
    let long = "x".repeat(100_000);
    let error = gray_matter_data(&format!("---{long}\na = 1\n---\n")).unwrap_err();
    assert!(error.message.len() < 200, "{} bytes", error.message.len());
    assert!(
        error
            .message
            .contains(&format!("\"{}…\" is not supported", "x".repeat(64)))
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
