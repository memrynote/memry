//! A vault write changes only the bytes it means to and never replaces a file it did not
//! read: exclusive creation, kept file attributes, and a containment check at the rename.

use std::fs;
use std::path::Path;

use memry_core::markdown::frontmatter::YamlMap;
use memry_desktop::vault::fs_atomic::{
    atomic_create, atomic_create_checked, atomic_write, create_unique,
};
use memry_desktop::vault::note_file::{
    NoteFileError, read_note, write_new_note, write_new_note_checked, write_note_checked,
};

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_create_never_replaces_a_file_that_appears_after_the_caller_looked() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("note.md");
    let planted = target.clone();
    // The file appears after the temp file is complete and before it is put in place.
    let mut appear = move || fs::write(&planted, "theirs");
    let err = atomic_create_checked(&target, b"mine", &[], &mut appear).unwrap_err();
    assert!(err.already_exists(), "{err:?}");
    assert_eq!(fs::read_to_string(&target).unwrap(), "theirs");
    assert_eq!(entries(dir.path()), ["note.md"], "no temp file may remain");
}

#[test]
fn a_new_note_never_replaces_a_file_created_while_it_was_being_written() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("a.md");
    let planted = target.clone();
    let result = write_new_note_checked(dir.path(), "a.md", &YamlMap::new(), "mine", &mut || {
        fs::write(&planted, "theirs").unwrap()
    });
    assert!(
        matches!(result, Err(NoteFileError::AlreadyExists)),
        "{result:?}"
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), "theirs");

    // And the plain call refuses an existing file the same way.
    assert!(matches!(
        write_new_note(dir.path(), "a.md", &YamlMap::new(), "mine"),
        Err(NoteFileError::AlreadyExists)
    ));
    write_new_note(dir.path(), "b.md", &YamlMap::new(), "fresh").unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("b.md")).unwrap(),
        "fresh\n"
    );
    assert_eq!(entries(dir.path()), ["a.md", "b.md"]);
}

#[test]
fn callers_racing_for_one_name_each_get_their_own_file() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("untitled.md");
    let handles: Vec<_> = (0..16)
        .map(|i| {
            let base = base.clone();
            std::thread::spawn(move || {
                create_unique(&base, format!("body {i}").as_bytes()).unwrap()
            })
        })
        .collect();
    let mut paths: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    paths.sort();
    paths.dedup();
    assert_eq!(paths.len(), 16, "two callers were given one path");
    let mut bodies: Vec<_> = paths
        .iter()
        .map(|p| fs::read_to_string(p).unwrap())
        .collect();
    bodies.sort();
    let mut expected: Vec<_> = (0..16).map(|i| format!("body {i}")).collect();
    expected.sort();
    assert_eq!(bodies, expected, "no body was overwritten");
    assert_eq!(entries(dir.path()).len(), 16, "no temp file remains");
    assert!(base.exists() && dir.path().join("untitled 15.md").exists());
}

#[test]
fn a_create_in_a_new_folder_makes_the_folder() {
    let dir = tempfile::tempdir().unwrap();
    atomic_create(&dir.path().join("a/b/c.md"), b"x").unwrap();
    assert_eq!(fs::read(dir.path().join("a/b/c.md")).unwrap(), b"x");
}

#[cfg(unix)]
mod attributes {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_save_keeps_the_mode_of_the_file_it_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        fs::write(&target, "old").unwrap();
        for mode in [0o644, 0o640, 0o664, 0o600] {
            fs::set_permissions(&target, fs::Permissions::from_mode(mode)).unwrap();
            atomic_write(&target, b"new").unwrap();
            let kept = fs::metadata(&target).unwrap().permissions().mode() & 0o7777;
            assert_eq!(kept, mode, "mode {mode:o}");
        }
        // A file that did not exist starts owner-only.
        let fresh = dir.path().join("fresh.md");
        atomic_write(&fresh, b"x").unwrap();
        assert_eq!(
            fs::metadata(&fresh).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn a_save_keeps_extended_attributes() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("note.md");
        fs::write(&target, "old").unwrap();
        // `user.` is the namespace Linux allows on a regular file; macOS takes any name.
        let name = if cfg!(target_os = "linux") {
            "user.memry.test"
        } else {
            "com.memry.test"
        };
        if xattr::set(&target, name, b"tag-blue").is_err() {
            eprintln!("this file system takes no extended attributes; nothing to check");
            return;
        }
        atomic_write(&target, b"new").unwrap();
        assert_eq!(
            xattr::get(&target, name).unwrap().as_deref(),
            Some(&b"tag-blue"[..])
        );
        assert_eq!(fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn a_save_whose_path_is_retargeted_outside_the_vault_stops_before_the_rename() {
        use memry_desktop::vault::note_file::NoteFile;
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        let outside = tmp.path().join("outside");
        fs::create_dir_all(vault.join("notes")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), "secret").unwrap();
        fs::write(vault.join("notes/a.md"), "---\ntitle: a\n---\nbody\n").unwrap();
        std::os::unix::fs::symlink(vault.join("notes/a.md"), vault.join("notes/alias.md")).unwrap();

        let note: NoteFile = read_note(&vault, "notes/alias.md").unwrap().unwrap();
        let parsed = note.parse().unwrap();
        let alias = vault.join("notes/alias.md");
        let secret = outside.join("secret.md");
        // After the write was aimed at the file, the link is pointed outside.
        let mut retarget = || {
            fs::remove_file(&alias).unwrap();
            std::os::unix::fs::symlink(&secret, &alias).unwrap();
        };
        let result = write_note_checked(
            &vault,
            "notes/alias.md",
            &parsed,
            "new body",
            false,
            &mut retarget,
        );
        assert!(result.is_err(), "the write must stop: {result:?}");
        assert_eq!(
            fs::read_to_string(vault.join("notes/a.md")).unwrap(),
            "---\ntitle: a\n---\nbody\n"
        );
        assert_eq!(fs::read_to_string(&secret).unwrap(), "secret");
        assert_eq!(
            entries(&vault.join("notes")),
            ["a.md", "alias.md"],
            "no temp file remains"
        );
    }
}
