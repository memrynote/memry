//! `standardizeFootnotes`, `standardizeCallouts` and `standardizeContent` against Defuddle 0.19.0
//! (`pnpm --filter @memry/article-extract vectors`): the content element after each step, for
//! every corpus page, every single-rule page in `standardize-cases.json` and the 400 random pages
//! of `standardize-fuzz.json`, in the `direct` variant (callouts and standardize on the content
//! element) and the `pipeline` variant (the metadata block and removal steps first).
//!
//! The vectors make the two math converters (mathml-to-latex, temml) throw: they are ported in
//! later stages.

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::defuddle::schema_org::{
    collect_meta_tags, extract_schema_org_data,
};
use memry_desktop::web::extract::defuddle::settings::Settings;
use memry_desktop::web::extract::dom::{Document, NodeId};
use memry_desktop::web::extract::elements::callouts::standardize_callouts;
use memry_desktop::web::extract::elements::footnotes::standardize_footnotes;
use memry_desktop::web::extract::metadata::extract;
use memry_desktop::web::extract::removals::small_images::find_small_images;
use memry_desktop::web::extract::removals::{Removal, Step, remove_metadata_block, run_step};
use memry_desktop::web::extract::standardize::standardize_content;
use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    let full = root()
        .join("../../packages/contracts/test-vectors/article-extract")
        .join(path);
    serde_json::from_str(
        &fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display())),
    )
    .unwrap()
}

fn fixture(name: &str) -> String {
    let path = root()
        .join("tests/fixtures/article-extract")
        .join(name)
        .join("page.html");
    String::from_utf8_lossy(&fs::read(path).unwrap()).into_owned()
}

/// Runs one variant of one page and returns what differs from the vector.
fn check(html: &str, variant: &Value) -> Vec<String> {
    let input = &variant["input"];
    let url = input["url"].as_str().unwrap();
    let pipeline = input["variant"].as_str() == Some("pipeline");
    let mut doc = Document::parse_html(html);
    let meta_tags = collect_meta_tags(&doc).unwrap();
    let schema = extract_schema_org_data(&doc).unwrap();
    let metadata = extract(&mut doc, &schema, &meta_tags).unwrap();
    let small = find_small_images(&doc, doc.root()).unwrap();
    let clone = doc.clone_node(doc.root(), true);
    if let Some(body) = doc.body_of(clone) {
        doc.normalize(body);
    }
    let Some(path) = input.get("mainPath") else {
        assert!(variant["steps"].is_null(), "oracle found no content");
        return Vec::new();
    };
    let mut main: NodeId = clone;
    for index in path.as_array().unwrap() {
        main = doc.child_nodes(main)[index.as_u64().unwrap() as usize];
    }

    let steps = &variant["steps"];
    let mut last = doc.outer_html(main);
    let mut diffs = Vec::new();
    let mut compare = |doc: &Document, key: &str| {
        let now = doc.outer_html(main);
        let expected = steps[key].as_str().unwrap_or(&last);
        if now != expected {
            diffs.push(format!("{key}:\n  rust: {now}\n  node: {expected}"));
        }
        last = now;
    };

    if pipeline {
        remove_metadata_block(
            &mut doc,
            main,
            input["hasPublishedOrAuthor"].as_bool().unwrap(),
        )
        .unwrap();
        compare(&doc, "metadataBlock");
    }
    standardize_footnotes(&mut doc, main).unwrap();
    compare(&doc, "footnotes");
    standardize_callouts(&mut doc, main).unwrap();
    compare(&doc, "callouts");
    if pipeline {
        let removal = Removal {
            clone,
            main,
            settings: Settings::default(),
            small_images: &small,
            url,
            title: input["title"].as_str().unwrap(),
            description: input["description"].as_str().unwrap(),
        };
        for step in Step::ALL {
            run_step(&mut doc, step, &removal).unwrap();
            let key = match step {
                Step::SmallImages => "smallImages",
                Step::HiddenElements => "hidden",
                Step::EyebrowLabel => "eyebrow",
                Step::Selectors => "selectors",
                Step::LowScoring => "lowScoring",
                Step::ContentPatterns => "contentPatterns",
            };
            compare(&doc, key);
        }
    }
    let source = doc.root();
    standardize_content(&mut doc, main, &metadata.title, source).unwrap();
    compare(&doc, "standardize");
    diffs
}

fn run_pages(pages: Vec<(String, String, Value)>, minimum: usize) {
    let mut failures = Vec::new();
    let mut reached = 0;
    for (name, html, variants) in pages {
        for (variant_name, variant) in variants.as_object().unwrap() {
            if !variant["steps"].is_null() {
                reached += 1;
            }
            for diff in check(&html, variant) {
                failures.push(format!("{name} [{variant_name}]: {diff}"));
            }
        }
    }
    assert!(reached >= minimum, "only {reached} runs reached the steps");
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn standardize_matches_on_the_corpus() {
    let index = read("index.json");
    let pages = index
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let name = entry["name"].as_str().unwrap();
            let vector = read(&format!("standardize/{name}.json"));
            (name.to_string(), fixture(name), vector["variants"].clone())
        })
        .collect();
    run_pages(pages, 50);
}

#[test]
fn standardize_matches_on_single_rule_pages() {
    let cases = read("standardize-cases.json");
    let pages = cases
        .as_array()
        .unwrap()
        .iter()
        .map(|case| {
            (
                case["name"].as_str().unwrap().to_string(),
                case["html"].as_str().unwrap().to_string(),
                case["variants"].clone(),
            )
        })
        .collect();
    run_pages(pages, 100);
}

#[test]
fn standardize_matches_on_random_pages() {
    let fuzz = read("standardize-fuzz.json");
    let pages = fuzz
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, case)| {
            let variants = serde_json::json!({ "direct": {
                "input": case["input"], "steps": case["steps"]
            }});
            (
                format!("fuzz-{i}"),
                case["html"].as_str().unwrap().to_string(),
                variants,
            )
        })
        .collect();
    run_pages(pages, 390);
}
