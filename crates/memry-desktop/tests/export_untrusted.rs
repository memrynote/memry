//! Note markdown is untrusted input (synced, imported, written by other apps).
//! The export renders it on a 2 MiB stack at any nesting, applies its own
//! footnote and wiki-link passes in linear time, and keeps its output within a
//! fixed ratio of the note. The image inliner reads only regular files under
//! the vault or the app data folder, links followed, never asks about a network
//! path, and keeps one document's images within the `data:` URI Electron could
//! have built. Script in a note is held by the document's policy.

use std::path::Path;

use chrono::NaiveDate;
use memry_desktop::export::{
    ImageSource, MAX_DATA_URI_LEN, NoteExport, RenderOptions, image_reads, inline_export_images,
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

/// A line of spaces or tabs between lone `\r`s is a blank line: it ends the
/// run, and the footnote neither shows its hidden first line nor opens a code
/// block.
#[test]
fn a_footnote_line_of_whitespace_is_blank() {
    for blank in [" ", "\t", "  \t "] {
        let html = render(&format!("A[^a]\n\n[^a]: one\r{blank}\rtwo"));
        assert!(!html.contains("<p>x<br>"), "{blank:?}: {html}");
        assert!(!html.contains("<pre>"), "{blank:?}: {html}");
        assert!(
            html.contains("<li id=\"fn-1\">one<br><br>two <a"),
            "{blank:?}: {html}"
        );
    }
}

fn inline_in(vault: &Path, src: &str) -> String {
    inline_export_images(
        &format!("<img src=\"{src}\">"),
        ImageSource {
            note_path: Some("Note.md"),
            vault_path: Some(vault),
            app_data: None,
        },
    )
}

const PNG: [u8; 4] = [0x89, b'P', b'N', b'G'];
const PNG_URI: &str = "data:image/png;base64,iVBORw==";

/// A vault, an app data folder and a folder outside both, each with `a.png`.
struct Roots {
    vault: tempfile::TempDir,
    app_data: tempfile::TempDir,
    outside: tempfile::TempDir,
}

impl Roots {
    fn new() -> Self {
        let roots = Self {
            vault: tempfile::tempdir().expect("vault"),
            app_data: tempfile::tempdir().expect("app data"),
            outside: tempfile::tempdir().expect("outside"),
        };
        for dir in [&roots.vault, &roots.app_data, &roots.outside] {
            std::fs::write(dir.path().join("a.png"), PNG).expect("png");
        }
        roots
    }

    /// The document after inlining, from a note at the vault's root.
    fn inline_html(&self, html: &str) -> String {
        inline_export_images(
            html,
            ImageSource {
                note_path: Some("Note.md"),
                vault_path: Some(self.vault.path()),
                app_data: Some(self.app_data.path()),
            },
        )
    }

    /// The `src` after inlining, from a note at the vault's root.
    fn inline(&self, src: &str) -> String {
        let html = self.inline_html(&format!("<img src=\"{src}\">"));
        html.strip_prefix("<img src=\"")
            .and_then(|rest| rest.strip_suffix("\">"))
            .expect("one img")
            .to_owned()
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn memry_file_url(path: &Path) -> String {
    format!(
        "memry-file://local/{}",
        text(path).trim_start_matches('/').replace('\\', "/")
    )
}

#[test]
fn only_files_under_the_vault_or_app_data_are_inlined() {
    let roots = Roots::new();
    let inside = roots.vault.path().join("a.png");
    let app_data = roots.app_data.path().join("a.png");
    let outside = roots.outside.path().join("a.png");
    let file_url = |path: &Path| {
        url::Url::from_file_path(path)
            .expect("file url")
            .to_string()
    };

    for src in [
        text(&inside),
        file_url(&inside),
        memry_file_url(&inside),
        text(&app_data),
    ] {
        assert_eq!(roots.inline(&src), PNG_URI, "{src}");
    }
    for src in [text(&outside), file_url(&outside), memry_file_url(&outside)] {
        assert_eq!(roots.inline(&src), src, "{src}");
    }
}

#[cfg(unix)]
#[test]
fn a_link_out_of_the_vault_stays_as_written() {
    let roots = Roots::new();
    let link = roots.vault.path().join("link.png");
    std::os::unix::fs::symlink(roots.outside.path().join("a.png"), &link).expect("symlink");
    for src in ["link.png".to_owned(), text(&link)] {
        assert_eq!(roots.inline(&src), src, "{src}");
    }
}

/// The type comes from the file a link names: an image name on a link to the
/// vault's database or the app's secrets is not an image.
#[cfg(unix)]
#[test]
fn a_link_named_like_an_image_to_another_file_stays_as_written() {
    use std::os::unix::fs::symlink;
    let roots = Roots::new();
    let vault = roots.vault.path();
    std::fs::create_dir(vault.join(".memry")).expect("dot folder");
    std::fs::write(vault.join(".memry/data.db"), b"SQLite format 3\0").expect("db");
    std::fs::write(roots.app_data.path().join("s.json"), b"{}").expect("secrets");
    std::fs::write(vault.join("b.jpg"), PNG).expect("jpg");
    symlink(".memry/data.db", vault.join("db.png")).expect("db link");
    symlink(roots.app_data.path().join("s.json"), vault.join("s.png")).expect("s link");
    symlink("b.jpg", vault.join("photo.png")).expect("photo link");
    for src in [
        "db.png".to_owned(),
        text(&vault.join("db.png")),
        "s.png".to_owned(),
        text(&vault.join("s.png")),
    ] {
        assert_eq!(roots.inline(&src), src, "{src}");
    }
    assert_eq!(roots.inline("photo.png"), "data:image/jpeg;base64,iVBORw==");
}

/// The type comes from the file that was opened and checked, so a link swapped
/// from an image to the vault's database while the export opens it is not read.
#[cfg(unix)]
#[test]
fn a_link_swapped_to_another_file_during_the_open_stays_as_written() {
    use memry_desktop::export::inline_export_images_between;
    use std::os::unix::fs::symlink;
    let roots = Roots::new();
    let vault = roots.vault.path().to_path_buf();
    std::fs::create_dir(vault.join(".memry")).expect("dot folder");
    std::fs::write(vault.join(".memry/data.db"), b"SQLite format 3\0").expect("db");
    std::fs::write(vault.join("b.jpg"), PNG).expect("jpg");
    let link = vault.join("r.png");
    symlink("b.jpg", &link).expect("image link");
    let mut swapped = false;
    let mut swap = || {
        if !swapped {
            swapped = true;
            std::fs::remove_file(&link).expect("unlink");
            symlink(".memry/data.db", &link).expect("db link");
        }
    };
    let html = "<img src=\"r.png\">";
    let source = ImageSource {
        note_path: Some("Note.md"),
        vault_path: Some(&vault),
        app_data: Some(roots.app_data.path()),
    };
    assert_eq!(inline_export_images_between(html, source, &mut swap), html);
    assert!(swapped);
}

/// A hard link carries no location to check, so a file with more than one
/// name is not read.
#[test]
fn a_hard_link_into_the_vault_stays_as_written() {
    let roots = Roots::new();
    let link = roots.vault.path().join("h.png");
    std::fs::hard_link(roots.outside.path().join("a.png"), &link).expect("hard link");
    for src in ["h.png".to_owned(), text(&link)] {
        assert_eq!(roots.inline(&src), src, "{src}");
    }
}

/// JavaScript's `/i` folds ASCII only, so `ſrc` is not a `src` to Electron.
#[test]
fn a_src_spelled_with_a_long_s_stays_as_written() {
    let roots = Roots::new();
    let html = "<img \u{17f}rc=\"a.png\"><IMG SRC=\"a.png\">";
    assert_eq!(
        roots.inline_html(html),
        format!("<img \u{17f}rc=\"a.png\"><IMG SRC=\"{PNG_URI}\">")
    );
}

/// Each form names a file inside the vault, so only the network and device
/// check keeps it out: `//` + a POSIX path is that path, and `\\?\` + a Windows
/// path is that path.
#[test]
fn a_network_or_device_path_is_refused_before_the_file_system_is_asked() {
    let roots = Roots::new();
    let inside = text(&roots.vault.path().join("a.png"));
    let mut refused = vec![format!("/{inside}")];
    if cfg!(windows) {
        refused.extend([
            format!(r"\\?\{inside}"),
            format!("//?/{}", inside.replace('\\', "/")),
            r"\\localhost\C$\a.png".to_owned(),
            "//localhost/C$/a.png".to_owned(),
            "file://memry-test-host/share/a.png".to_owned(),
        ]);
    }
    for src in refused {
        assert_eq!(roots.inline(&src), src, "{src}");
    }
}

/// On Windows a `C:` segment would replace the whole path; elsewhere it is a
/// folder name, so this is where the refusal shows.
#[cfg(unix)]
#[test]
fn a_ref_segment_with_a_colon_stays_as_written() {
    let roots = Roots::new();
    let folder = roots.vault.path().join("a/C:");
    std::fs::create_dir_all(&folder).expect("folder");
    std::fs::write(folder.join("x.png"), PNG).expect("png");
    assert_eq!(roots.inline("a/C:/x.png"), "a/C:/x.png");
}

#[test]
fn one_file_named_many_ways_is_read_once() {
    let roots = Roots::new();
    let spellings = ["a.png", "./a.png", "%61.png", "x/../a.png"];
    let html: String = spellings
        .iter()
        .map(|src| format!("<img src=\"{src}\">"))
        .collect();
    let before = image_reads();
    let inlined = inline_export_images(
        &html,
        ImageSource {
            note_path: Some("Note.md"),
            vault_path: Some(roots.vault.path()),
            app_data: None,
        },
    );
    assert_eq!(image_reads() - before, 1);
    assert_eq!(inlined, format!("<img src=\"{PNG_URI}\">").repeat(4));
}

/// `big.png` alone fits in a `data:` URI; after `a.png` the document does not.
/// It is refused before it is read.
#[test]
fn a_documents_images_together_stay_within_the_cap() {
    let roots = Roots::new();
    let prefix = "data:image/png;base64,".len() as u64;
    let len = (MAX_DATA_URI_LEN - prefix) / 4 * 3;
    assert!(prefix + 4 * len.div_ceil(3) <= MAX_DATA_URI_LEN);
    let big = std::fs::File::create(roots.vault.path().join("big.png")).expect("big");
    big.set_len(len).expect("sparse length");
    let inlined = inline_export_images(
        "<img src=\"a.png\"><img src=\"big.png\">",
        ImageSource {
            note_path: Some("Note.md"),
            vault_path: Some(roots.vault.path()),
            app_data: None,
        },
    );
    assert_eq!(
        inlined,
        format!("<img src=\"{PNG_URI}\"><img src=\"big.png\">")
    );
}

/// Tests run in the crate folder, where this path names a png.
#[test]
fn an_empty_vault_path_is_no_vault() {
    let src = "tests/fixtures/export/vault/attachments/dot.png";
    assert!(Path::new(src).is_file());
    let cwd_relative = inline_export_images(
        &format!("<img src=\"{src}\">"),
        ImageSource {
            note_path: Some("Note.md"),
            vault_path: Some(Path::new("")),
            app_data: None,
        },
    );
    assert_eq!(cwd_relative, format!("<img src=\"{src}\">"));
}

#[test]
fn script_in_a_note_is_held_by_the_documents_policy() {
    let html = render(
        "<script>alert(1)</script>\n\n[x](javascript:alert(2)) <img src=\"x\" onerror=\"alert(3)\">",
    );
    let (head, body) = html.split_at(html.find("</head>").expect("head"));
    assert!(head.contains(
        r#"<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">"#
    ));
    assert!(body.contains("<script>alert(1)</script>"));
    assert!(body.contains("href=\"javascript:alert(2)\""));
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
