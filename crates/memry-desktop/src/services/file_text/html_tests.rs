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
        if case.name == "select with non-option content" {
            // Known divergence (module doc): the current spec keeps elements inside `select`.
            assert_eq!(case.text, "oneblockboldtextafter");
            assert_eq!(
                read_html_text(case.html.as_bytes()).as_deref(),
                Ok("one\n\nblock\n\nboldtextafter")
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
/// 10^10 scans inside html5ever. The cap stops the parse a chunk past `MAX_DEPTH`; the sink
/// creates at most one node per byte of what it read, and each attach follows at most
/// `MAX_DEPTH + 1` parent links. A template's contents nest one level below the template.
#[test]
fn deeper_nesting_stops_at_the_depth_cap_on_a_small_stack() {
    for open in ["<div>", "<span>", "<b>", "<code>", "<template>"] {
        let html = format!("{}deep", open.repeat(100_000));
        let (result, steps) = on_small_stack(move || {
            let before = html_steps();
            let result = read_html_text(html.as_bytes());
            (result, html_steps() - before)
        });
        assert_eq!(result, Err(HtmlTextError::TooDeep), "{open}");
        assert!(
            steps <= (MAX_DEPTH + FEED_CHUNK + 8) * (MAX_DEPTH + 3),
            "{open}: {steps} steps"
        );
    }
}

/// The adoption agency moves a block's children under a new, still detached element, and the
/// tree keeps growing below them: each `<b><div>x9</b>` cycle nests about 10 levels deeper while
/// an element's depth counted when it was first attached stays near 12. Unchecked, 40,000
/// cycles build a 400,000-entry stack of open elements that html5ever scans for every `div`.
/// Depth counted from the parent links stops it within `MAX_DEPTH / 9` cycles and a chunk.
#[test]
fn moved_subtrees_still_stop_at_the_depth_cap_on_a_small_stack() {
    let cycle = format!("<b>{}</b>", "<div>".repeat(9));
    let html = cycle.repeat(40_000);
    let read = (MAX_DEPTH / 9 + 1) * cycle.len() + FEED_CHUNK;
    let (result, steps) = on_small_stack(move || {
        let before = html_steps();
        let result = read_html_text(html.as_bytes());
        (result, html_steps() - before)
    });
    assert_eq!(result, Err(HtmlTextError::TooDeep));
    assert!(
        steps <= 2 * read * (MAX_DEPTH + 3),
        "{steps} steps for {read} bytes"
    );
}

/// The largest node arena a file may ask for, before any text: 128 MiB.
#[test]
fn the_largest_tree_fits_in_128_mib() {
    assert!(size_of::<Node>() <= 32, "{} bytes", size_of::<Node>());
    assert!(size_of::<Node>() * node_budget(HTML_TEXT_MAX_BYTES) <= 128 << 20);
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
    assert!(html.len() <= HTML_TEXT_MAX_BYTES);
    let result = parse(&html, node_budget(html.len()), Duration::from_secs(1));
    assert!(matches!(result, Err(HtmlTextError::TooSlow)));
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
/// most one element is cloned per 16 bytes of the chunk for each byte of input. Each node within
/// the budget follows at most `MAX_DEPTH + 1` parent links when it is attached.
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
        node_budget(len) * (MAX_DEPTH + 3) + FEED_CHUNK * len / 16,
        || result = Some(read_html_text(html.as_bytes())),
    );
    assert_eq!(
        result,
        Some(Err(HtmlTextError::TooManyNodes {
            limit: node_budget(len)
        }))
    );
}

/// The budget counts the file's bytes: each invalid byte decodes to a 3-byte U+FFFD, so a
/// budget taken from the decoded text would triple.
#[test]
fn the_node_budget_counts_bytes_not_decoded_text() {
    let mut html = b"<!--".to_vec();
    html.resize(100_000, 0xff);
    html.extend_from_slice(b"--><div>");
    for i in 0..500 {
        html.extend_from_slice(format!("<b id={i}>").as_bytes());
    }
    html.extend_from_slice(b"</div>");
    html.extend_from_slice("<p>x</p>".repeat(20_000).as_bytes());
    assert_eq!(
        read_html_text(&html),
        Err(HtmlTextError::TooManyNodes {
            limit: node_budget(html.len())
        })
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
