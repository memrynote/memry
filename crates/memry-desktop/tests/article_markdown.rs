//! `createMarkdownContent` and `buildFrontmatter` against Defuddle 0.19.0 and turndown 7.2.4
//! (`pnpm --filter @memry/article-extract vectors`): the content HTML `parseInternal` hands to
//! `toMarkdown` for every corpus page, every single-rule input in `markdown-cases.json` and the
//! 400 random inputs of `markdown-fuzz.json`, compared byte for byte.

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::markdown::create_markdown_content;
use memry_desktop::web::extract::utils::frontmatter::{FrontmatterFields, build_frontmatter};
use serde_json::Value;

fn read(path: &str) -> Value {
    let full = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/test-vectors/article-extract")
        .join(path);
    serde_json::from_str(
        &fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display())),
    )
    .unwrap()
}

/// Compares every vector in `inputs` and returns how many were compared.
fn compare(inputs: Vec<(String, Value)>) -> usize {
    let mut compared = 0;
    let mut failures = Vec::new();
    for (name, vector) in inputs {
        let Some(html) = vector["html"].as_str() else {
            continue;
        };
        compared += 1;
        let expected = vector["markdown"].as_str().unwrap();
        let actual = create_markdown_content(html);
        if actual != expected {
            failures.push(format!(
                "{name}:\n  html: {html:?}\n  rust: {actual:?}\n  node: {expected:?}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
    compared
}

#[test]
fn markdown_matches_on_the_corpus() {
    let index = read("index.json");
    let inputs = index
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let name = entry["name"].as_str().unwrap();
            (name.to_string(), read(&format!("markdown/{name}.json")))
        })
        .collect();
    let compared = compare(inputs);
    assert!(compared >= 25, "only {compared} corpus pages were compared");
}

#[test]
fn markdown_matches_on_single_rule_inputs() {
    let cases = read("markdown-cases.json");
    let inputs = cases
        .as_array()
        .unwrap()
        .iter()
        .map(|case| (case["name"].as_str().unwrap().to_string(), case.clone()))
        .collect();
    let compared = compare(inputs);
    assert!(compared >= 290, "only {compared} inputs were compared");
}

#[test]
fn markdown_matches_on_random_inputs() {
    let fuzz = read("markdown-fuzz.json");
    let inputs = fuzz
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, case)| (format!("fuzz-{i}"), case.clone()))
        .collect();
    let compared = compare(inputs);
    assert!(compared >= 390, "only {compared} inputs were compared");
}

fn field(result: &Value, key: &str) -> Option<String> {
    result.get(key).and_then(Value::as_str).map(str::to_string)
}

#[test]
fn frontmatter_matches() {
    let probes = read("frontmatter.json");
    let probes = probes.as_array().unwrap();
    assert!(probes.len() >= 50);
    for probe in probes {
        let result = &probe["result"];
        let fields = FrontmatterFields {
            title: field(result, "title"),
            author: field(result, "author"),
            site: field(result, "site"),
            published: field(result, "published"),
            domain: field(result, "domain"),
            language: field(result, "language"),
            description: field(result, "description"),
            word_count: result.get("wordCount").and_then(Value::as_u64),
        };
        let source = probe["sourceUrl"].as_str();
        assert_eq!(
            build_frontmatter(&fields, source),
            probe["expected"].as_str().unwrap(),
            "{probe}"
        );
    }
}
