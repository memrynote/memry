//! Defuddle's DOM is built from a fetched page (the Inbox article job), which is untrusted:
//! htmlparser2 nests what html5ever drops (a stray `<caption>`), and cloning and serializing
//! that tree recurse once per level. The build fails past `PAGE_MAX_DEPTH` instead of
//! overflowing the parse thread's stack.

use memry_desktop::web::extract::dom::Document;
use memry_desktop::web::extract::error::ExtractError;
use memry_desktop::web::extract::fetch::{FetchRequest, FetchResponse, Fetcher};
use memry_desktop::web::extract::markdown::turndown::parse::{CapHit, PAGE_MAX_DEPTH};
use memry_desktop::web::extract::{ArticleCapture, ExtractionStatus, extract_article};
use memry_test_kit::on_small_stack;

struct NoNetwork;

impl Fetcher for NoNetwork {
    fn fetch(&self, _: FetchRequest) -> Result<FetchResponse, String> {
        Err("no network".to_owned())
    }
}

fn extract_on_small_stack(html: String) -> ArticleCapture {
    on_small_stack(move || {
        extract_article(
            &html,
            "https://example.com/deep",
            "2025-03-04T05:06:07.000Z",
            &NoNetwork,
        )
    })
}

/// 20,000 nested `<caption>` pass the metadata scrape (html5ever ignores a stray caption) and
/// 20,000 nested `<div>` reach Defuddle the same way; both used to abort the process.
#[test]
fn twenty_thousand_nested_elements_extract_as_failed_on_a_small_stack() {
    for open in ["<caption>", "<div>"] {
        let html = format!(
            "<html><head><title>Deep</title></head><body>{}x</body></html>",
            open.repeat(20_000)
        );
        let capture = extract_on_small_stack(html);
        assert_eq!(
            capture.extraction_status,
            ExtractionStatus::Failed,
            "{open}"
        );
        assert_eq!(capture.content_markdown, "", "{open}");
    }
}

const TOO_DEEP: Result<(), ExtractError> = Err(ExtractError::TooLarge(CapHit::TooDeep));

/// htmlparser2 adds no `html` or `body`, so the page's elements are the whole tree. Void
/// elements, an implied `</p>` and closed elements nest one level each and do not add up.
#[test]
fn the_parse_fails_one_element_past_the_cap() {
    for open in ["<caption>", "<div>"] {
        let at_cap = format!("{}<br><img></p>x", open.repeat(PAGE_MAX_DEPTH - 1));
        assert!(Document::parse_html(&at_cap).is_ok(), "{open}");
        let closed = format!("{}{}", "<b></b>".repeat(4 * PAGE_MAX_DEPTH), at_cap);
        assert!(Document::parse_html(&closed).is_ok(), "{open}");
        let past = format!("{}x", open.repeat(PAGE_MAX_DEPTH + 1));
        assert_eq!(Document::parse_html(&past).map(drop), TOO_DEEP, "{open}");
    }
}

/// The extractors' `parseHTML` and `innerHTML` take page text too.
#[test]
fn fragments_and_inner_html_fail_past_the_cap() {
    let past = "<div>".repeat(PAGE_MAX_DEPTH + 1);
    let mut doc = Document::parse_html("<p>x</p>").expect("parse");
    assert_eq!(doc.parse_fragment(&past).map(drop), TOO_DEEP);
    let p = doc.query_selector(doc.root(), "p").unwrap().unwrap();
    assert_eq!(doc.set_inner_html(p, &past), TOO_DEEP);
    let at_cap = "<div>".repeat(PAGE_MAX_DEPTH);
    assert!(doc.parse_fragment(&at_cap).is_ok());
    assert_eq!(doc.set_inner_html(p, &at_cap), Ok(()));
}

/// The deepest page the parse accepts goes through every clone and serialization of the
/// pipeline on the stack of the parse thread.
#[test]
fn a_page_at_the_cap_extracts_on_a_small_stack() {
    for open in ["<caption>", "<div>"] {
        let html = format!("{}deep", open.repeat(PAGE_MAX_DEPTH));
        let capture = extract_on_small_stack(html);
        assert_ne!(capture.extraction_status, ExtractionStatus::Full, "{open}");
    }
}
