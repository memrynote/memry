//! The removal steps against Defuddle 0.19.0 (`pnpm --filter @memry/article-extract vectors`):
//! the content element and the clone's size after each step of `Defuddle.parseInternal` that
//! removes nodes, for every corpus page and every single-rule page in `removal-cases.json`, in
//! five option variants (the default run, the hidden-content retry, the extractor pipeline and
//! two with settings off), plus `ContentScorer.scoreElement` for every element.

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::defuddle::boundary::find_content_start;
use memry_desktop::web::extract::defuddle::schema_org::{
    collect_meta_tags, extract_schema_org_data,
};
use memry_desktop::web::extract::defuddle::settings::Settings;
use memry_desktop::web::extract::dom::{Document, NodeId};
use memry_desktop::web::extract::metadata::extract;
use memry_desktop::web::extract::removals::scoring::score_element;
use memry_desktop::web::extract::removals::small_images::find_small_images;
use memry_desktop::web::extract::removals::{Removal, Step, remove_metadata_block, run_step};
use memry_desktop::web::extract::utils::js::utf16_len;
use memry_desktop::web::extract::utils::json::number_to_string;
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

fn fixture(name: &str, file: &str) -> String {
    let path = root()
        .join("tests/fixtures/article-extract")
        .join(name)
        .join(file);
    String::from_utf8_lossy(&fs::read(path).unwrap()).into_owned()
}

fn settings(options: &Value) -> Settings {
    let flag =
        |key: &str, default: bool| options.get(key).and_then(Value::as_bool).unwrap_or(default);
    let d = Settings::default();
    Settings {
        remove_exact_selectors: flag("removeExactSelectors", d.remove_exact_selectors),
        remove_partial_selectors: flag("removePartialSelectors", d.remove_partial_selectors),
        remove_hidden_elements: flag("removeHiddenElements", d.remove_hidden_elements),
        remove_low_scoring: flag("removeLowScoring", d.remove_low_scoring),
        remove_small_images: flag("removeSmallImages", d.remove_small_images),
        remove_content_patterns: flag("removeContentPatterns", d.remove_content_patterns),
        standardize: true,
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect()
}

/// What the oracle snapshots: the content element and the clone's document element size.
fn snapshot(doc: &Document, clone: NodeId, main: NodeId) -> (String, usize) {
    let html = doc
        .document_element_of(clone)
        .map(|h| doc.outer_html(h))
        .unwrap_or_default();
    (doc.outer_html(main), utf16_len(&html))
}

/// Runs one variant of one page and returns what differs from the vector.
fn check(html: &str, variant: &Value) -> Vec<String> {
    let input = &variant["input"];
    let url = input["url"].as_str().unwrap();
    let mut doc = Document::parse_html(html);
    let meta_tags = collect_meta_tags(&doc).unwrap();
    let schema = extract_schema_org_data(&doc).unwrap();
    let metadata = extract(&mut doc, &schema, &meta_tags).unwrap();
    let mut diffs = Vec::new();
    if metadata.title != input["title"].as_str().unwrap()
        || metadata.description != input["description"].as_str().unwrap()
        || (!metadata.published.is_empty() || !metadata.author.is_empty())
            != input["hasPublishedOrAuthor"].as_bool().unwrap()
    {
        diffs.push("metadata differs from the vector input".to_string());
    }
    let small = find_small_images(&doc, doc.root()).unwrap();
    if small.iter().collect::<Vec<_>>() != strings(&input["smallImages"]) {
        diffs.push(format!(
            "small images: {:?} != {:?}",
            small.iter().collect::<Vec<_>>(),
            input["smallImages"]
        ));
    }
    let clone = doc.clone_node(doc.root(), true);
    if let Some(body) = doc.body_of(clone) {
        doc.normalize(body);
    }
    let Some(path) = input.get("mainPath") else {
        assert!(
            variant.get("main").is_some_and(Value::is_null),
            "oracle found no content"
        );
        return diffs;
    };
    let mut main = clone;
    for index in path.as_array().unwrap() {
        main = doc.child_nodes(main)[index.as_u64().unwrap() as usize];
    }

    let steps = &variant["steps"];
    let (mut last_main, last_len) = snapshot(&doc, clone, main);
    if steps["initial"]["main"].as_str() != Some(last_main.as_str())
        || steps["initial"]["cloneLength"].as_u64() != Some(last_len as u64)
    {
        diffs.push("initial state differs".to_string());
        return diffs;
    }
    let mut compare = |doc: &Document, key: &str| {
        let (now_main, now_len) = snapshot(doc, clone, main);
        let expected = &steps[key];
        let expected_main = expected["main"].as_str().unwrap_or(&last_main);
        if now_main != expected_main {
            diffs.push(format!(
                "{key}: content differs\n  rust: {now_main}\n  node: {expected_main}"
            ));
        }
        if expected["cloneLength"].as_u64() != Some(now_len as u64) {
            diffs.push(format!(
                "{key}: clone length {now_len} != {}",
                expected["cloneLength"]
            ));
        }
        last_main = now_main;
    };

    remove_metadata_block(
        &mut doc,
        main,
        input["hasPublishedOrAuthor"].as_bool().unwrap(),
    )
    .unwrap();
    compare(&doc, "metadataBlock");
    let removal = Removal {
        clone,
        main,
        settings: settings(&input["options"]),
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
    diffs
}

fn run_pages(pages: Vec<(String, String, Value)>) {
    let mut failures = Vec::new();
    let mut with_content = 0;
    for (name, html, variants) in pages {
        for (variant_name, variant) in variants.as_object().unwrap() {
            if variant.get("steps").is_some() {
                with_content += 1;
            }
            for diff in check(&html, variant) {
                failures.push(format!("{name} [{variant_name}]: {diff}"));
            }
        }
    }
    assert!(
        with_content > 100,
        "only {with_content} runs reached the steps"
    );
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn removals_match_on_the_corpus() {
    let index = read("index.json");
    let pages = index
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            let name = entry["name"].as_str().unwrap();
            let vector = read(&format!("removals/{name}.json"));
            (
                name.to_string(),
                fixture(name, "page.html"),
                vector["variants"].clone(),
            )
        })
        .collect();
    run_pages(pages);
}

#[test]
fn removals_match_on_single_rule_pages() {
    let cases = read("removal-cases.json");
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
    run_pages(pages);
}

#[test]
fn element_scores_match() {
    let scores = read("scores.json");
    let index = read("index.json");
    let cases = read("removal-cases.json");
    let mut pages: Vec<(String, String)> = index
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let name = e["name"].as_str().unwrap();
            (name.to_string(), fixture(name, "page.html"))
        })
        .collect();
    pages.extend(cases.as_array().unwrap().iter().map(|c| {
        (
            c["name"].as_str().unwrap().to_string(),
            c["html"].as_str().unwrap().to_string(),
        )
    }));
    let mut failures = Vec::new();
    for (name, html) in pages {
        let doc = Document::parse_html(&html);
        let expected = strings(&scores[&name]);
        let elements: Vec<NodeId> = doc
            .descendants(doc.root())
            .into_iter()
            .filter(|n| doc.is_element(*n))
            .collect();
        if elements.len() != expected.len() {
            failures.push(format!(
                "{name}: {} elements != {}",
                elements.len(),
                expected.len()
            ));
            continue;
        }
        for (i, el) in elements.iter().enumerate() {
            let got = number_to_string(score_element(&doc, *el).unwrap());
            if got != expected[i] {
                failures.push(format!("{name} #{i}: {got} != {}", expected[i]));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// `findContentStart` is read by `removeByContentPattern`; the pipeline vector above would hide a
/// shared bug, so the entry point is exercised once on its own.
#[test]
fn content_start_is_reachable_from_the_removals_module() {
    let doc = Document::parse_html(
        "<article><p>one two three four five six seven eight nine.</p></article>",
    );
    let main = doc.query_selector(doc.root(), "article").unwrap().unwrap();
    assert!(find_content_start(&doc, main, "").unwrap().is_some());
}
