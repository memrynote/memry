//! The generic path of `Defuddle` (`parse()` with its retries, markdown, `mapToArticleCapture`)
//! against Defuddle 0.19.0 (`pnpm --filter @memry/article-extract vectors`), for every corpus
//! page: the standardized content, the markdown, the metadata fields, the word count and the
//! serialized `ArticleCapture`. temml (LaTeX to MathML) is off in the oracle.

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::fetch::{FetchRequest, FetchResponse, Fetcher};
use memry_desktop::web::extract::{extract_article, run_defuddle};
use serde_json::Value;

struct NoFetch;
impl Fetcher for NoFetch {
    fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, String> {
        Err(format!("unexpected fetch of {}", request.url))
    }
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

const VECTORS: &str = "../../packages/contracts/test-vectors/article-extract";

fn read(path: &str) -> Value {
    let full = root().join(VECTORS).join(path);
    serde_json::from_str(
        &fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display())),
    )
    .unwrap()
}

/// Compares one page with its vector and returns the differences.
fn check(name: &str, html: &str, vector: &Value) -> Vec<String> {
    let url = vector["input"]["url"].as_str().unwrap();
    let now = vector["input"]["now"].as_str().unwrap();
    if let Some(error) = vector.get("error") {
        assert!(error.is_string());
        // The oracle threw (no element at all): the port fails too, and the capture is `failed`.
        let capture = extract_article(html, url, now, &NoFetch);
        return if run_defuddle(html, url).is_err() && capture.content_markdown.is_empty() {
            Vec::new()
        } else {
            vec![format!("{name}: oracle threw {error}, port did not")]
        };
    }
    let mut failures = Vec::new();
    let response = run_defuddle(html, url).unwrap();
    let m = &response.metadata;
    let raw = &vector["raw"];
    let mut cmp = |what: &str, got: String, want: &Value| {
        let want = want
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| want.to_string());
        if got != want {
            failures.push(format!("{name} {what}:\n  rust: {got}\n  node: {want}"));
        }
    };
    cmp("content", response.content.clone(), &vector["content"]);
    cmp("title", m.title.clone(), &raw["title"]);
    cmp("author", m.author.clone(), &raw["author"]);
    cmp("published", m.published.clone(), &raw["published"]);
    cmp("description", m.description.clone(), &raw["description"]);
    cmp("image", m.image.clone(), &raw["image"]);
    cmp("site", m.site.clone(), &raw["site"]);
    cmp("language", m.language.clone(), &raw["language"]);
    cmp(
        "wordCount",
        response.word_count.to_string(),
        &raw["wordCount"],
    );
    let capture = extract_article(html, url, now, &NoFetch);
    cmp(
        "markdown",
        capture.content_markdown.clone(),
        &vector["markdown"],
    );
    let got = serde_json::to_string(&capture).unwrap();
    let want = serde_json::to_string(&vector["expected"]).unwrap();
    if got != want {
        failures.push(format!("{name} capture:\n  rust: {got}\n  node: {want}"));
    }
    failures
}

#[test]
fn every_corpus_page_matches_defuddle() {
    let mut failures = Vec::new();
    let index = read("index.json");
    for entry in index.as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        let html = String::from_utf8_lossy(
            &fs::read(
                root()
                    .join("tests/fixtures/article-extract")
                    .join(name)
                    .join("page.html"),
            )
            .unwrap(),
        )
        .into_owned();
        failures.extend(check(name, &html, &read(&format!("pipeline/{name}.json"))));
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn every_single_branch_page_matches_defuddle() {
    let mut failures = Vec::new();
    let cases = read("pipeline-cases.json");
    assert!(cases.as_array().unwrap().len() >= 30);
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        failures.extend(check(name, case["html"].as_str().unwrap(), case));
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
