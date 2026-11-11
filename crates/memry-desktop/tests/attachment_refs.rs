//! The names a note body gives its attachments (`attachments::filenames`, the
//! `extractAttachmentFilenames` of Electron's `attachment-rename-reconcile.ts`), which the
//! reference scan and the rename reconcile read. Bodies are vault files any app or device may
//! have written, so beside Electron's cases this holds the untrusted-input guards: one pass that
//! never goes back (counted in steps), no recursion (a small stack), names within the input's
//! size, and properties over arbitrary text.

use std::collections::BTreeSet;

use memry_desktop::attachments::{filenames, names_file, scan_steps};
use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

const ID: &str = "n1";

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn finds_refs_in_file_markers_image_links_and_legacy_absolute_urls() {
    let markdown = [
        "<!-- file:{\"url\":\"../attachments/n1/k3f9x2-report.pdf\",\"name\":\"x\"} -->",
        "![pic](../attachments/n1/aaaaaa-photo.png)",
        "![old](memry-file://local/Users/someone/Vault/attachments/n1/bbbbbb-legacy.png)",
        "![root](attachments\\n1\\cccccc-win.png)",
    ]
    .join("\n\n");
    assert_eq!(
        filenames(ID, &markdown),
        set(&[
            "k3f9x2-report.pdf",
            "aaaaaa-photo.png",
            "bbbbbb-legacy.png",
            "cccccc-win.png"
        ])
    );
}

#[test]
fn decodes_escapes_and_keeps_a_stray_percent() {
    assert_eq!(
        filenames(ID, "![p](../attachments/n1/aaaaaa-my%20file.png)"),
        set(&["aaaaaa-my file.png"])
    );
    assert_eq!(
        filenames(ID, "![p](../attachments/n1/aaaaaa-100%.png)"),
        set(&["aaaaaa-100%.png"])
    );
}

#[test]
fn ignores_another_notes_attachments_and_ends_names_where_the_regex_does() {
    assert_eq!(
        filenames(ID, "![p](../attachments/other/aaaaaa-photo.png)"),
        set(&[])
    );
    assert_eq!(
        filenames(ID, "![p](../attachments/n10/aaaaaa-photo.png)"),
        set(&[])
    );
    assert_eq!(filenames(ID, "attachments/n1/"), set(&[]));
    // A name runs to `)`, white space, a quote, an angle bracket or a backslash, so it may hold
    // a `/`: the caller decides what a plain name is.
    assert_eq!(
        filenames(ID, "attachments/n1/a/../b.png'x attachments/n1/c\u{a0}d"),
        set(&["a/../b.png", "c"])
    );
}

/// Bytes the scan may look at for `input`: each byte once, plus the id and its separators for
/// every `attachments` it finds.
/// macOS stores a name in whatever Unicode form it was written in and opens it by any other,
/// and ignores case beyond ASCII, so a link in another form or case opens the file (#4204).
#[test]
fn a_ref_in_another_unicode_form_or_case_names_the_file() {
    let nfc = "caf\u{e9}-\u{c5}r.pdf";
    let nfd = "cafe\u{301}-A\u{30a}r.pdf";
    for (file, written) in [
        (nfd, nfc),
        (nfc, nfd),
        ("\u{c9}T\u{c9}.pdf", "\u{e9}t\u{e9}.pdf"),
        ("\u{3a3}\u{3a3}.pdf", "\u{3c3}\u{3c2}.pdf"),
        ("\u{130}stanbul.pdf", "i\u{307}stanbul.pdf"),
        (nfd, "caf%C3%A9-%C3%85r.pdf"),
    ] {
        for body in [
            format!("![a](../attachments/{ID}/{written})"),
            format!("see attachments/{ID}/{written} here"),
        ] {
            assert!(names_file(ID, file, &body), "{file:?} in {body:?}");
        }
    }
    assert!(!names_file(
        ID,
        nfd,
        &format!("attachments/{ID}/cafe-Ar.pdf")
    ));
}

fn bound(input: &str) -> usize {
    2 * input.len() + 64
}

fn assert_linear(what: &'static str, input: String) {
    on_small_stack(move || {
        let mut out = 0;
        assert_steps_at_most(what, scan_steps, bound(&input), || {
            out = filenames(ID, &input).iter().map(String::len).sum();
        });
        assert_output_bounded(what, input.len(), out);
        // The reference scan's match runs the same extractor once, beside its substring
        // searches (linear in std).
        assert_steps_at_most(what, scan_steps, bound(&input), || {
            names_file(ID, "aaaaaa-x.pdf", &input);
        });
    });
}

const REPEATS: usize = 50_000;

#[test]
fn a_run_of_refs_without_an_end_is_scanned_once() {
    // Each `attachments/n1/` lies inside the name of the one before it; a scan that resumed
    // inside a name would read the rest of the run again from each. 2,000 refs keep that
    // regression at ~500 times the bound, failing in about a second rather than minutes.
    assert_linear("nested names", "attachments/n1/".repeat(2_000));
}

#[test]
fn near_misses_are_scanned_once() {
    assert_linear(
        "near misses",
        "attachments/n2/attachments\\n".repeat(REPEATS),
    );
    assert_linear("bare keyword", "attachmentsattachments ".repeat(REPEATS));
}

#[test]
fn a_deeply_nested_body_scans_on_a_small_stack() {
    let nested = format!(
        "{}![](attachments/n1/aaaaaa-x.png){}",
        "> [".repeat(200_000),
        "](y)".repeat(200_000)
    );
    let names = on_small_stack(move || filenames(ID, &nested));
    assert_eq!(names, set(&["aaaaaa-x.png"]));
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn names_stay_within_the_body_and_hold_no_end_character(
        body in proptest::collection::vec(
            prop_oneof![
                Just("attachments".to_owned()),
                Just("/".to_owned()),
                Just("\\".to_owned()),
                Just(ID.to_owned()),
                Just("%".to_owned()),
                Just("%2F".to_owned()),
                Just(")".to_owned()),
                "[a-z0-9.\\- \"'<>é]{0,4}",
            ],
            0..64,
        ).prop_map(|parts| parts.concat())
    ) {
        let names = filenames(ID, &body);
        let out: usize = names.iter().map(String::len).sum();
        prop_assert!(out <= output_bound(body.len()));
        for name in &names {
            prop_assert!(!name.is_empty());
            prop_assert!(!name.contains([')', '"', '\'', '<', '>', '\\']), "{name:?}");
            // An undecoded name is a slice of the body after `<id>/`.
            if !body.contains('%') {
                let after_slash = format!("{ID}/{name}");
                let after_backslash = format!("{ID}\\{name}");
                prop_assert!(body.contains(&after_slash) || body.contains(&after_backslash));
            }
        }
    }

    /// Electron keeps a file whose `attachments/<owner>/<file>` run is anywhere in a body, so
    /// the scan does too, whatever surrounds it and in any case.
    #[test]
    fn a_body_that_holds_the_run_names_the_file(
        before in "[a-zA-Z0-9 \\[\\]()!\"'#?|*.:/\\\\%-]{0,24}",
        after in "[a-zA-Z0-9 \\[\\]()!\"'#?|*.:/\\\\%-]{0,24}",
        file in "[a-zA-Z0-9 '%().-]{1,16}",
        separators in prop_oneof![Just(("/", "/")), Just(("\\", "\\")), Just(("\\", "/"))],
        upper in any::<bool>(),
    ) {
        let (a, b) = separators;
        let run = format!("attachments{a}{ID}{b}{file}");
        let run = if upper { run.to_ascii_uppercase() } else { run };
        let body = [before.as_str(), &run, &after].concat();
        prop_assert!(names_file(ID, &file, &body), "{body:?}");
    }
}
