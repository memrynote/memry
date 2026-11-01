//! `mention_mask` reads note files from the vault, so it is held to the untrusted-input
//! guards: linear steps, bounded output, and offsets that always name a mention in the text.
//! It does not recurse, so it has no depth case.

#![cfg(feature = "markdown")]

use memry_core::markdown::shared::mention_mask::{
    find_unlinked_mentions, link_unlinked_mention, mention_contexts, steps,
};
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

/// Texts that make a mask that looks ahead from every candidate quadratic.
fn hostile(n: usize) -> Vec<(&'static str, String)> {
    vec![
        ("open brackets", "[".repeat(n)),
        ("open wiki links", "[[a".repeat(n / 3)),
        ("unclosed link targets", "[a](b".repeat(n / 5)),
        ("link labels", format!("[{}", "a".repeat(n))),
        ("schemes", "a+".repeat(n / 2)),
        ("one url", format!("a://{}", "b".repeat(n))),
        ("bang brackets", "![".repeat(n / 2)),
    ]
}

fn names() -> Vec<String> {
    vec!["Plan".to_owned()]
}

#[test]
fn the_mask_is_linear_in_the_text() {
    on_small_stack(|| {
        for (what, text) in hostile(200_000) {
            assert_steps_at_most(what, steps, 2 * text.len() + 10, || {
                find_unlinked_mentions(&text, &names());
            });
        }
    });
}

#[test]
fn dense_mentions_stop_at_the_output_bound_and_still_count_every_one() {
    let text = "plan ".repeat(10_000);
    let mentions = find_unlinked_mentions(&text, &names());
    let found = mention_contexts(&text, &mentions);
    let total: usize = found.contexts.iter().map(|c| c.snippet.len()).sum();
    assert_output_bounded("dense mentions", text.len(), total);
    assert_eq!((found.count, found.truncated), (10_000, true));
    assert!(found.contexts.len() < 10_000, "{}", found.contexts.len());
}

fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

proptest! {
    #![proptest_config(proptest_config(memry_test_kit::DEFAULT_CASES))]

    #[test]
    fn offsets_name_a_mention_and_output_stays_bounded(
        parts in prop::collection::vec(
            prop_oneof![
                Just("Plan".to_owned()),
                Just("[[Plan]]".to_owned()),
                Just("`plan`".to_owned()),
                Just("<!-- plan -->".to_owned()),
                Just("https://plan".to_owned()),
                Just("[plan](x)".to_owned()),
                Just("\n".to_owned()),
                Just(" ".to_owned()),
                "[a-zé😀\\[\\]()`!:/ ]{0,12}",
            ],
            0..60,
        )
    ) {
        let text = parts.concat();
        let mentions = find_unlinked_mentions(&text, &names());
        for mention in &mentions {
            prop_assert_eq!(&text[mention.start..mention.end], mention.text.as_str());
            prop_assert_eq!(mention.text.to_lowercase(), "plan");
        }
        let found = mention_contexts(&text, &mentions);
        prop_assert_eq!(found.count, mentions.len());
        prop_assert_eq!(found.truncated, found.contexts.len() < mentions.len());
        let contexts = found.contexts;
        let total: usize = contexts.iter().map(|c| c.snippet.len()).sum();
        prop_assert!(total <= output_bound(text.len()));
        for (context, mention) in contexts.iter().zip(&mentions) {
            let units = utf16(&context.snippet);
            prop_assert!(context.link_end <= units.len());
            let shown = String::from_utf16(&units[context.link_start..context.link_end]);
            prop_assert_eq!(shown.ok(), Some(mention.text.clone()));
        }
        if let Some(first) = mentions.first() {
            let linked = link_unlinked_mention(&text, &names(), 0, "Plan");
            let expected = format!(
                "{}{}{}",
                &text[..first.start],
                if first.text == "Plan" { "[[Plan]]".to_owned() } else { format!("[[Plan|{}]]", first.text) },
                &text[first.end..]
            );
            prop_assert_eq!(linked, Some(expected));
        }
    }
}
