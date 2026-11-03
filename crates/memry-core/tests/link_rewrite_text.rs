//! `rewrite_text`, desktop's inbound link repair over a whole vault file: the cases of
//! `packages/shared/src/rewrite-wiki-links.test.ts`, and the untrusted-input guards (the file is
//! the user's): linear steps, output bounded by the new name per link, and links found exactly
//! where the reference's regular expression finds them. It does not recurse, so it has no depth
//! case.

use memry_core::api::errors::StorageError;
use memry_core::domain::notes::link_rewrite::{LinkNames, rewrite_text, text_steps};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;

fn names(title: &str, folder: Option<&str>) -> LinkNames {
    LinkNames {
        title: title.to_owned(),
        folder: folder.map(str::to_owned),
        markdown: true,
    }
}

/// A rename inside `Notes/`, as the reference's tests make it.
fn rename(body: &str, from: &str, to: &str, other: fn(&str) -> bool) -> Option<String> {
    let (from, to) = (names(from, Some("Notes")), names(to, Some("Notes")));
    rewrite_text(body, "renamed", &from, &to, |title| Ok(other(title))).unwrap()
}

fn no_other(_: &str) -> bool {
    false
}

#[test]
fn the_reference_cases() {
    let r = |body: &str, from: &str, to: &str| rename(body, from, to, no_other);
    assert_eq!(
        r(
            "See [[Old Title]] and [[Other Note]].",
            "Old Title",
            "New Title"
        )
        .as_deref(),
        Some("See [[New Title]] and [[Other Note]].")
    );
    assert_eq!(r("See [[Other Note]].", "Old Title", "New Title"), None);
    assert_eq!(r("no links here", "Old Title", "New Title"), None);
    assert_eq!(r("", "Old Title", "New Title"), None);
    assert_eq!(r("[[Same]]", "Same", "Same"), None);
    assert_eq!(
        r("[[old title]] and [[OLD TITLE]]", "Old Title", "New").as_deref(),
        Some("[[New]] and [[New]]")
    );
    assert_eq!(
        r("[[old title]]", "old title", "Old Title").as_deref(),
        Some("[[Old Title]]")
    );
    assert_eq!(
        r("[[Old|my label]]", "Old", "New").as_deref(),
        Some("[[New|my label]]")
    );
    assert_eq!(
        r("[[Old#Heading]]", "Old", "New").as_deref(),
        Some("[[New#Heading]]")
    );
    assert_eq!(
        r("[[Old#H1#H2]]", "Old", "New").as_deref(),
        Some("[[New#H1#H2]]")
    );
    assert_eq!(
        r("[[Old#Heading|label]]", "Old", "New").as_deref(),
        Some("[[New#Heading|label]]")
    );
    assert_eq!(r("[[#Heading]]", "#Heading", "New"), None);
    assert_eq!(
        r("[[Sprint #4]]", "Sprint #4", "Sprint Four").as_deref(),
        Some("[[Sprint Four]]")
    );
    assert_eq!(
        r("[[Old#Notes]] and [[Old]]", "Old", "New").as_deref(),
        Some("[[New#Notes]] and [[New]]")
    );
    assert_eq!(r("[[ Old ]]", "Old", "New").as_deref(), Some("[[New]]"));
    assert_eq!(
        r(
            "[[Notes/Old]] [[/notes/old#H|label]] [[Other/Old]] [[Old]]",
            "Old",
            "New"
        )
        .as_deref(),
        Some("[[Notes/New]] [[/Notes/New#H|label]] [[Other/Old]] [[New]]")
    );
    let card = "<!-- link-card:{\"size\":\"medium\",\"cover\":true,\"preview\":true} -->";
    assert_eq!(
        r(
            &format!("{card}\n[[Old Title]]\n\nNext [[Old Title]]"),
            "Old Title",
            "New Title"
        ),
        Some(format!("{card}\n[[New Title]]\n\nNext [[New Title]]"))
    );
    assert_eq!(
        r(
            "<!-- link-card:{\"size\":\"small\"} -->\n[[Old Title|the sequel]]",
            "Old Title",
            "New Title"
        )
        .as_deref(),
        Some("<!-- link-card:{\"size\":\"small\"} -->\n[[New Title|the sequel]]")
    );
}

#[test]
fn a_hash_title_is_left_alone_when_split_resolution_wins() {
    let sprint = |title: &str| title == "Sprint";
    assert_eq!(
        rename("[[Sprint #4]]", "Sprint #4", "Sprint Four", sprint),
        None
    );
}

#[test]
fn a_move_rewrites_only_path_links() {
    let (from, to) = (names("Plan", Some("A")), names("Plan", Some("B/C")));
    let moved = |body: &str| rewrite_text(body, "renamed", &from, &to, |_| Ok(false)).unwrap();
    assert_eq!(
        moved("[[A/Plan#Goals|g]] and [[Plan]] and [[A/Planner]]").as_deref(),
        Some("[[B/C/Plan#Goals|g]] and [[Plan]] and [[A/Planner]]")
    );
    assert_eq!(moved("[[Plan]] only"), None);
}

#[test]
fn frontmatter_links_follow_and_a_failed_lookup_fails_the_file() {
    let text = "---\nrelated: \"[[Old]]\"\n---\nBody [[Old#H]].\n";
    assert_eq!(
        rename(text, "Old", "New", no_other).as_deref(),
        Some("---\nrelated: \"[[New]]\"\n---\nBody [[New#H]].\n")
    );
    let (from, to) = (names("Sprint #4", None), names("Sprint 5", None));
    let failed = rewrite_text("[[Sprint #4]]", "renamed", &from, &to, |_| {
        Err(StorageError::Failed {
            what: "the names".into(),
        })
    });
    assert!(failed.is_err());
}

/// Texts that make a scan that looks ahead from every candidate quadratic.
fn hostile(n: usize) -> Vec<(&'static str, String)> {
    vec![
        ("open brackets", "[".repeat(n)),
        ("an unclosed link", format!("[[{}", "a".repeat(n))),
        ("unclosed aliases", "[[a|b".repeat(n / 5)),
        ("aliases closed once", "[[a|b]".repeat(n / 6)),
        ("single closes", "[[a]".repeat(n / 4)),
        ("empty aliases", "[[a|]]".repeat(n / 6)),
        ("links", "[[Plan]]".repeat(n / 8)),
    ]
}

#[test]
fn every_scan_is_linear_in_the_text() {
    on_small_stack(|| {
        let (from, to) = (names("Plan", None), names("Roadmap", None));
        for (what, text) in hostile(200_000) {
            assert_steps_at_most(what, text_steps, 2 * text.len() + 10, || {
                rewrite_text(&text, "renamed", &from, &to, |_| Ok(false)).unwrap();
            });
        }
    });
}

/// The reference's links: `\[\[([^\]|]+)(\|[^\]]+)?\]\]`, leftmost first, a match resumes after
/// itself and a failed one one byte on (`[` is ASCII, so a byte is a character there). Each is
/// `(start, end, target, alias)`.
fn reference_links(text: &str) -> Vec<(usize, usize, &str, &str)> {
    let b = text.as_bytes();
    let until = |from: usize, stops: &[u8]| {
        (from..b.len())
            .find(|&i| stops.contains(&b[i]))
            .unwrap_or(b.len())
    };
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let found = b[i..].starts_with(b"[[").then(|| {
            let start = i + 2;
            let stop = until(start, b"]|");
            if stop == start || stop == b.len() {
                return None;
            }
            let (close, alias) = if b[stop] == b']' {
                (stop, "")
            } else {
                let close = until(stop + 1, b"]");
                if close == stop + 1 || close == b.len() {
                    return None;
                }
                (close, &text[stop..close])
            };
            (b.get(close + 1) == Some(&b']')).then(|| (i, close + 2, &text[start..stop], alias))
        });
        match found.flatten() {
            Some(link) => {
                i = link.1;
                out.push(link);
            }
            None => i += 1,
        }
    }
    out
}

/// The reference's decision for `Plan` renamed `Roadmap` at the root, for targets with no `/`.
fn reference_rewrite(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut copied = 0;
    for (start, end, target, alias) in reference_links(text) {
        let raw = target.trim();
        let (note, suffix) = raw
            .find('#')
            .map_or((raw, ""), |at| (&raw[..at], &raw[at..]));
        if note.trim().to_lowercase() == "plan" {
            out.push_str(&text[copied..start]);
            out.push_str(&format!("[[Roadmap{suffix}{alias}]]"));
            copied = end;
        }
    }
    (copied > 0).then(|| out + &text[copied..])
}

proptest! {
    #![proptest_config(proptest_config(memry_test_kit::DEFAULT_CASES))]

    #[test]
    fn links_are_the_references_and_output_grows_by_the_name(
        parts in prop::collection::vec(
            prop_oneof![
                Just("[[Plan]]".to_owned()),
                Just("[[pLAN|x\ny]]".to_owned()),
                Just("[[Plan#H]]".to_owned()),
                Just("[[ plan |".to_owned()),
                Just("[[Other]]".to_owned()),
                Just("[[".to_owned()),
                Just("]".to_owned()),
                Just("|".to_owned()),
                "[a-zPé😀 \\[\\]|]{0,12}",
            ],
            0..60,
        )
    ) {
        let text = parts.concat();
        let (from, to) = (names("Plan", None), names("Roadmap", None));
        let out = rewrite_text(&text, "renamed", &from, &to, |_| Ok(false)).unwrap();
        prop_assert_eq!(&out, &reference_rewrite(&text));
        let links = reference_links(&text).len();
        let grown = out.map_or(text.len(), |out| out.len());
        prop_assert!(grown <= text.len() + links * "Roadmap".len());
    }
}
