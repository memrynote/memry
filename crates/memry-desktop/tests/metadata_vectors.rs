//! The metascraper port against metascraper 5.49.21 itself: every page of the synthetic corpus
//! (`tests/fixtures/metadata/pages.json`) scraped in Rust, compared field by field with the
//! `expected.json` that `scripts/generate-metadata-vectors.mjs` writes. Dates without a timezone
//! read in UTC on both sides.

use std::path::Path;

use chrono::{TimeZone, Utc};
use memry_desktop::services::web_fetch::{UrlMetadata, decode_text, metascrape_at};
use serde_json::{Map, Value};

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/metadata")
}

fn read_json(name: &str) -> Value {
    let text = std::fs::read_to_string(fixtures().join(name)).expect("read fixture json");
    serde_json::from_str(&text).expect("parse fixture json")
}

fn as_json(meta: &UrlMetadata) -> Map<String, Value> {
    let fields = [
        ("title", &meta.title),
        ("description", &meta.description),
        ("image", &meta.image),
        ("author", &meta.author),
        ("publisher", &meta.publisher),
        ("date", &meta.date),
        ("logo", &meta.logo),
        ("url", &meta.url),
    ];
    fields
        .into_iter()
        .filter_map(|(k, v)| v.clone().map(|v| (k.to_owned(), Value::String(v))))
        .collect()
}

#[test]
fn every_page_matches_metascraper() {
    let pages = read_json("pages.json");
    let expected = read_json("expected.json");
    let now = Utc.with_ymd_and_hms(2025, 1, 15, 12, 0, 0).unwrap();
    let mut diffs = Vec::new();
    for page in pages.as_array().expect("pages array") {
        let file = page["file"].as_str().expect("file");
        let url = page["url"].as_str().expect("url");
        let bytes = std::fs::read(fixtures().join("pages").join(file)).expect("read page");
        let html = decode_text(&bytes, page["contentType"].as_str());
        let got = match metascrape_at(&html, url, &now) {
            Ok(meta) => as_json(&meta),
            Err(error) => Map::from_iter([("error".to_owned(), error.to_string().into())]),
        };
        let want = expected[file].as_object().expect("expected entry");
        let mut keys: Vec<&String> = got.keys().chain(want.keys()).collect();
        keys.sort();
        keys.dedup();
        for key in keys {
            if got.get(key) != want.get(key) {
                diffs.push(format!(
                    "{file} {key}: got {:?}, want {:?}",
                    got.get(key),
                    want.get(key)
                ));
            }
        }
    }
    assert_eq!(
        pages.as_array().map(Vec::len),
        expected.as_object().map(Map::len),
        "one expected entry per page"
    );
    assert!(
        diffs.is_empty(),
        "{} diffs:\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}
