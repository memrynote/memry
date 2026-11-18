//! The metascraper port reads fetched web pages, which are untrusted: nesting fails the page on a
//! small stack, the parse stops at its node and time caps, text reads stay within the page's
//! budget, and every field stays within the output bound.

use std::time::Duration;

use chrono::{TimeZone, Utc};
use memry_desktop::services::web_fetch::{
    METASCRAPE_MAX_DEPTH as MAX_DEPTH, MetascrapeError, UrlMetadata, metascrape_at,
    metascrape_parse_steps, metascrape_steps,
};
use memry_desktop::web::extract::markdown::turndown::parse::{
    CapHit, Caps, FEED_CHUNK, parse_page,
};
use memry_test_kit::{on_small_stack, output_bound, proptest_config};
use proptest::prelude::*;

const URL: &str = "https://www.example.com/page";

struct Run {
    result: Result<UrlMetadata, MetascrapeError>,
    steps: usize,
    parse_steps: usize,
}

fn scrape(html: &str) -> Run {
    let now = Utc.with_ymd_and_hms(2025, 1, 15, 12, 0, 0).unwrap();
    let (steps, parse_steps) = (metascrape_steps(), metascrape_parse_steps());
    let result = metascrape_at(html, URL, &now);
    Run {
        result,
        steps: metascrape_steps() - steps,
        parse_steps: metascrape_parse_steps() - parse_steps,
    }
}

fn scrape_on_small_stack(html: String) -> Run {
    on_small_stack(move || scrape(&html))
}

fn fields(meta: &UrlMetadata) -> [&Option<String>; 8] {
    [
        &meta.title,
        &meta.description,
        &meta.image,
        &meta.author,
        &meta.publisher,
        &meta.date,
        &meta.logo,
        &meta.url,
    ]
}

/// `html`, `body` and the text take three levels; a template's content nests one level below
/// the template.
#[test]
fn nesting_up_to_the_cap_reads_the_page_on_a_small_stack() {
    for (open, levels) in [("<div>", 1), ("<span>", 1), ("<b>", 1), ("<template>", 2)] {
        let count = (MAX_DEPTH - 3) / levels;
        let html = format!("<title>Deep</title>{}x", open.repeat(count));
        let run = scrape_on_small_stack(html);
        assert_eq!(run.result.expect(open).title.as_deref(), Some("Deep"));
    }
}

/// The tree builder scans its open elements for most tags, so 200,000 nested elements cost
/// 2 * 10^10 scans inside html5ever. The cap stops the parse a chunk past `MAX_DEPTH`, and each
/// node attached follows at most `MAX_DEPTH` parent links.
#[test]
fn deeper_nesting_fails_the_page_on_a_small_stack() {
    for open in [
        "<div>",
        "<span>",
        "<b>",
        "<template>",
        "<div class=\"byline\">",
    ] {
        let run = scrape_on_small_stack(format!("<title>Deep</title>{}x", open.repeat(200_000)));
        assert_eq!(run.result, Err(MetascrapeError::TooDeep), "{open}");
        let bound = (MAX_DEPTH + FEED_CHUNK + 8) * (MAX_DEPTH + 2);
        assert!(
            run.parse_steps <= bound,
            "{open}: {} steps",
            run.parse_steps
        );
    }
}

/// The adoption agency moves a block's children under a new, still detached element: each
/// `<b><div>x9</b>` cycle nests about 10 levels deeper while an element's depth when it was
/// created stays small. Depth counted from the parent links at each attach stops it.
#[test]
fn moved_subtrees_still_stop_at_the_depth_cap_on_a_small_stack() {
    let cycle = format!("<b>{}</b>", "<div>".repeat(9));
    let read = (MAX_DEPTH / 9 + 1) * cycle.len() + FEED_CHUNK;
    let run = scrape_on_small_stack(cycle.repeat(40_000));
    assert_eq!(run.result, Err(MetascrapeError::TooDeep));
    let bound = 2 * read * (MAX_DEPTH + 2);
    assert!(run.parse_steps <= bound, "{} steps", run.parse_steps);
}

/// JSON-LD nested past the JSON parser's depth reads as no item, on a small stack.
#[test]
fn deep_json_ld_reads_as_nothing_on_a_small_stack() {
    for (open, close) in [("[", "]"), ("{\"a\":", "}"), ("[", "")] {
        let json = format!("{}1{}", open.repeat(200_000), close.repeat(200_000));
        let html =
            format!("<title>Deep</title><script type=\"application/ld+json\">{json}</script>");
        let run = scrape_on_small_stack(html);
        assert_eq!(run.result.expect(open).title.as_deref(), Some("Deep"));
    }
}

/// For the node budget: the wall-clock deadline must never be the cap that trips, however loaded
/// the host. `an_attribute_flood_stops_at_the_deadline` tests the deadline.
const NO_DEADLINE: Duration = Duration::MAX;

/// Formatting reconstruction clones every open formatting element for each run of text: 500
/// distinct `<b>` closed by `</div>` and then 20,000 paragraphs ask for 10 million elements from
/// 170 KB. The budget stops the parse at the budget: past it the sink builds nothing.
#[test]
fn formatting_reconstruction_stops_at_the_node_budget() {
    let mut html = String::from("<div>");
    for i in 0..500 {
        html.push_str(&format!("<b id={i}>"));
    }
    html.push_str("</div>");
    html.push_str(&"<p>x</p>".repeat(20_000));
    let budget = 2 * html.len() + 64;
    let caps = Caps {
        max_depth: MAX_DEPTH,
        max_nodes: budget,
        deadline: NO_DEADLINE,
    };
    match parse_page(&html, caps) {
        Err(hit) => assert_eq!(hit, CapHit::TooManyNodes),
        Ok((_, steps)) => panic!("parsed in {steps} steps"),
    }
}

/// The node budget leaves an ordinary page alone and counts each node once.
#[test]
fn an_ordinary_page_parses_within_its_budget() {
    let html = "<div><p>a <b>b</b> <a href=\"/x\">c</a></p></div>".repeat(5_000);
    let caps = Caps {
        max_depth: MAX_DEPTH,
        max_nodes: 2 * html.len() + 64,
        deadline: NO_DEADLINE,
    };
    let (_, steps) = parse_page(&html, caps).expect("parse");
    assert!(steps <= 10 * html.len(), "{steps} steps");
}

/// One tag with 400,000 distinct attributes builds one node, while html5ever compares each
/// attribute with every earlier one: 8 * 10^10 comparisons. The deadline stops it.
#[test]
fn an_attribute_flood_stops_at_the_deadline() {
    let mut html = String::from("<p ");
    for i in 0..400_000_u32 {
        for place in [17_576, 676, 26, 1] {
            html.push(char::from(b'a' + (i / place % 26) as u8));
        }
        html.push(' ');
    }
    html.push('>');
    let caps = Caps {
        max_depth: MAX_DEPTH,
        max_nodes: 2 * html.len() + 64,
        deadline: Duration::from_secs(1),
    };
    assert!(matches!(parse_page(&html, caps), Err(CapHit::TooSlow)));
}

/// The author rule's `$filter` over nested `.byline` elements reads each one's text and rejects
/// a text that is a date. Every byline here reads as the one date below 20,000 blank elements:
/// cheerio walks the subtree below each match, which is quadratic.
/// Here the byline matches cost at most the text budget (16 visits per node) more than the same
/// page without the class.
#[test]
fn nested_bylines_read_text_within_the_budget() {
    let page = |class: &str| {
        let depth = MAX_DEPTH - 8;
        let leaves = format!("{}March 4, 2024", "<i> </i>".repeat(20_000));
        let open = format!("<div class=\"{class}\">").repeat(depth);
        format!("<title>T</title>{open}{leaves}{}", "</div>".repeat(depth))
    };
    let plain = scrape_on_small_stack(page("plain"));
    let byline = scrape_on_small_stack(page("byline"));
    assert!(byline.result.is_ok() && plain.result.is_ok());
    let nodes = 2 * 20_000 + MAX_DEPTH;
    assert!(
        byline.steps <= plain.steps + 16 * nodes + 4 * MAX_DEPTH,
        "{} steps, {} without bylines",
        byline.steps,
        plain.steps
    );
}

/// The largest field a page of `len` bytes may give.
#[test]
fn a_huge_title_stays_within_the_output_bound() {
    let title = "it's \"quoted\" ".repeat(50_000);
    let html = format!("<meta property=\"og:title\" content=\"{title}\"><title>{title}</title>");
    let meta = scrape(&html).result.expect("scrape");
    for field in fields(&meta).into_iter().flatten() {
        assert!(field.len() <= output_bound(html.len() + URL.len()));
    }
    assert!(meta.title.is_some());
}

const FRAGMENTS: &[&str] = &[
    "<title>",
    "</title>",
    "<meta property=\"og:title\" content=\"",
    "<meta property=\"og:image\" content=\"",
    "<meta name=\"author\" content=\"",
    "<meta property=\"article:published_time\" content=\"",
    "\">",
    "<div class=\"byline\">",
    "<div class=\"logo\">",
    "</div>",
    "<script type=\"application/ld+json\">",
    "</script>",
    "{\"@type\":\"Article\",\"author\":{\"name\":",
    "\"@graph\":[",
    "]}",
    "<link rel=\"canonical\" href=\"",
    "<img itemprop=\"logo\" src=\"",
    "<template>",
    "<b id=1>",
    "<p>",
    "2024-03-04T10:00:00Z",
    "March 4, 2024",
    "javascript:alert(1)",
    "data:image/gif;base64,R0lG",
    "/a/../b?x=1#y",
    "'",
    "\"",
    " ",
    "&amp;",
];

fn arb_page() -> impl Strategy<Value = String> {
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
    fn any_page_scrapes_within_the_output_bound(html in arb_page()) {
        let run = scrape(&html);
        let bound = output_bound(html.len() + URL.len());
        if let Ok(meta) = run.result {
            for field in fields(&meta).into_iter().flatten() {
                prop_assert!(field.len() <= bound, "{} bytes, bound {bound}", field.len());
            }
        }
    }
}
