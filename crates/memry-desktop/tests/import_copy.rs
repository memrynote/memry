//! An import's copy of a file into the vault (`import-copy.ts`), on real files: which files get
//! their checklists marked plain, which are copied byte for byte, and that a file already at the
//! name is never replaced. The marking itself is pinned against the TypeScript in
//! `memry-core/tests/checklist_plain_vectors.rs`.

use std::fs;
use std::io;
use std::path::Path;

use memry_desktop::vault::import_copy::copy_imported_file;

const CHECKLIST: &str = "# Trip\n- [ ] Passport\n- [x] Tickets {task:abc}\n";

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn plain_checklists_mark_a_markdown_files_checkboxes_and_leave_its_source_alone() {
    let (from, to) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let source = from.path().join("Trip.md");
    fs::write(&source, CHECKLIST).unwrap();

    copy_imported_file(&source, &to.path().join("Trip.md"), true).unwrap();

    assert_eq!(
        fs::read_to_string(to.path().join("Trip.md")).unwrap(),
        "# Trip\n- [ ] Passport {check}\n- [x] Tickets {task:abc}\n"
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), CHECKLIST);
    assert_eq!(names(to.path()), ["Trip.md"], "no temp file is left");
}

/// Every file the marking does not rewrite arrives with the source's bytes, and on Unix its mode,
/// as `fs.copyFile` kept it.
#[test]
fn a_file_the_marking_does_not_rewrite_is_copied_byte_for_byte() {
    let not_utf8: &[u8] = b"- [ ] caf\xe9 au lait\n";
    let cases: [(&str, &[u8], bool); 4] = [
        ("Trip.md", CHECKLIST.as_bytes(), false),
        // Latin-1: decoding would replace the byte, so the file is never rewritten.
        ("Latin.md", not_utf8, true),
        ("Prose.md", b"# Notes\nNo checkboxes here.\r\n", true),
        ("List.txt", CHECKLIST.as_bytes(), true),
    ];
    for (name, bytes, plain) in cases {
        let (from, to) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = from.path().join(name);
        fs::write(&source, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o640)).unwrap();
        }
        let dest = to.path().join(name);

        copy_imported_file(&source, &dest, plain).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), bytes, "{name}");
        #[cfg(unix)]
        assert_eq!(mode(&dest), 0o640, "{name}");
        assert_eq!(names(to.path()), [name], "{name}: no temp file is left");
    }
}

/// Electron's copy replaced a file at the name; this one fails, so the caller tries the next.
#[test]
fn a_file_at_the_name_is_never_replaced() {
    for (name, plain) in [("Trip.md", true), ("Trip.md", false), ("photo.png", true)] {
        let (from, to) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = from.path().join(name);
        fs::write(&source, CHECKLIST).unwrap();
        let dest = to.path().join(name);
        fs::write(&dest, "the user's own file").unwrap();

        let error = copy_imported_file(&source, &dest, plain).unwrap_err();

        assert!(error.already_exists(), "{name} {plain}: {error:?}");
        assert_eq!(fs::read_to_string(&dest).unwrap(), "the user's own file");
        assert_eq!(names(to.path()), [name], "no temp file is left");
    }
}

#[test]
fn a_missing_source_fails_and_creates_nothing() {
    let (from, to) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    for (name, plain) in [("gone.md", true), ("gone.png", false)] {
        let error =
            copy_imported_file(&from.path().join(name), &to.path().join(name), plain).unwrap_err();

        assert_eq!(error.source.kind(), io::ErrorKind::NotFound, "{name}");
    }
    assert_eq!(names(to.path()), Vec::<String>::new());
}
