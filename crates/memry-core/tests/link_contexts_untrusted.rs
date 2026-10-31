//! `link_contexts` reads note files from the vault, so it is held to the untrusted-input
//! guards: linear steps, bounded output, and offsets that always name the link. It does not
//! recurse, so it has no depth case.

#![cfg(feature = "markdown")]

use memry_core::markdown::shared::link_contexts::{link_contexts, steps};
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

/// Texts that make a scan that looks ahead from every candidate quadratic.
fn hostile(n: usize, title: &str) -> Vec<(&'static str, String)> {
    vec![
        ("open brackets", "[".repeat(n)),
        (
            "unclosed aliases",
            format!("[[{title}|").repeat(n / (title.len() + 3)),
        ),
        (
            "near titles",
            format!("[[{}", &title[..title.len() - 1]).repeat(n / title.len()),
        ),
        (
            "links",
            format!("[[{title}]]").repeat(n / (title.len() + 4)),
        ),
    ]
}

#[test]
fn every_scan_is_linear_in_the_text_times_the_title() {
    on_small_stack(|| {
        let title = "a".repeat(40);
        for (what, text) in hostile(200_000, &title) {
            assert_steps_at_most(what, steps, (title.len() + 4) * text.len() + 10, || {
                link_contexts(&text, &title);
            });
        }
    });
}

#[test]
fn dense_links_stop_at_the_output_bound() {
    let text = "[[a]]".repeat(10_000);
    let total: usize = link_contexts(&text, "a")
        .iter()
        .map(|c| c.snippet.len())
        .sum();
    assert_output_bounded("dense links", text.len(), total);
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

proptest! {
    #![proptest_config(proptest_config(memry_test_kit::DEFAULT_CASES))]

    #[test]
    fn offsets_name_the_link_and_output_stays_bounded(
        parts in prop::collection::vec(
            prop_oneof![
                Just("[[Plan]]".to_owned()),
                Just("[[pLAN|x\ny]]".to_owned()),
                Just("[[Plan|".to_owned()),
                Just("]".to_owned()),
                Just("\n".to_owned()),
                Just(" ".to_owned()),
                "[a-zé😀\\[\\]|]{0,12}",
            ],
            0..60,
        )
    ) {
        let text = parts.concat();
        let found = link_contexts(&text, "Plan");
        let total: usize = found.iter().map(|c| c.snippet.len()).sum();
        prop_assert!(total <= output_bound(text.len()));
        for context in found {
            let units = utf16(&context.snippet);
            prop_assert!(context.link_start <= context.link_end);
            prop_assert!(context.link_end <= units.len());
            let link = String::from_utf16(&units[context.link_start..context.link_end]);
            prop_assert!(link.is_ok());
            let link = link.unwrap_or_default().to_lowercase();
            prop_assert!(link.starts_with("[[plan") && link.ends_with("]]"), "{link}");
        }
    }
}
