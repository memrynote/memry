//! The metadata port against Defuddle 0.19.0 (`pnpm --filter @memry/article-extract vectors`):
//! meta tags, JSON-LD, `MetadataExtractor.extract`, the schema text and the content boundary on
//! every corpus page and on the single-rule pages in `metadata-cases.json`, plus the helper
//! probes (JSON, URLs, titles, authors, dates, text).

use std::{fs, path::PathBuf};

use memry_desktop::web::extract::defuddle::boundary::{find_content_start, is_above_content_start};
use memry_desktop::web::extract::defuddle::schema_org::{
    collect_meta_tags, extract_schema_org_data, get_schema_text,
};
use memry_desktop::web::extract::dom::{Document, NodeId};
use memry_desktop::web::extract::metadata::{
    clean_author_string, clean_title, extract, get_schema_property, parse_date_text,
};
use memry_desktop::web::extract::utils::json;
use memry_desktop::web::extract::utils::text::{count_words, normalize_text};
use serde_json::{Value, json};

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

fn fixture_html(name: &str) -> String {
    let path = root()
        .join("tests/fixtures/article-extract")
        .join(name)
        .join("page.html");
    String::from_utf8_lossy(&fs::read(path).unwrap()).into_owned()
}

fn ordinal(elements: &[NodeId], found: Option<NodeId>) -> Value {
    found.map_or(Value::Null, |n| {
        json!(elements.iter().position(|e| *e == n).unwrap())
    })
}

/// Runs the pipeline over one page in the order the oracle does and returns its vector.
fn page_vector(html: &str) -> Value {
    let mut doc = Document::parse_html(html);
    let meta_tags = collect_meta_tags(&doc).unwrap();
    let schema = extract_schema_org_data(&doc).unwrap();
    let metadata = extract(&mut doc, &schema, &meta_tags).unwrap();
    let first_heading = doc
        .query_selector(doc.root(), "h1")
        .unwrap()
        .map(|h| doc.text_content(h).unwrap())
        .unwrap_or_default();
    let body = doc.body();
    let elements: Vec<NodeId> = doc
        .descendants(doc.root())
        .into_iter()
        .filter(|n| doc.is_element(*n))
        .collect();
    let find = |title: &str| body.and_then(|b| find_content_start(&doc, b, title).unwrap());
    let start = find(&metadata.title);
    let above: String = elements
        .iter()
        .map(|e| {
            if is_above_content_start(&doc, *e, start) {
                '1'
            } else {
                '0'
            }
        })
        .collect();
    json!({
        "metaTags": meta_tags.iter().map(|t| json!({"name": t.name, "property": t.property, "content": t.content})).collect::<Vec<_>>(),
        "schemaOrgData": schema.stringify(),
        "schemaText": get_schema_text(&schema, 0),
        "metadata": {
            "title": metadata.title, "description": metadata.description, "domain": metadata.domain,
            "favicon": metadata.favicon, "image": metadata.image, "language": metadata.language,
            "published": metadata.published, "author": metadata.author, "site": metadata.site,
        },
        "contentStart": ordinal(&elements, start),
        "contentStartNoTitle": ordinal(&elements, find("")),
        "contentStartHeading": ordinal(&elements, find(&first_heading)),
        "above": above,
    })
}

fn assert_page(name: &str, got: &Value, want: &Value) {
    for key in want.as_object().unwrap().keys() {
        assert_eq!(got[key], want[key], "{name}: {key}");
    }
}

#[test]
fn every_corpus_page_matches_defuddle() {
    let index = read("index.json");
    let pages = index.as_array().unwrap();
    assert!(pages.len() >= 30);
    for page in pages {
        let name = page["name"].as_str().unwrap();
        let want = read(&format!("metadata/{name}.json"));
        assert_page(name, &page_vector(&fixture_html(name)), &want);
    }
}

#[test]
fn single_rule_pages_match_defuddle() {
    let cases = read("metadata-cases.json");
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 55, "{}", cases.len());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        assert_page(
            name,
            &page_vector(case["html"].as_str().unwrap()),
            &case["expected"],
        );
    }
}

#[test]
fn json_parse_and_stringify_match_js() {
    let probes = read("probes.json");
    for probe in probes["json"].as_array().unwrap() {
        let input = probe["input"].as_str().unwrap();
        let got = json::parse(input).ok().map(|v| v.stringify());
        assert_eq!(got.as_deref(), probe["expected"].as_str(), "{input:?}");
    }
}

#[test]
fn schema_property_search_matches_js() {
    let probes = read("probes.json");
    for probe in probes["schemaProperty"].as_array().unwrap() {
        let data = json::parse(probe["data"].as_str().unwrap()).unwrap();
        let property = probe["property"].as_str().unwrap();
        assert_eq!(
            get_schema_property(&data, property),
            probe["expected"].as_str().unwrap(),
            "{} {property}",
            probe["data"]
        );
    }
}

#[test]
fn title_cleaning_matches_js() {
    let probes = read("probes.json");
    let probes = probes["cleanTitle"].as_array().unwrap();
    assert!(probes.len() >= 600);
    for probe in probes {
        let (title, site) = (
            probe["title"].as_str().unwrap(),
            probe["site"].as_str().unwrap(),
        );
        let got = clean_title(title, site);
        assert_eq!(
            got.title,
            probe["expected"]["title"].as_str().unwrap(),
            "{title:?} / {site:?}"
        );
        assert_eq!(
            got.detected_site_name,
            probe["expected"]["detectedSiteName"].as_str().unwrap(),
            "{title:?} / {site:?}"
        );
    }
}

#[test]
fn author_cleaning_matches_js() {
    let probes = read("probes.json");
    for probe in probes["cleanAuthor"].as_array().unwrap() {
        let input = probe["input"].as_str().unwrap();
        assert_eq!(
            clean_author_string(input),
            probe["expected"].as_str().unwrap(),
            "{input:?}"
        );
    }
}

#[test]
fn date_text_matches_js() {
    let probes = read("probes.json");
    for probe in probes["dateText"].as_array().unwrap() {
        let input = probe["input"].as_str().unwrap();
        assert_eq!(
            parse_date_text(input),
            probe["expected"].as_str().unwrap(),
            "{input:?}"
        );
    }
}

#[test]
fn text_helpers_match_js() {
    let probes = read("probes.json");
    for probe in probes["text"].as_array().unwrap() {
        let input = probe["input"].as_str().unwrap();
        assert_eq!(
            count_words(input) as u64,
            probe["countWords"].as_u64().unwrap(),
            "{input:?}"
        );
        assert_eq!(
            normalize_text(input),
            probe["normalizeText"].as_str().unwrap(),
            "{input:?}"
        );
    }
}

#[test]
fn urls_match_node() {
    let probes = read("probes.json");
    for probe in probes["url"].as_array().unwrap() {
        let input = probe["input"].as_str().unwrap();
        let parsed = match probe["base"].as_str() {
            None => url::Url::parse(input),
            Some(base) => url::Url::parse(base).and_then(|b| b.join(input)),
        };
        let got = parsed.ok().map(|u| {
            json!({
                "href": u.as_str(),
                "hostname": u.host_str().unwrap_or(""),
                "origin": u.origin().ascii_serialization(),
                "pathname": u.path(),
            })
        });
        let want = &probe["expected"];
        assert_eq!(
            got.as_ref().unwrap_or(&Value::Null),
            want,
            "{} + {input:?}",
            probe["base"]
        );
    }
}
