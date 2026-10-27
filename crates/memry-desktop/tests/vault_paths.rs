//! Path rules against Electron: `sanitizeFilename` and the file kinds are pinned by vectors
//! produced from the TypeScript; the builders port `file-ops.test.ts`.

use std::path::Path;

use memry_desktop::vault::file_types::{
    extension, file_type_of_extension, is_canvas_file_path, is_supported_path, mime_of_extension,
};
use memry_desktop::vault::paths::{
    generate_note_path, generate_unique_path, safe_join, sanitize_filename,
};
use serde_json::Value;

fn utf16(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("units")
        .iter()
        .map(|u| u.as_u64().expect("unit") as u16)
        .collect()
}

#[test]
fn sanitize_filename_matches_electron() {
    let vectors: Value =
        serde_json::from_str(include_str!("fixtures/sanitize-filename.json")).unwrap();
    let cases = vectors["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for case in cases {
        let input = utf16(&case["input"]);
        let expected = utf16(&case["output"]);
        let input_text = String::from_utf16_lossy(&input);
        let actual: Vec<u16> = sanitize_filename(&input_text).encode_utf16().collect();
        // JavaScript can leave half of a surrogate pair when it cuts at 200 units; a
        // Rust string cannot, and the half is dropped (documented on the function).
        let expected = if expected.len() == 200 && (0xD800..0xDC00).contains(&expected[199]) {
            expected[..199].to_vec()
        } else {
            expected
        };
        // A lone surrogate in the input cannot be represented; the generator has none.
        assert_eq!(actual, expected, "input {input:?}");
    }
}

#[test]
fn file_kinds_match_the_shared_module() {
    let vectors: Value = serde_json::from_str(include_str!("fixtures/file-types.json")).unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        assert_eq!(
            is_supported_path(path),
            case["supported"].as_bool().unwrap(),
            "{path}"
        );
        let ext = extension(path);
        assert_eq!(
            file_type_of_extension(&ext).map(|t| t.as_str()),
            case["fileType"].as_str(),
            "{path}"
        );
        assert_eq!(mime_of_extension(&ext), case["mime"].as_str(), "{path}");
    }
}

#[test]
fn canvas_files_are_found_under_the_canvas_folder_only() {
    assert!(is_canvas_file_path("canvases/a.excalidraw"));
    assert!(is_canvas_file_path("canvases/sub/B.EXCALIDRAW"));
    assert!(!is_canvas_file_path("notes/a.excalidraw"));
    assert!(!is_canvas_file_path("canvases-old/a.excalidraw"));
    assert!(!is_canvas_file_path("canvases/a.md"));
}

#[test]
fn generate_note_path_ports_the_electron_cases() {
    let dir = Path::new("/vault/notes");
    assert_eq!(
        generate_note_path(dir, "My Note", None),
        dir.join("My Note.md")
    );
    assert_eq!(
        generate_note_path(dir, "My Note", Some("projects")),
        dir.join("projects").join("My Note.md")
    );
    assert_eq!(
        generate_note_path(dir, "Note: With \"Special\" <Chars>", None),
        dir.join("Note With Special Chars.md")
    );
    assert_eq!(generate_note_path(dir, "x", Some("")), dir.join("x.md"));
}

#[test]
fn generate_unique_path_ports_the_electron_cases() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("note.md");
    assert_eq!(generate_unique_path(&base), base);
    std::fs::write(&base, "").unwrap();
    assert_eq!(generate_unique_path(&base), dir.path().join("note 1.md"));
    std::fs::write(dir.path().join("note 1.md"), "").unwrap();
    std::fs::write(dir.path().join("note 2.md"), "").unwrap();
    assert_eq!(generate_unique_path(&base), dir.path().join("note 3.md"));
    let txt = dir.path().join("document.txt");
    std::fs::write(&txt, "").unwrap();
    assert_eq!(
        generate_unique_path(&txt),
        dir.path().join("document 1.txt")
    );
    // A name that is only an extension has no extension (path.extname).
    let hidden = dir.path().join(".env");
    std::fs::write(&hidden, "").unwrap();
    assert_eq!(generate_unique_path(&hidden), dir.path().join(".env 1"));
}

#[cfg(unix)]
#[test]
fn a_dangling_link_counts_as_taken() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("note.md");
    std::os::unix::fs::symlink(dir.path().join("nowhere"), &base).unwrap();
    assert_eq!(generate_unique_path(&base), dir.path().join("note 1.md"));
}

#[test]
fn safe_join_stays_inside_the_base() {
    let base = Path::new("/vault");
    assert_eq!(
        safe_join(base, &["a", "b.md"]),
        Some(Path::new("/vault/a/b.md").to_path_buf())
    );
    assert_eq!(
        safe_join(base, &["a", "..", "b.md"]),
        Some(Path::new("/vault/b.md").to_path_buf())
    );
    assert_eq!(safe_join(base, &[]), Some(base.to_path_buf()));
    assert_eq!(safe_join(base, &["..", "etc"]), None);
    assert_eq!(safe_join(base, &["a/../../x"]), None);
    // A sibling that shares the prefix is not inside.
    assert_eq!(safe_join(base, &["..", "vault2", "x"]), None);
}

mod hostile_titles {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 4000, ..ProptestConfig::default() })]

        /// Whatever a title holds, the file name is a single, visible, bounded path segment.
        #[test]
        fn a_sanitized_name_is_always_one_safe_segment(title in "\\PC{0,400}|[ ./\\\\:<>|?*\\[\\]#^a-z\\t\\u{a0}\\u{85}]{0,300}") {
            let name = sanitize_filename(&title);
            prop_assert!(!name.is_empty());
            prop_assert!(name.encode_utf16().count() <= 200);
            prop_assert!(!name.starts_with('.') && !name.starts_with(' '));
            prop_assert!(!name.contains(['/', '\\', ':', '<', '>', '|', '?', '*', '"', '[', ']', '#', '^', '\0']));
            // Cutting at 200 units can expose a trailing space, exactly as `slice` does in Electron.
            if name.encode_utf16().count() < 199 {
                prop_assert!(!name.ends_with(' '));
                prop_assert_eq!(sanitize_filename(&name), name.clone(), "idempotent");
            }
            let path = generate_note_path(Path::new("/v"), &title, None);
            prop_assert_eq!(path.parent(), Some(Path::new("/v")));
        }
    }
}
