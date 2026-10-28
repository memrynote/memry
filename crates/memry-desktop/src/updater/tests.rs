//! Untrusted-input guards (crates/AGENTS.md): the marker files are read back from disk, and the
//! release notes come from the update feed.

use std::path::Path;

use memry_test_kit::{
    assert_output_bounded, assert_steps_at_most, on_small_stack, output_bound, proptest_config,
};
use proptest::prelude::*;

use super::notes::{MAX_NOTES_HTML_BYTES, html_to_plain_text, strip_passes};
use super::{MAX_MARKER_BYTES, guard, health, marker};
use crate::shell::install_layout::WindowsInstallLayout;

const NESTING: usize = 100_000;

fn nested_json() -> Vec<u8> {
    let mut raw = "[".repeat(NESTING).into_bytes();
    raw.extend("]".repeat(NESTING).into_bytes());
    raw
}

#[test]
fn deeply_nested_marker_files_fail_closed_on_a_small_stack() {
    on_small_stack(|| {
        let raw = nested_json();
        assert_eq!(marker::parse(&raw), None);
        assert_eq!(health::parse(&raw), None);
        assert_eq!(guard::parse(&raw), None);
    });
}

/// A valid marker padded past the cap: only the size check refuses it.
fn padded(json: &str) -> Vec<u8> {
    let mut raw = json.as_bytes().to_vec();
    raw.resize(MAX_MARKER_BYTES as usize + 1, b' ');
    raw
}

#[test]
fn an_oversized_marker_file_is_refused_and_consumed() {
    let dir = tempfile::tempdir().unwrap();
    let attempt = dir.path().join(marker::UPDATE_INSTALL_MARKER_FILENAME);
    std::fs::write(
        &attempt,
        padded(r#"{"fromVersion":"2026.1015.1","startedAt":""}"#),
    )
    .unwrap();
    assert_eq!(
        marker::detect(dir.path(), "2026.1015.1", || WindowsInstallLayout::Velopack),
        None
    );
    assert!(!attempt.exists());

    std::fs::write(
        dir.path().join(health::UPDATE_INSTALL_HEALTH_FILENAME),
        padded(
            r#"{"fromVersion":"a","targetVersion":"b","consecutiveFailures":3,"escalated":true}"#,
        ),
    )
    .unwrap();
    assert_eq!(health::reconcile(dir.path(), "a"), None);

    std::fs::write(
        dir.path().join(guard::PENDING_INSTALL_FILENAME),
        padded(r#"{"fromVersion":"a","createdAt":1}"#),
    )
    .unwrap();
    assert_eq!(guard::read(dir.path()), None);
}

#[test]
fn a_marker_at_the_cap_is_still_read() {
    let dir = tempfile::tempdir().unwrap();
    let mut raw = br#"{"fromVersion":"a","createdAt":1}"#.to_vec();
    raw.resize(MAX_MARKER_BYTES as usize, b' ');
    std::fs::write(dir.path().join(guard::PENDING_INSTALL_FILENAME), raw).unwrap();
    assert!(guard::read(dir.path()).is_some());
}

#[test]
fn deeply_nested_release_notes_convert_on_a_small_stack() {
    let text = on_small_stack(|| {
        // 50,000 levels: 350 KB, under the size cap.
        let html = format!(
            "{}x{}",
            "<b>".repeat(NESTING / 2),
            "</b>".repeat(NESTING / 2)
        );
        html_to_plain_text(&html)
    });
    assert_eq!(text, "x");
}

#[test]
fn tag_stripping_takes_two_passes_whatever_the_nesting() {
    on_small_stack(|| {
        for html in [
            "<".repeat(5_000) + &">".repeat(5_000),
            "<<a>".repeat(5_000) + "script>",
            "<a<b<c>>>".repeat(2_000),
            "<b>".repeat(10_000),
        ] {
            assert_steps_at_most("strip passes", strip_passes, 2, || {
                html_to_plain_text(&html);
            });
        }
    });
}

#[test]
fn release_notes_past_the_cap_are_cut_before_conversion() {
    let html = "<p>".to_owned() + &"é".repeat(MAX_NOTES_HTML_BYTES) + "</p>";
    let text = html_to_plain_text(&html);
    assert!(text.len() <= MAX_NOTES_HTML_BYTES, "{} bytes", text.len());
    assert!(text.chars().all(|c| c == 'é'));
}

/// What the stripper removes: `<`, at least one character, `>`.
fn no_tag_left(text: &str) -> bool {
    text.match_indices('<')
        .all(|(at, _)| text[at + 1..].find('>').is_none_or(|end| end == 0))
}

proptest! {
    #![proptest_config(proptest_config(256))]

    #[test]
    fn release_notes_never_keep_a_tag(html in "(<|>|/|a|li|h2|p|br|\\s|é){0,200}") {
        // No `&`: a decoded `&lt;b&gt;` is text that reads like a tag, by design.
        let text = html_to_plain_text(&html);
        prop_assert!(no_tag_left(&text), "{text:?}");
    }

    #[test]
    fn release_notes_never_grow(html in "(<|>|/|a|li|h2|p|&|#|x|;|[0-9]|\\s|é){0,200}") {
        prop_assert!(html_to_plain_text(&html).len() <= output_bound(html.len()));
    }

    #[test]
    fn marker_parsers_never_panic_on_arbitrary_bytes(raw in proptest::collection::vec(any::<u8>(), 0..512)) {
        let _ = marker::parse(&raw);
        let _ = health::parse(&raw);
        let _ = guard::parse(&raw);
    }

    #[test]
    fn a_written_marker_reads_back(from in "[0-9]{4}\\.[0-9]{3,4}\\.[0-9]{1,3}", to in proptest::option::of("v[0-9a-z.-]{1,20}"), now in 0u64..4_102_444_800_000) {
        let dir = tempfile::tempdir().unwrap();
        marker::write_started(dir.path(), &from, to.as_deref(), Some(marker::Installer::Velopack), now);
        let detected = marker::detect(dir.path(), &from, || unreachable!()).unwrap();
        prop_assert_eq!(&detected.attempt.from_version, &from);
        prop_assert_eq!(&detected.attempt.to_version, &to);
        prop_assert_eq!(detected.attempt.duration_ms(now), Some(0));
        prop_assert!(!Path::new(dir.path()).join(marker::UPDATE_INSTALL_MARKER_FILENAME).exists());
    }
}

#[test]
fn release_notes_output_is_bounded_for_entity_heavy_input() {
    let html = "&#x10FFFF;&amp;<h1>".repeat(10_000);
    let text = html_to_plain_text(&html);
    assert_output_bounded("entities", html.len(), text.len());
}
