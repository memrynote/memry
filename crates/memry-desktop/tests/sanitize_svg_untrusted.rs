//! `vault::svg` reads icon bytes a peer synced, so it holds the untrusted-input guards: no
//! recursion a deep document can overflow, work linear in the input (counted in steps, never
//! timed), output within the kit's bound, and properties over arbitrary input.
//!
//! Each hostile input below makes one pass of the TypeScript, or of a naive port, scan the rest
//! of the document once per opener: quadratic. The step bound is linear, so a pass that loses
//! its stop rule or its memo fails here by an order of magnitude.

use memry_desktop::vault::svg::{
    MAX_SVG_BYTES, SvgRefused, sanitize_svg, sanitize_svg_bytes, steps,
};
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

/// Steps per input byte the whole pipeline may take: about 30 passes, each visiting a byte a
/// few times, the longest literal compared at one position (13 bytes), and the inert writer.
const STEPS_PER_BYTE: usize = 200;

fn step_bound(input: &str) -> usize {
    STEPS_PER_BYTE * input.len() + 1000
}

fn assert_linear(what: &'static str, input: String) {
    let bound = step_bound(&input);
    on_small_stack(move || {
        assert_steps_at_most(what, steps, bound, || {
            let _ = sanitize_svg(&input);
        });
    });
}

const REPEATS: usize = 4000;

#[test]
fn an_open_doctype_subset_repeated_is_linear() {
    assert_linear(
        "doctype",
        format!("<svg>{}]", "<!DOCTYPE[>".repeat(REPEATS)),
    );
}

#[test]
fn openers_whose_first_gt_is_not_self_closing_are_linear() {
    assert_linear(
        "self-closing",
        format!("<svg>{}>", "<script ".repeat(REPEATS)),
    );
}

#[test]
fn openers_with_no_closer_are_linear() {
    for tag in ["script", "style", "iframe"] {
        assert_linear(tag, format!("<svg>{}", format!("<{tag}>x").repeat(REPEATS)));
    }
}

#[test]
fn stray_closers_with_no_gt_are_linear() {
    assert_linear(
        "stray closer",
        format!("<svg>{}", "</object ".repeat(REPEATS)),
    );
}

#[test]
fn unterminated_comments_and_declarations_are_linear() {
    for opener in ["<!--", "<!ENTITY", "<?", "<![CDATA["] {
        assert_linear(opener, format!("<svg>{}", opener.repeat(REPEATS)));
    }
}

#[test]
fn a_name_run_with_no_gt_is_linear() {
    assert_linear("name run", format!("<svg>{}", "<a".repeat(REPEATS)));
    assert_linear(
        "quoted name run",
        format!("<svg>{}", "<a\"".repeat(REPEATS)),
    );
}

#[test]
fn many_attributes_and_style_urls_are_linear() {
    let attrs = "a=\"x\" attributeName=\"to\" style=\"fill:url(#a)\" ".repeat(REPEATS);
    assert_linear("attributes", format!("<svg {attrs}/>"));
}

#[test]
fn a_deep_document_does_not_overflow_a_small_stack() {
    let depth = 200_000;
    let svg = format!("<svg>{}{}</svg>", "<g>".repeat(depth), "</g>".repeat(depth));
    let out = on_small_stack(move || sanitize_svg(&svg));
    assert!(out.is_some_and(|out| out.starts_with("<svg><g><g>")));
}

#[test]
fn text_lt_written_as_entities_stays_within_the_output_bound() {
    let input = format!("<svg>{}</svg>", "<".repeat(10_000));
    let out = sanitize_svg(&input).expect("svg root");
    assert!(out.contains("&lt;&lt;"));
    assert_output_bounded("lt", input.len(), out.len());
}

#[test]
fn input_over_the_cap_is_refused_and_at_the_cap_is_read() {
    let at_cap = format!("<svg>{}", " ".repeat(MAX_SVG_BYTES - 5));
    assert_eq!(at_cap.len(), MAX_SVG_BYTES);
    assert!(sanitize_svg_bytes(at_cap.as_bytes()).is_ok());
    let over = format!("{at_cap} ");
    assert_eq!(
        sanitize_svg_bytes(over.as_bytes()),
        Err(SvgRefused::TooLarge { bytes: over.len() })
    );
    assert_eq!(sanitize_svg(&over), None);
}

/// Pieces of every construct the passes look for, so random input reaches each branch.
const PIECES: &[&str] = &[
    "<",
    ">",
    "/",
    "\"",
    "'",
    "=",
    " ",
    "\n",
    "\u{a0}",
    "#",
    ":",
    "[",
    "]",
    "!",
    "?",
    "-",
    "<!--",
    "-->",
    "<!DOCTYPE",
    "<!ENTITY",
    "<?",
    "?>",
    "<![CDATA[",
    "]]>",
    "<svg",
    "svg:",
    "<script",
    "</script",
    "<foreignObject",
    "<style",
    "</style",
    "<a",
    "<animate",
    "attributeName",
    "href",
    "on",
    "url(",
    "#",
    "javascript:",
    "@import",
    "x",
    "\u{1F600}",
];

fn soup() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(PIECES), 0..80).prop_map(|pieces| pieces.concat())
}

proptest! {
    #![proptest_config(proptest_config(512))]

    #[test]
    fn any_soup_is_bounded_in_output_and_steps(input in soup()) {
        let before = steps();
        let out = sanitize_svg(&input);
        let taken = steps() - before;
        prop_assert!(taken <= step_bound(&input), "{} steps for {} chars", taken, input.len());
        if let Some(out) = out {
            prop_assert!(out.len() <= output_bound(input.len()));
            prop_assert!(out.to_lowercase().contains("svg"));
        }
    }

    #[test]
    fn any_bytes_are_read_without_a_panic(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
        if let Ok(out) = sanitize_svg_bytes(&bytes) {
            // Malformed UTF-8 grows to U+FFFD (3 bytes) before the bound applies.
            prop_assert!(out.len() <= output_bound(3 * bytes.len()));
            prop_assert!(std::str::from_utf8(&out).is_ok());
        }
    }
}
