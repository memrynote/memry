//! An import's copy of a file into the vault (`import-copy.ts`), on real files: which files get
//! their checklists marked plain, which are copied byte for byte, that a file already at the
//! name is never replaced, that the copy stays in the vault, and that the source is read only
//! as a regular file and only so much of it. The marking itself is pinned against the
//! TypeScript in `memry-core/tests/checklist_plain_vectors.rs`.

use std::fs;
use std::io;
use std::path::Path;

use memry_desktop::shell::file_open::OpenError;
use memry_desktop::vault::import_copy::copy_imported_file;
use memry_desktop::vault::note_file::{MAX_NOTE_BYTES, NoteFileError};

const CHECKLIST: &str = "# Trip\n- [ ] Passport\n- [x] Tickets {task:abc}\n";
const MARKED: &str = "# Trip\n- [ ] Passport {check}\n- [x] Tickets {task:abc}\n";

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

/// The marked copy keeps the source's mode, as every copy does.
#[test]
fn plain_checklists_mark_a_markdown_files_checkboxes_and_leave_its_source_alone() {
    let (from, vault) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let source = from.path().join("Trip.md");
    fs::write(&source, CHECKLIST).unwrap();
    #[cfg(unix)]
    set_mode(&source, 0o640);

    copy_imported_file(vault.path(), &source, "Trip.md", true).unwrap();

    let dest = vault.path().join("Trip.md");
    assert_eq!(fs::read_to_string(&dest).unwrap(), MARKED);
    #[cfg(unix)]
    assert_eq!(mode(&dest), 0o640);
    assert_eq!(fs::read_to_string(&source).unwrap(), CHECKLIST);
    assert_eq!(names(vault.path()), ["Trip.md"], "no temp file is left");
}

/// Every file the marking does not rewrite arrives with the source's bytes, and on Unix its
/// mode, as `fs.copyFile` kept it.
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
        let (from, vault) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = from.path().join(name);
        fs::write(&source, bytes).unwrap();
        #[cfg(unix)]
        set_mode(&source, 0o640);

        copy_imported_file(vault.path(), &source, name, plain).unwrap();

        let dest = vault.path().join(name);
        assert_eq!(fs::read(&dest).unwrap(), bytes, "{name}");
        #[cfg(unix)]
        assert_eq!(mode(&dest), 0o640, "{name}");
        assert_eq!(names(vault.path()), [name], "{name}: no temp file is left");
    }
}

/// A markdown file past the in-memory cap is copied as it is: never read whole, never lost.
/// Sparse past its first line, so the test writes little.
#[test]
fn a_markdown_file_too_large_to_mark_is_copied_unmarked() {
    let (from, vault) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let source = from.path().join("Huge.md");
    let file = fs::File::create(&source).unwrap();
    io::Write::write_all(&mut &file, b"- [ ] Passport\n").unwrap();
    file.set_len(MAX_NOTE_BYTES + 1).unwrap();
    drop(file);

    copy_imported_file(vault.path(), &source, "Huge.md", true).unwrap();

    let dest = vault.path().join("Huge.md");
    assert_eq!(fs::metadata(&dest).unwrap().len(), MAX_NOTE_BYTES + 1);
    let mut head = [0u8; 15];
    io::Read::read_exact(&mut fs::File::open(&dest).unwrap(), &mut head).unwrap();
    assert_eq!(&head, b"- [ ] Passport\n");
}

/// Electron's copy replaced a file at the name; this one fails, so the caller tries the next.
#[test]
fn a_file_at_the_name_is_never_replaced() {
    for (name, plain) in [("Trip.md", true), ("Trip.md", false), ("photo.png", true)] {
        let (from, vault) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let source = from.path().join(name);
        fs::write(&source, CHECKLIST).unwrap();
        let dest = vault.path().join(name);
        fs::write(&dest, "the user's own file").unwrap();

        let result = copy_imported_file(vault.path(), &source, name, plain);

        assert!(
            matches!(result, Err(NoteFileError::AlreadyExists)),
            "{name} {plain}: {result:?}"
        );
        assert_eq!(fs::read_to_string(&dest).unwrap(), "the user's own file");
        assert_eq!(names(vault.path()), [name], "no temp file is left");
    }
}

/// Past `MAX_PATH` (260 characters) on Windows, both the marked and the plain copy.
#[test]
fn an_import_lands_past_260_characters() {
    let (from, vault) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let source = from.path().join("Trip.md");
    fs::write(&source, CHECKLIST).unwrap();
    let folder = ["f", "g", "h"].map(|letter| letter.repeat(100)).join("/");

    for (name, plain, expected) in [("marked.md", true, MARKED), ("plain.md", false, CHECKLIST)] {
        let rel = format!("{folder}/{name}");
        copy_imported_file(vault.path(), &source, &rel, plain).unwrap();
        assert_eq!(
            fs::read_to_string(vault.path().join(&rel)).unwrap(),
            expected
        );
    }
}

#[test]
fn a_missing_source_fails_and_creates_nothing() {
    let (from, vault) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    for (name, plain) in [("gone.md", true), ("gone.png", false)] {
        let result = copy_imported_file(vault.path(), &from.path().join(name), name, plain);

        assert!(
            matches!(&result, Err(NoteFileError::Io(error)) if error.kind() == io::ErrorKind::NotFound),
            "{name}: {result:?}"
        );
    }
    assert_eq!(names(vault.path()), Vec::<String>::new());
}

#[test]
fn a_name_that_leaves_the_vault_is_refused() {
    let (from, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let vault = root.path().join("vault");
    fs::create_dir(&vault).unwrap();
    let source = from.path().join("Trip.md");
    fs::write(&source, CHECKLIST).unwrap();

    let result = copy_imported_file(&vault, &source, "../Trip.md", true);

    assert!(
        matches!(result, Err(NoteFileError::Open(OpenError::Outside))),
        "{result:?}"
    );
    assert_eq!(names(root.path()), ["vault"]);
}

/// A folder of the vault that links outside it is not a way out.
#[cfg(unix)]
#[test]
fn a_linked_folder_that_leaves_the_vault_is_refused() {
    let (from, root) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let (vault, outside) = (root.path().join("vault"), root.path().join("outside"));
    fs::create_dir(&vault).unwrap();
    fs::create_dir(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, vault.join("linked")).unwrap();
    let source = from.path().join("Trip.md");
    fs::write(&source, CHECKLIST).unwrap();

    for plain in [true, false] {
        let result = copy_imported_file(&vault, &source, "linked/Trip.md", plain);

        assert!(
            matches!(result, Err(NoteFileError::Open(OpenError::Outside))),
            "{plain}: {result:?}"
        );
    }
    assert_eq!(names(&outside), Vec::<String>::new());
}

/// A pipe would block the read until something writes to it, and `/dev/zero` never ends: only
/// a regular file is read. The call runs against a deadline, so a read that blocks fails the
/// test instead of hanging it.
#[cfg(unix)]
#[test]
fn a_source_that_is_not_a_regular_file_is_refused_at_once() {
    let (from, vault) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let pipe = from.path().join("pipe.md");
    let path = std::ffi::CString::new(pipe.to_str().unwrap()).unwrap();
    // SAFETY: the path is NUL-terminated and outlives the call.
    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0);
    let zero = from.path().join("zero.png");
    std::os::unix::fs::symlink("/dev/zero", &zero).unwrap();

    for (source, plain) in [(pipe, true), (zero, false)] {
        let (done, result) = std::sync::mpsc::channel();
        let (into, name) = (vault.path().to_owned(), source.clone());
        std::thread::spawn(move || {
            done.send(copy_imported_file(&into, &name, "copy.md", plain))
                .unwrap()
        });

        let result = result
            .recv_timeout(std::time::Duration::from_secs(60))
            .expect("the import returned");

        assert!(
            matches!(result, Err(NoteFileError::Open(OpenError::NotRegular))),
            "{source:?}: {result:?}"
        );
    }
    assert_eq!(names(vault.path()), Vec::<String>::new());
}
