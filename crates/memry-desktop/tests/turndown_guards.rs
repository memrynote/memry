//! Turndown converts the article of a fetched page (the Inbox article job), which is untrusted:
//! its parse stops at the page caps (`Caps::for_page`) on a small stack, the extraction of a page
//! past a cap fails instead of converting, and any input converts within the output bound.

use memry_desktop::web::extract::error::ExtractError;
use memry_desktop::web::extract::fetch::{FetchRequest, FetchResponse, Fetcher};
use memry_desktop::web::extract::markdown::create_markdown_content;
use memry_desktop::web::extract::markdown::turndown::parse::{CapHit, FEED_CHUNK, PAGE_MAX_DEPTH};
use memry_desktop::web::extract::markdown::turndown::{parse_steps, turndown};
use memry_desktop::web::extract::{ExtractionStatus, extract_article};
use memry_test_kit::{on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;

struct Run {
    result: Result<String, ExtractError>,
    steps: usize,
}

fn convert(html: String) -> Run {
    on_small_stack(move || {
        let before = parse_steps();
        let result = turndown(&html);
        Run {
            result,
            steps: parse_steps() - before,
        }
    })
}

/// `html`, `body`, Turndown's wrapper and the text take four levels.
#[test]
fn nesting_below_the_cap_converts_on_a_small_stack() {
    for open in ["<div>", "<span>", "<b>", "<blockquote>"] {
        let html = format!("{}deep", open.repeat(PAGE_MAX_DEPTH - 4));
        let run = convert(html);
        assert!(run.result.expect(open).contains("deep"), "{open}");
    }
}

/// 200,000 nested elements cost 2 * 10^10 scans inside html5ever and would recurse through
/// Turndown's `process` once per level. The cap stops the parse a chunk past the depth, and
/// each node attached follows at most `PAGE_MAX_DEPTH` parent links.
#[test]
fn deeper_nesting_fails_the_conversion_on_a_small_stack() {
    for open in ["<div>", "<span>", "<b>", "<blockquote>", "<template>"] {
        let run = convert(format!("{}x", open.repeat(200_000)));
        assert_eq!(
            run.result,
            Err(ExtractError::TooLarge(CapHit::TooDeep)),
            "{open}"
        );
        let bound = (PAGE_MAX_DEPTH + FEED_CHUNK + 8) * (PAGE_MAX_DEPTH + 3);
        assert!(run.steps <= bound, "{open}: {} steps", run.steps);
    }
}

/// Formatting reconstruction clones every open formatting element for each run of text: 500
/// distinct `<b>` closed by `</div>` and then 20,000 paragraphs ask for 10 million elements from
/// 170 KB. The node budget stops the parse.
#[test]
fn formatting_reconstruction_fails_the_conversion_at_the_node_budget() {
    let mut html = String::from("<div>");
    for i in 0..500 {
        html.push_str(&format!("<b id={i}>"));
    }
    html.push_str("</div>");
    html.push_str(&"<p>x</p>".repeat(20_000));
    let len = html.len();
    let run = convert(html);
    assert_eq!(
        run.result,
        Err(ExtractError::TooLarge(CapHit::TooManyNodes))
    );
    let budget = 2 * len + 64;
    assert!(
        run.steps <= budget * (PAGE_MAX_DEPTH + 3),
        "{} steps",
        run.steps
    );
}

/// The conversion error is the one `createMarkdownContent` does not turn into its partial
/// conversion notice.
#[test]
fn a_page_past_a_cap_is_no_markdown() {
    let html = format!("<p>intro</p>{}x", "<div>".repeat(2_000));
    assert_eq!(
        on_small_stack(move || create_markdown_content(&html)),
        Err(ExtractError::TooLarge(CapHit::TooDeep))
    );
}

struct NoNetwork;

impl Fetcher for NoNetwork {
    fn fetch(&self, _: FetchRequest) -> Result<FetchResponse, String> {
        Err("no network".to_owned())
    }
}

/// An article whose content nests past the cap extracts as `failed`, with no content, which the
/// article job records without touching the capture.
#[test]
fn an_article_past_a_cap_extracts_as_failed() {
    let paragraph = "<p>This paragraph is long enough to count as the article's prose. </p>";
    let html = format!(
        "<html><head><title>Deep</title></head><body><article>{}{}x{}</article></body></html>",
        paragraph.repeat(20),
        "<blockquote>".repeat(1_000),
        "</blockquote>".repeat(1_000)
    );
    let capture = on_small_stack(move || {
        extract_article(
            &html,
            "https://example.com/deep",
            "2025-03-04T05:06:07.000Z",
            &NoNetwork,
        )
    });
    assert_eq!(capture.extraction_status, ExtractionStatus::Failed);
    assert_eq!(capture.content_markdown, "");
}

const FRAGMENTS: &[&str] = &[
    "<div>",
    "</div>",
    "<b>",
    "</b>",
    "<i>",
    "<p>",
    "</p>",
    "<ul>",
    "<li>",
    "<table>",
    "<tr>",
    "<td>",
    "<pre>",
    "<code>",
    "<a href=\"/x\">",
    "</a>",
    "<img src=\"a.png\" alt=\"[x]\">",
    "<blockquote>",
    "<h2>",
    "<template>",
    "<noscript>",
    "*",
    "_",
    "`",
    "\\",
    "#",
    "-",
    "1.",
    "&amp;",
    " ",
    "\n",
];

fn arb_html() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            3 => prop::sample::select(FRAGMENTS).prop_map(str::to_owned),
            1 => "[ -~\u{a0}-\u{2fff}]{0,12}",
        ],
        0..80,
    )
    .prop_map(|parts| parts.concat())
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn any_input_converts_within_the_output_bound(html in arb_html()) {
        if let Ok(markdown) = create_markdown_content(&html) {
            let bound = output_bound(html.len());
            prop_assert!(markdown.len() <= bound, "{} bytes, bound {bound}", markdown.len());
        }
    }
}
