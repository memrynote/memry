//! `rewrite_note_refs_for_move`, a moved note's relative refs: the cases of
//! `packages/editor-schema/src/blocks/rewrite-note-refs.test.ts`, and the untrusted-input
//! guards (the file is the user's): linear steps, output bounded per ref, image refs found
//! exactly where the reference's regular expression finds them, and a deep marker payload on a
//! small stack.

#![cfg(feature = "markdown")]

use memry_core::markdown::schema::blocks::note_refs::{
    NoteRefsOptions, ref_growth, ref_steps, rewrite_note_refs_for_move,
};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;
use regex::Regex;

fn plain(body: &str, old: &str, new: &str) -> Option<String> {
    rewrite_note_refs_for_move(body, old, new, NoteRefsOptions::default())
}

/// As desktop's move asks it: the note's own vault-root refs stay.
fn moving(body: &str, old: &str, new: &str, note_id: &str) -> Option<String> {
    let options = NoteRefsOptions {
        source_note_id: Some(note_id),
        preserve_root_relative_attachments: true,
    };
    rewrite_note_refs_for_move(body, old, new, options)
}

fn some(text: &str) -> Option<String> {
    Some(text.to_owned())
}

#[test]
fn a_move_within_one_folder_or_to_the_same_depth_changes_nothing() {
    let body = "![photo](../attachments/n1/photo.png)\n";
    assert_eq!(plain(body, "notes/Foo.md", "notes/Foo-1.md"), None);
    let body = "![photo](../../attachments/n1/photo.png)\n";
    assert_eq!(plain(body, "notes/a/Foo.md", "notes/b/Foo.md"), None);
    assert_eq!(plain("", "notes/Foo.md", "notes/archive/Foo.md"), None);
}

#[test]
fn refs_gain_or_drop_a_parent_per_folder_moved() {
    let body = "![photo](../attachments/n1/photo.png)\n";
    assert_eq!(
        plain(body, "notes/Foo.md", "notes/archive/2026/Foo.md"),
        some("![photo](../../../attachments/n1/photo.png)\n")
    );
    let body = "![photo](../../../attachments/n1/photo.png)\n";
    assert_eq!(
        plain(body, "notes/archive/2026/Foo.md", "notes/Foo.md"),
        some("![photo](../attachments/n1/photo.png)\n")
    );
    let body = "![photo](../attachments/n1/photo.png)\n";
    assert_eq!(
        plain(body, "notes/Foo.md", "Foo.md"),
        some("![photo](attachments/n1/photo.png)\n")
    );
    let body = "![photo](images/photo.png)\n";
    assert_eq!(
        plain(body, "notes/Foo.md", "notes/archive/Foo.md"),
        some("![photo](../images/photo.png)\n")
    );
}

#[test]
fn a_shared_ref_keeps_its_owner_s_folder() {
    // #2077: `n2` embeds a file stored under `n1`.
    let body = "<!-- file:{\"url\":\"../attachments/n1/k3f9x2-report.pdf\",\"name\":\"report.pdf\",\"size\":1,\"mimeType\":\"application/pdf\"} -->\n";
    assert_eq!(
        moving(body, "notes/B.md", "notes/archive/2026/B.md", "n2"),
        some(
            "<!-- file:{\"url\":\"../../../attachments/n1/k3f9x2-report.pdf\",\"name\":\"report.pdf\",\"size\":1,\"mimeType\":\"application/pdf\"} -->\n"
        )
    );
}

#[test]
fn a_mobile_root_relative_ref_stays_for_its_own_note_and_follows_a_block_move() {
    let body = "![photo](attachments/n1/photo.png)\n";
    assert_eq!(moving(body, "movies/Foo.md", "notes/Foo.md", "n1"), None);
    let options = NoteRefsOptions {
        source_note_id: Some("n1"),
        preserve_root_relative_attachments: false,
    };
    assert_eq!(
        rewrite_note_refs_for_move(body, "a/Foo.md", "b/deep/Bar.md", options),
        some("![photo](../../attachments/n1/photo.png)\n")
    );
}

#[test]
fn only_the_url_member_of_a_marker_changes_and_its_escapes_survive() {
    let marker = "<!-- file:{\"url\":\"../attachments/n1/plan.pdf\",\"name\":\"plan.pdf\",\"size\":1024,\"mimeType\":\"application/pdf\",\"width\":720,\"height\":300,\"align\":\"center\"} -->";
    assert_eq!(
        plain(marker, "notes/Foo.md", "notes/archive/2026/Foo.md"),
        some(
            "<!-- file:{\"url\":\"../../../attachments/n1/plan.pdf\",\"name\":\"plan.pdf\",\"size\":1024,\"mimeType\":\"application/pdf\",\"width\":720,\"height\":300,\"align\":\"center\"} -->"
        )
    );
    let marker = "<!-- file:{\"url\":\"../attachments/n1/a--\\u003eb.pdf\",\"name\":\"a--\\u003eb.pdf\",\"size\":1,\"mimeType\":\"application/pdf\"} -->";
    assert_eq!(
        plain(marker, "notes/Foo.md", "notes/archive/Foo.md"),
        some(
            "<!-- file:{\"url\":\"../../attachments/n1/a--\\u003eb.pdf\",\"name\":\"a--\\u003eb.pdf\",\"size\":1,\"mimeType\":\"application/pdf\"} -->"
        )
    );
    // `String#trim` strips a no-break space, so the line is still a marker, and keeps it.
    let marker =
        "\u{a0}<!-- file:{\"url\":\"a.pdf\",\"name\":\"a.pdf\",\"size\":1,\"mimeType\":\"x\"} -->";
    assert_eq!(
        plain(marker, "notes/Foo.md", "notes/x/Foo.md"),
        some(
            "\u{a0}<!-- file:{\"url\":\"../a.pdf\",\"name\":\"a.pdf\",\"size\":1,\"mimeType\":\"x\"} -->"
        )
    );
}

#[test]
fn refs_that_are_not_ours_stay() {
    let body = "![photo](memry-file://local/Users/k/vault/attachments/n1/photo.png)\n\
        <!-- file:{\"url\":\"memry-file://local/Users/k/vault/attachments/n1/p.pdf\",\"name\":\"p.pdf\",\"size\":1,\"mimeType\":\"application/pdf\"} -->\n";
    assert_eq!(plain(body, "notes/Foo.md", "notes/archive/Foo.md"), None);
    let body = "![remote](https://example.com/photo.png)\n![inline](data:image/png;base64,AAAA)\n[link](https://example.com/page)\n";
    assert_eq!(plain(body, "notes/Foo.md", "notes/archive/Foo.md"), None);
    let body = "[[Other Note]]\n![[photo.png]]\n[[Folder/Other|alias]]\n";
    assert_eq!(
        plain(body, "notes/Foo.md", "notes/archive/2026/Foo.md"),
        None
    );
    let body = "![escape](../../outside.png)\n";
    assert_eq!(
        plain(body, "notes/Foo.md", "notes/archive/2026/Foo.md"),
        None
    );
    let body = "![abs](/attachments/n1/photo.png)\n![unc](\\\\server\\share\\photo.png)\n";
    assert_eq!(plain(body, "notes/Foo.md", "notes/archive/Foo.md"), None);
    let body = "<!-- link-card:{\"cover\":true} -->\n[[Dune]]\n";
    assert_eq!(plain(body, "notes/Foo.md", "notes/archive/Foo.md"), None);
}

#[test]
fn percent_escapes_stay_encoded_or_untouched() {
    let body = "![photo](../attachments/n1/my%20photo%281%29.png)\n";
    assert_eq!(
        plain(body, "notes/Foo.md", "notes/archive/Foo.md"),
        some("![photo](../../attachments/n1/my%20photo%281%29.png)\n")
    );
    let body = "![photo](../../attachments/n1/caf%C3%A9.png)\n";
    assert_eq!(plain(body, "notes/a/Foo.md", "notes/b/Foo.md"), None);
    // `decodeURIComponent` throws on a bad escape; the ref is then used as written.
    let body = "![photo](a%zz.png)\n";
    assert_eq!(
        plain(body, "notes/Foo.md", "notes/x/Foo.md"),
        some("![photo](../a%zz.png)\n")
    );
}

#[test]
fn every_ref_in_a_body_follows_and_the_rest_keeps_its_bytes() {
    let body = [
        "---",
        "title: Foo",
        "---",
        "",
        "# Heading",
        "",
        "![one](../attachments/n1/one.png)",
        "",
        "Some prose with a [[Wiki Link]] and a [link](https://example.com).",
        "",
        "<!-- file:{\"url\":\"../attachments/n1/two.pdf\",\"name\":\"two.pdf\",\"size\":2,\"mimeType\":\"application/pdf\"} -->",
        "<!-- link-card:{\"size\":\"medium\",\"preview\":true} -->",
        "[[Dune]]",
        "",
    ]
    .join("\n");
    let want = body
        .replace("](../attachments/n1/one", "](../../attachments/n1/one")
        .replace("\"../attachments/n1/two", "\"../../attachments/n1/two");
    assert_eq!(
        plain(&body, "notes/Foo.md", "notes/archive/Foo.md"),
        Some(want)
    );
}

fn hostile(n: usize) -> Vec<(&'static str, String)> {
    vec![
        ("opens without a close", "![".repeat(n / 2)),
        (
            "opens before one far close",
            format!("{}]", "![".repeat(n / 2)),
        ),
        ("refs never closed", "![](a".repeat(n / 5)),
        ("refs into opens", "![a](b![c](d".repeat(n / 12)),
        ("brackets", "![]".repeat(n / 3)),
        ("refs", "![](a.png)".repeat(n / 10)),
    ]
}

#[test]
fn the_image_scan_is_linear_in_the_text() {
    on_small_stack(|| {
        for (what, text) in hostile(200_000) {
            assert_steps_at_most(what, ref_steps, 4 * text.len() + 16, || {
                plain(&text, "notes/Foo.md", "notes/x/Foo.md");
            });
        }
    });
}

#[test]
fn a_deep_marker_payload_is_refused_on_a_small_stack() {
    let line = format!(
        "<!-- file:{{\"url\":\"a.png\",\"x\":{}{}}} -->",
        "[".repeat(100_000),
        "]".repeat(100_000)
    );
    let out = on_small_stack(move || plain(&line, "notes/Foo.md", "notes/x/Foo.md"));
    assert_eq!(out, None);
}

/// The reference: `/(!\[[^\]]*\]\()([^()\s]*)(\))/g` with JavaScript's `\s`.
fn reference_refs(line: &str) -> Vec<(usize, usize)> {
    let js_space = "\\t\\n\\x0B\\x0C\\r \\u{A0}\\u{1680}\\u{2000}-\\u{200A}\\u{2028}\\u{2029}\\u{202F}\\u{205F}\\u{3000}\\u{FEFF}";
    let pattern = Regex::new(&format!(r"!\[[^\]]*\]\(([^(){js_space}]*)\)")).unwrap();
    pattern
        .captures_iter(line)
        .map(|found| {
            let r = found.get(1).unwrap();
            (r.start(), r.end())
        })
        .collect()
}

/// Every ref the reference finds, rewritten with a parent: the move from `notes/` to `notes/x/`
/// turns `a` into `../a`. The generated refs hold no `/`, `%` or `:`, so only `x`, the new
/// folder itself, names no file to point at.
fn reference_rewrite(line: &str) -> Option<String> {
    let mut out = String::new();
    let mut copied = 0;
    for (start, end) in reference_refs(line) {
        let r = &line[start..end];
        let ours = !r.is_empty() && r != "x";
        if ours {
            out.push_str(&line[copied..start]);
            out.push_str("../");
            copied = start;
        }
    }
    (!out.is_empty()).then(|| out + &line[copied..])
}

proptest! {
    #![proptest_config(proptest_config(memry_test_kit::DEFAULT_CASES))]

    #[test]
    fn image_refs_are_the_references(
        parts in prop::collection::vec(
            prop_oneof![
                Just("![".to_owned()),
                Just("](".to_owned()),
                Just("![x](a)".to_owned()),
                Just(")".to_owned()),
                Just("(".to_owned()),
                Just("]".to_owned()),
                Just("\u{feff}".to_owned()),
                Just("\u{85}".to_owned()),
                "[a-z! \\[\\]()é😀]{0,8}",
            ],
            0..40,
        )
    ) {
        let line = parts.concat().replace('\n', "");
        let out = plain(&line, "notes/Foo.md", "notes/x/Foo.md");
        prop_assert_eq!(out, reference_rewrite(&line));
    }

    #[test]
    fn output_grows_by_at_most_the_bound_per_ref(
        parts in prop::collection::vec(
            prop_oneof![
                Just("![](a)".to_owned()),
                Just("![](%01)".to_owned()),
                Just("![](a%20(b)".to_owned()),
                Just("<!-- file:{\"url\":\"%01%3E--\",\"name\":\"a\"} -->\n".to_owned()),
                Just("\n".to_owned()),
                "[a-z!\\[\\]()%]{0,8}",
            ],
            0..40,
        ),
        old in "(My Notes/){0,2}[a-z]{1,4}\\.md",
        new in "([a-z]/){0,6}[a-z]{1,4}\\.md",
    ) {
        let body = parts.concat();
        if let Some(out) = plain(&body, &old, &new) {
            let refs = body.len() / 5 + 1;
            prop_assert!(out.len() <= 2 * body.len() + refs * ref_growth(&old, &new));
        }
    }
}
