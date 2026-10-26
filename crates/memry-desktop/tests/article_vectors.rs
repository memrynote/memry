//! The whole of `extractFromHtml` (Defuddle 0.19.0 on linkedom, async extractors on, markdown,
//! `mapToArticleCapture`) against the vectors the TypeScript extractor generates
//! (`pnpm --filter @memry/article-extract vectors`), for every corpus page: the serialized
//! `ArticleCapture` byte for byte, the raw Defuddle fields, the extractor that took the page and
//! the requests it made. Pages with a `fetch.json` replay their recorded network responses; a
//! request without a recorded response fails the page.

use std::cell::RefCell;
use std::{fs, path::PathBuf};

use memry_desktop::web::extract::extractors::extractor_names;
use memry_desktop::web::extract::fetch::{FetchRequest, FetchResponse, Fetcher};
use memry_desktop::web::extract::{ArticleCapture, extract_article, run_defuddle};
use serde_json::{Value, json};

const VECTORS: &str = "../../packages/contracts/test-vectors/article-extract";
const FIXTURES: &str = "tests/fixtures/article-extract";

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(path: &str) -> Value {
    let full = root().join(VECTORS).join(path);
    serde_json::from_str(
        &fs::read_to_string(&full).unwrap_or_else(|e| panic!("{}: {e}", full.display())),
    )
    .unwrap()
}

/// Serves the recorded responses of `fetch.json` and logs every request, as the generator's
/// replay `fetch` does.
struct Replay {
    recorded: Vec<Value>,
    log: RefCell<Vec<Value>>,
}

impl Replay {
    fn new(recorded: &Value) -> Self {
        Replay {
            recorded: recorded.as_array().cloned().unwrap_or_default(),
            log: RefCell::default(),
        }
    }
}

impl Fetcher for Replay {
    fn fetch(&self, request: FetchRequest) -> Result<FetchResponse, String> {
        let body = request
            .body
            .as_ref()
            .map(|b| String::from_utf8_lossy(b).into_owned());
        let headers: Vec<Value> = request.headers.iter().map(|(k, v)| json!([k, v])).collect();
        self.log.borrow_mut().push(json!({
            "method": request.method,
            "url": request.url,
            "headers": headers,
            "body": body,
        }));
        let hit = self.recorded.iter().find(|r| {
            r["method"] == request.method.as_str()
                && r["url"] == request.url.as_str()
                && r.get("body").and_then(Value::as_str).map(str::to_string) == body
        });
        let Some(hit) = hit else {
            return Err(format!(
                "no recorded response for {} {}",
                request.method, request.url
            ));
        };
        if let Some(error) = hit.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        let status = hit["status"].as_u64().unwrap() as u16;
        Ok(FetchResponse {
            status,
            ok: (200..300).contains(&status),
            text: hit["text"].as_str().unwrap().to_string(),
        })
    }
}

fn page_html(name: &str) -> String {
    let bytes = fs::read(root().join(FIXTURES).join(name).join("page.html")).unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Compares one page with its vector and returns the differences.
fn check(name: &str, vector: &Value) -> Vec<String> {
    let html = page_html(name);
    let url = vector["input"]["url"].as_str().unwrap();
    let now = vector["input"]["now"].as_str().unwrap();
    let recorded = &vector["input"]["fetch"];
    if vector.get("error").is_some() {
        let replay = Replay::new(recorded);
        return if run_defuddle(&html, url, &replay).is_err() {
            Vec::new()
        } else {
            vec![format!("{name}: the oracle threw, the port did not")]
        };
    }
    let mut failures = Vec::new();

    let replay = Replay::new(recorded);
    let response = match run_defuddle(&html, url, &replay) {
        Ok(response) => response,
        Err(error) => return vec![format!("{name}: the port failed: {error}")],
    };
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
    cmp(
        "schemaOrgData",
        response.schema_org_data.stringify(),
        &raw["schemaOrgData"],
    );
    cmp(
        "extractorType",
        response
            .extractor_type
            .map_or("null".to_string(), str::to_string),
        &raw["extractorType"],
    );
    let requests = Value::Array(replay.log.borrow().clone());
    cmp(
        "requests",
        requests.to_string(),
        &Value::String(vector["requests"].to_string()),
    );

    let replay = Replay::new(recorded);
    let capture = extract_article(&html, url, now, &replay);
    let got = serde_json::to_string(&capture).unwrap();
    let want = serde_json::to_string(&vector["expected"]).unwrap();
    if got != want {
        failures.push(format!("{name} capture:\n  rust: {got}\n  node: {want}"));
    }
    failures
}

fn index() -> Vec<Value> {
    read("index.json").as_array().unwrap().clone()
}

#[test]
fn every_corpus_page_matches_the_typescript_extractor() {
    let mut failures = Vec::new();
    for entry in index() {
        let name = entry["name"].as_str().unwrap();
        failures.extend(check(name, &read(&format!("article/{name}.json"))));
    }
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The corpus the issue asks for: every registered extractor has a page that the TypeScript run
/// gave to it, and each feature category meets its page count.
#[test]
fn corpus_covers_every_extractor_and_category() {
    let pages = index();
    assert!(pages.len() >= 64, "{} pages", pages.len());
    let mut taken: Vec<String> = Vec::new();
    for entry in &pages {
        let name = entry["name"].as_str().unwrap();
        let vector = read(&format!("article/{name}.json"));
        if let Some(kind) = vector["raw"]["extractorType"].as_str() {
            taken.push(kind.to_string());
        }
    }
    let names = extractor_names();
    assert_eq!(names.len(), 25);
    for name in &names {
        assert!(
            taken.iter().any(|t| t == name),
            "no corpus page for the {name} extractor"
        );
    }
    for (extractor, pages) in [
        ("github", 3),
        ("substack", 2),
        ("reddit", 2),
        ("youtube", 2),
        ("twitter", 2),
    ] {
        let count = taken.iter().filter(|t| *t == extractor).count();
        assert!(count >= pages, "{extractor}: {count} pages, want {pages}");
    }
    let named = |prefixes: &[&str]| {
        pages
            .iter()
            .filter(|p| {
                let name = p["name"].as_str().unwrap();
                prefixes.iter().any(|prefix| name.starts_with(prefix))
            })
            .count()
    };
    for (category, prefixes, want) in [
        ("footnotes", &["footnotes-"][..], 5),
        ("math", &["math-"], 5),
        ("code", &["code-"], 5),
        ("tables", &["tables-", "nested-tables"], 4),
        ("images", &["images-"], 4),
        (
            "rtl and non-latin",
            &["rtl-", "cjk-", "persian-", "mixed-bidi"],
            6,
        ),
    ] {
        let count = named(prefixes);
        assert!(count >= want, "{category}: {count} pages, want {want}");
    }
    let generic = pages
        .iter()
        .filter(|p| {
            let name = p["name"].as_str().unwrap();
            ![
                "footnotes-",
                "math-",
                "code-",
                "tables-",
                "images-",
                "rtl-",
                "cjk-",
                "persian-",
                "extractor-",
            ]
            .iter()
            .any(|prefix| name.starts_with(prefix))
        })
        .count();
    assert!(generic >= 25, "{generic} generic pages");
}

/// Every vector's `expected` is an `ArticleCapture` the capture API accepts: it deserializes into
/// the Rust mirror of `packages/contracts/src/capture-api.ts` and serializes back unchanged.
#[test]
fn expected_captures_round_trip_through_the_capture_type() {
    for entry in index() {
        let name = entry["name"].as_str().unwrap();
        let vector = read(&format!("article/{name}.json"));
        let Some(expected) = vector.get("expected") else {
            continue;
        };
        let capture: ArticleCapture =
            serde_json::from_value(expected.clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            serde_json::to_string(&capture).unwrap(),
            serde_json::to_string(expected).unwrap(),
            "{name}"
        );
    }
}
