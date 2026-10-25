//! `constants` against `dist/constants.js` of Defuddle 0.19.0: every table element by element,
//! the joined selector strings, and the regexes on probes whose results JavaScript produced
//! (`pnpm --filter @memry/article-extract vectors`).

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::constants as c;
use serde_json::Value;

fn read(path: &str) -> Value {
    let full = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/article-extract")
        .join(path);
    serde_json::from_str(&fs::read_to_string(&full).unwrap()).unwrap()
}

fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect()
}

#[test]
fn tables_equal_the_js_exports() {
    let js = read("constants.json");
    let lists: [(&str, &[&str]); 12] = [
        ("ENTRY_POINT_ELEMENTS", c::ENTRY_POINT_ELEMENTS),
        ("BLOCK_ELEMENTS", c::BLOCK_ELEMENTS),
        ("BLOCK_ELEMENTS_SET", c::BLOCK_ELEMENTS),
        ("BLOCK_LEVEL_ELEMENTS", c::BLOCK_LEVEL_ELEMENTS),
        ("PRESERVE_ELEMENTS", c::PRESERVE_ELEMENTS),
        ("INLINE_ELEMENTS", c::INLINE_ELEMENTS),
        ("EXACT_SELECTORS", c::EXACT_SELECTORS),
        ("TEST_ATTRIBUTES", c::TEST_ATTRIBUTES),
        ("PARTIAL_SELECTORS", c::PARTIAL_SELECTORS),
        ("ALLOWED_EMPTY_ELEMENTS", c::ALLOWED_EMPTY_ELEMENTS),
        ("ALLOWED_ATTRIBUTES", c::ALLOWED_ATTRIBUTES),
        ("ALLOWED_ATTRIBUTES_DEBUG", c::ALLOWED_ATTRIBUTES_DEBUG),
    ];
    for (name, rust) in lists {
        assert_eq!(strings(&js[name]), rust, "{name}");
    }
    assert_eq!(js["MOBILE_WIDTH"], c::MOBILE_WIDTH);

    let joined: [(&str, &str); 8] = [
        ("BLOCK_ELEMENTS_SELECTOR", &c::BLOCK_ELEMENTS_SELECTOR),
        ("CONTENT_ELEMENT_SELECTOR", &c::CONTENT_ELEMENT_SELECTOR),
        ("HIDDEN_EXACT_SELECTOR", &c::HIDDEN_EXACT_SELECTOR),
        ("HIDDEN_EXACT_SKIP_SELECTOR", &c::HIDDEN_EXACT_SKIP_SELECTOR),
        ("EXACT_SELECTORS_JOINED", &c::EXACT_SELECTORS_JOINED),
        ("TEST_ATTRIBUTES_SELECTOR", &c::TEST_ATTRIBUTES_SELECTOR),
        ("FOOTNOTE_INLINE_REFERENCES", &c::FOOTNOTE_INLINE_REFERENCES),
        ("FOOTNOTE_LIST_SELECTORS", &c::FOOTNOTE_LIST_SELECTORS),
    ];
    for (name, rust) in joined {
        assert_eq!(js[name].as_str().unwrap(), rust, "{name}");
    }
}

#[test]
fn hidden_selectors_inside_the_exact_list_are_the_hidden_constant() {
    let at = c::EXACT_SELECTORS
        .iter()
        .position(|s| *s == c::HIDDEN_EXACT_SELECTORS[0])
        .unwrap();
    assert_eq!(&c::EXACT_SELECTORS[at..at + 4], c::HIDDEN_EXACT_SELECTORS);
}

#[test]
fn tailwind_tables_equal_the_js_objects() {
    let js = read("constants.json");
    let colors = js["TAILWIND_COLORS"].as_object().unwrap();
    assert_eq!(colors.len(), c::TAILWIND_COLORS.len());
    for ((name, shades), (js_name, js_shades)) in c::TAILWIND_COLORS.iter().zip(colors) {
        assert_eq!(name, js_name);
        let js_shades: Vec<(&str, &str)> = js_shades
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str().unwrap()))
            .collect();
        assert_eq!(*shades, js_shades.as_slice(), "{name}");
    }
    let special: Vec<(&str, &str)> = js["TAILWIND_SPECIAL"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str().unwrap()))
        .collect();
    assert_eq!(c::TAILWIND_SPECIAL, special.as_slice());
}

#[test]
fn partial_regex_sources_and_flags_are_the_js_ones() {
    let js = read("constants.json");
    let joined = c::PARTIAL_SELECTORS.join("|");
    assert_eq!(js["PARTIAL_SELECTORS_REGEX"]["source"], joined);
    assert_eq!(js["PARTIAL_SELECTORS_REGEX"]["flags"], "i");
    // `RegExp#source` escapes `/`; none of the patterns holds one.
    assert_eq!(
        js["PARTIAL_SELECTORS_ANCHORED_REGEX"]["source"],
        format!("^(?:{joined})$")
    );
    assert_eq!(js["PARTIAL_SELECTORS_ANCHORED_REGEX"]["flags"], "i");
}

#[test]
fn partial_regexes_match_like_js() {
    let probes = read("probes.json");
    let probes = probes["partial"].as_array().unwrap();
    assert!(probes.len() > 3000, "{}", probes.len());
    for probe in probes {
        let text = probe["text"].as_str().unwrap();
        assert_eq!(
            c::partial_selectors_match(text),
            probe["partial"].as_bool().unwrap(),
            "partial {text:?}"
        );
        assert_eq!(
            c::partial_selectors_anchored_match(text),
            probe["anchored"].as_bool().unwrap(),
            "anchored {text:?}"
        );
    }
}

fn captures(regex: &regex::Regex, text: &str) -> Value {
    match regex.captures(text) {
        None => Value::Null,
        Some(m) => Value::Array(
            m.iter()
                .map(|g| g.map_or(Value::Null, |g| Value::String(g.as_str().to_string())))
                .collect(),
        ),
    }
}

#[test]
fn tailwind_regexes_match_like_js() {
    let probes = read("probes.json");
    for probe in probes["tailwind"].as_array().unwrap() {
        let text = probe["text"].as_str().unwrap();
        assert_eq!(
            captures(&c::TW_COLOR_CLASS_RE, text),
            probe["color"],
            "color {text:?}"
        );
        assert_eq!(
            captures(&c::TW_SPECIAL_CLASS_RE, text),
            probe["special"],
            "special {text:?}"
        );
        assert_eq!(
            captures(&c::TW_ARBITRARY_RE, text),
            probe["arbitrary"],
            "arbitrary {text:?}"
        );
    }
}
