//! Note markdown is untrusted input (synced, imported, written by other apps).
//! The export renders it on a 2 MiB stack at any nesting, applies its own
//! footnote and wiki-link passes in linear time, and keeps its output within a
//! fixed ratio of the note. The image inliner reads only regular files whose
//! `data:` URI Electron could have built.

use std::path::Path;

use chrono::NaiveDate;
use memry_desktop::export::{
    ImageSource, MAX_DATA_URI_LEN, NoteExport, RenderOptions, inline_export_images,
    render_note_as_html, steps,
};
use memry_test_kit::{assert_steps_at_most, on_small_stack, proptest_config};
use proptest::prelude::*;

/// The export adds markup to every construct: a five-byte `[[a]]` becomes a
/// 32-byte span and a `[^a]` a 70-byte superscript link.
const BODY_RATIO: usize = 32;

fn render(content: &str) -> String {
    let date = NaiveDate::from_ymd_opt(2026, 1, 2).expect("date");
    let note = NoteExport {
        title: "T",
        content,
        icon: None,
        tags: &[],
        created: date,
        modified: date,
    };
    let options = RenderOptions {
        include_metadata: false,
        include_task_markers: false,
        find_custom_icon: &|_| None,
    };
    render_note_as_html(&note, &options)
}

fn body_len(content: &str) -> usize {
    render(content).len() - render("").len()
}

#[test]
fn deep_nesting_renders_on_a_small_stack() {
    on_small_stack(|| {
        let shapes = [
            ">".repeat(100_000),
            "[".repeat(100_000),
            "*".repeat(100_000),
            "<div>".repeat(50_000),
            "[^a]".repeat(10_000) + "\n\n[^a]: " + &"[".repeat(50_000),
            (0..2_000)
                .map(|depth| format!("{}- item\n", "  ".repeat(depth)))
                .collect(),
            (0..2_000)
                .map(|depth| format!("{}1. item\n", "   ".repeat(depth)))
                .collect(),
        ];
        for shape in shapes {
            assert!(render(&shape).contains("</main>"));
        }
    });
}

#[test]
fn footnote_and_wiki_passes_are_linear() {
    let mut note = String::new();
    for i in 0..20_000 {
        note.push_str(&format!("Claim[^n{i}] and [[Link {i}]].\n"));
    }
    for i in 0..20_000 {
        note.push_str(&format!("[^n{i}]: Note {i}.\n"));
    }
    let bound = BODY_RATIO * note.len();
    assert_steps_at_most("the export's markdown passes", steps, bound, || {
        render(&note);
    });
}

fn inline_in(vault: &Path, src: &str) -> String {
    inline_export_images(
        &format!("<img src=\"{src}\">"),
        ImageSource {
            note_path: Some("Note.md"),
            vault_path: Some(vault),
        },
    )
}

#[test]
fn an_image_too_large_for_electron_stays_as_written() {
    let vault = tempfile::tempdir().expect("vault");
    std::fs::write(vault.path().join("small.png"), [0x89, b'P', b'N', b'G']).expect("small");
    assert_eq!(
        inline_in(vault.path(), "small.png"),
        "<img src=\"data:image/png;base64,iVBORw==\">"
    );

    // The smallest png whose `data:` URI is longer than V8's longest string.
    let prefix = "data:image/png;base64,".len() as u64;
    let len = (MAX_DATA_URI_LEN - prefix) / 4 * 3 + 1;
    let big = std::fs::File::create(vault.path().join("big.png")).expect("big");
    big.set_len(len).expect("sparse length");
    assert_eq!(inline_in(vault.path(), "big.png"), "<img src=\"big.png\">");
}

#[cfg(unix)]
#[test]
fn a_fifo_named_like_an_image_stays_as_written() {
    let vault = tempfile::tempdir().expect("vault");
    let status = std::process::Command::new("mkfifo")
        .arg(vault.path().join("pipe.png"))
        .status()
        .expect("mkfifo");
    assert!(status.success());
    assert_eq!(
        inline_in(vault.path(), "pipe.png"),
        "<img src=\"pipe.png\">"
    );
}

fn soup() -> impl Strategy<Value = String> {
    let token = prop::sample::select(vec![
        "a",
        " ",
        "\n",
        "\n\n",
        "\r\n",
        "\t",
        "    ",
        "#",
        "> ",
        "- ",
        "1. ",
        "- [ ] ",
        "*",
        "_",
        "`",
        "```",
        "~~",
        "|",
        "---",
        "[",
        "]",
        "(",
        ")",
        "[[",
        "]]",
        "|",
        "[^",
        "]:",
        "^",
        "%%",
        "<!--",
        "-->",
        "<b>",
        "</b>",
        "<img src=\"x.png\">",
        "![i](a.png)",
        "{task:x}",
        "&",
        "&amp;",
        "\\",
        "é",
        "😀",
        "https://e.com",
    ]);
    prop::collection::vec(token, 0..200).prop_map(|tokens| tokens.concat())
}

proptest! {
    #![proptest_config(proptest_config(512))]

    #[test]
    fn any_note_renders_within_its_bound(content in soup()) {
        let body = body_len(&content);
        prop_assert!(body <= BODY_RATIO * content.len() + 64, "{body} bytes from {}", content.len());
    }
}
