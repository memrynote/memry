//! A save reads the `#tags` of the note's old and new bodies and the header tags of its file,
//! all vault data, so the header tag edit is held to the untrusted-input guards: folds linear
//! in the tags (a pairwise compare folds quadratically many times), a tag list no larger than
//! the text it came from, and no panic on any text. Nothing here recurses, so there is no
//! depth case.

#![cfg(feature = "markdown")]

use std::collections::HashSet;

use memry_core::domain::body_tags;
use memry_core::domain::header_tags::{self, Existing, Update, compare};
use memry_core::domain::tags::folds;
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

const N: usize = 20_000;

fn distinct(prefix: &str) -> Vec<String> {
    (0..N).map(|at| format!("{prefix}{at}")).collect()
}

fn body(tags: &[String]) -> String {
    tags.iter().map(|tag| format!("#{tag} ")).collect()
}

#[test]
fn a_save_folds_linearly_in_the_tags() {
    on_small_stack(|| {
        let header = distinct("h");
        let (old, new) = (distinct("o"), distinct("n"));
        let (old_body, new_body) = (body(&old), body(&new));
        let same = body(&vec!["Same".to_owned(); N]);
        let mut list = distinct("n");
        list.extend(header.iter().take(N / 2).cloned());
        let none = HashSet::new();
        let bound = 16 * 3 * N + 64;

        let cases: [(&str, Update<'_>, &str); 3] = [
            (
                "a body that swaps every tag",
                Update {
                    content: Some(&new_body),
                    ..Update::default()
                },
                &old_body,
            ),
            (
                "one tag spelled again and again",
                Update {
                    content: Some(&same),
                    ..Update::default()
                },
                &old_body,
            ),
            (
                "the agent API's whole list",
                Update {
                    tags: Some(&list),
                    content: Some(&new_body),
                    ..Update::default()
                },
                &old_body,
            ),
        ];
        for (what, update, content) in cases {
            let existing = Existing {
                header_tags: &header,
                content,
            };
            assert_steps_at_most(what, folds, bound, || {
                let next = header_tags::next(&existing, &update, &none);
                compare(&header, &next);
            });
        }
    });
}

#[test]
fn a_body_lists_no_more_than_it_holds() {
    let text = body(&distinct("t"));
    let tags = body_tags::extract_markdown(&text);
    assert_eq!(tags.len(), N);
    let total: usize = tags.iter().map(String::len).sum();
    assert_output_bounded("dense tags", text.len(), total);
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn any_body_adds_its_tags_to_an_empty_header(text in r"(\PC|[#`/ \n\u{85}\u{feff}a-z])*") {
        let tags = body_tags::extract_markdown(&text);
        let total: usize = tags.iter().map(String::len).sum();
        prop_assert!(total <= output_bound(text.len()));
        let existing = Existing { header_tags: &[], content: "" };
        let update = Update { content: Some(&text), ..Update::default() };
        let next = header_tags::next(&existing, &update, &HashSet::new());
        prop_assert_eq!(next, tags);
    }
}
