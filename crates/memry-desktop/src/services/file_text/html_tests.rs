use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;
use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
struct Vectors {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    html: String,
    text: String,
}

/// `html-text.json`: Electron's `readHtmlText` run in place
/// (`apps/desktop/scripts/html-text-oracle`).
#[test]
fn reads_every_vector_as_electron_does() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/contracts/test-vectors/html-text.json"
    );
    let vectors: Vectors =
        serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("parse");
    assert!(vectors.cases.len() >= 20);
    for case in vectors.cases {
        if case.name == "table foster parenting" {
            // Known divergence (module doc): the spec puts foster-parented text before the table.
            assert_eq!(case.text, "cell\n\nloose");
            assert_eq!(
                read_html_text(case.html.as_bytes()).as_deref(),
                Ok("loose\n\ncell")
            );
            continue;
        }
        assert_eq!(
            read_html_text(case.html.as_bytes()).as_deref(),
            Ok(case.text.as_str()),
            "{}",
            case.name
        );
    }
}

#[test]
fn invalid_utf8_reads_as_replacement_characters() {
    assert_eq!(
        read_html_text(b"<p>a\xffb</p>").as_deref(),
        Ok("a\u{fffd}b")
    );
}

#[test]
fn a_file_over_the_cap_is_refused_and_one_at_the_cap_is_read() {
    let mut at_cap = b"<p>".to_vec();
    at_cap.resize(HTML_TEXT_MAX_BYTES, b'w');
    assert_eq!(
        read_html_text(&at_cap).map(|text| text.len()),
        Ok(HTML_TEXT_MAX_BYTES - 3)
    );
    at_cap.push(b'w');
    assert_eq!(
        read_html_text(&at_cap),
        Err(HtmlTextError::TooLarge {
            size: HTML_TEXT_MAX_BYTES + 1
        })
    );
}

/// `html`, `body` and the text take three of the `MAX_DEPTH` levels.
#[test]
fn nesting_reads_up_to_the_depth_cap_on_a_small_stack() {
    for (open, close) in [
        ("<div>", "</div>"),
        ("<span>", "</span>"),
        ("<code>", "</code>"),
    ] {
        let depth = MAX_DEPTH - 3;
        let html = format!("{}deep{}", open.repeat(depth), close.repeat(depth));
        let text = on_small_stack(move || read_html_text(html.as_bytes()));
        assert!(text.expect("read").contains("deep"), "{open}");
    }
}

/// The tree builder scans its open elements for most tags, so 100,000 nested elements cost
/// 10^10 scans inside html5ever. The cap stops the parse a chunk past `MAX_DEPTH`, and the
/// sink creates at most one node per byte of what it read.
#[test]
fn deeper_nesting_stops_at_the_depth_cap_on_a_small_stack() {
    for open in ["<div>", "<span>", "<b>", "<code>"] {
        let html = format!("{}deep", open.repeat(100_000));
        let (result, steps) = on_small_stack(move || {
            let before = html_steps();
            let result = read_html_text(html.as_bytes());
            (result, html_steps() - before)
        });
        assert_eq!(result, Err(HtmlTextError::TooDeep), "{open}");
        assert!(steps <= MAX_DEPTH + FEED_CHUNK + 8, "{open}: {steps} nodes");
    }
}

/// The walk visits each node once and the code walk once more at most.
#[test]
fn the_walk_is_linear_in_the_nodes() {
    let html = "<div><p>a <b>b</b> <code>c<br>d</code></p><pre>e</pre></div>".repeat(5_000);
    assert_steps_at_most("html walk", html_steps, 3 * node_budget(html.len()), || {
        read_html_text(html.as_bytes()).expect("read");
    });
}

/// Formatting reconstruction clones every open formatting element for each run of text:
/// 500 distinct `<b>` closed by `</div>` and then 20,000 paragraphs ask for 10 million
/// elements from 170 KB. The budget stops the parse within one chunk of the budget, where at
/// most one element is cloned per 16 bytes of the chunk for each byte of input.
#[test]
fn formatting_reconstruction_stops_at_the_node_budget() {
    let mut html = String::from("<div>");
    for i in 0..500 {
        html.push_str(&format!("<b id={i}>"));
    }
    html.push_str("</div>");
    html.push_str(&"<p>x</p>".repeat(20_000));
    let len = html.len();
    let mut result = None;
    assert_steps_at_most(
        "formatting reconstruction",
        html_steps,
        2 * node_budget(len) + FEED_CHUNK * len / 16,
        || result = Some(read_html_text(html.as_bytes())),
    );
    assert_eq!(
        result,
        Some(Err(HtmlTextError::TooManyNodes {
            limit: node_budget(len)
        }))
    );
}

fn html_like() -> impl Strategy<Value = String> {
    let piece = prop_oneof![
        Just("<p>".to_owned()),
        Just("</p>".to_owned()),
        Just("<b>".to_owned()),
        Just("</b>".to_owned()),
        Just("<table>".to_owned()),
        Just("<td>".to_owned()),
        Just("<pre>".to_owned()),
        Just("<code>".to_owned()),
        Just("</code>".to_owned()),
        Just("<br>".to_owned()),
        Just("<script>".to_owned()),
        Just("<template>".to_owned()),
        Just("<svg>".to_owned()),
        Just("<math><annotation-xml encoding=\"text/html\">".to_owned()),
        Just("<!--".to_owned()),
        Just("`".to_owned()),
        Just("\n".to_owned()),
        "[a-z &;<>/\"=]{0,8}",
    ];
    prop::collection::vec(piece, 0..64).prop_map(|pieces| pieces.concat())
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn any_html_reads_within_the_output_bound(html in html_like()) {
        let text = read_html_text(html.as_bytes()).expect("small input stays within budget");
        prop_assert!(text.len() <= output_bound(html.len()));
    }

    #[test]
    fn any_bytes_read_without_panicking(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
        if let Ok(text) = read_html_text(&bytes) {
            assert_output_bounded("html bytes", bytes.len(), text.len());
        }
    }
}
