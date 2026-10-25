//! The `markdown-convert/md-to-html.json` conformance file: BlockNote 0.54.2
//! `markdownToHtml`, markdown in, HTML string out, byte for byte.

#![cfg(feature = "markdown")]

mod support;

use memry_core::markdown::bn::md_to_html::markdown_to_html;
use support::vector_compare::{Failures, bytes_equal};
use support::vector_file;

#[test]
fn every_md_to_html_case_matches_the_oracle() {
    let file = vector_file("markdown-convert/md-to-html");
    let cases = file["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "no cases");
    let mut failures = Failures::default();
    for case in cases {
        let id = case["id"].as_str().expect("id");
        assert_eq!(case["op"], "md-to-html", "{id}: op");
        assert_eq!(case["expected"]["status"], "ok", "{id}: status");
        let markdown = case["input"]["markdown"].as_str().expect("markdown");
        let expected = case["expected"]["output"].as_str().expect("output");
        failures.check(id, bytes_equal(expected, &markdown_to_html(markdown)));
    }
    let checked = failures.checked();
    failures.finish("md-to-html");
    assert_eq!(checked, cases.len());
    println!("md-to-html vectors: {checked} cases");
}
