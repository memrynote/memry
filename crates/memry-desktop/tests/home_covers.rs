//! `<vault>/.memry/home-covers/<boardId>/<file>`, the files of home board covers, on a real
//! temp vault. A cover's ref is synced and Electron builds read it, so the ref a write returns
//! and the file a ref names are pinned against Electron's `homeCoverFilePath`
//! (`fixtures/gen-cover-vectors.mjs`).

use std::fs;
use std::path::Path;

use memry_desktop::vault::covers::{
    CoverError, cover_file_path, delete_cover_dir, prune_cover_files, write_cover,
};
use serde_json::Value;

const VECTORS: &str = include_str!("fixtures/electron-vault/home-cover-paths.json");

fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".memry")).unwrap();
    dir
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_ref_names_the_file_electron_maps_it_to_and_nothing_outside_its_board() {
    let vectors: Value = serde_json::from_str(VECTORS).unwrap();
    let board = vectors["board"].as_str().unwrap();
    let root = Path::new("/vault");
    for case in vectors["cases"].as_array().unwrap() {
        let reference = case["ref"].as_str().unwrap();
        let expected = case["path"].as_str().map(|rel| root.join(rel));
        assert_eq!(
            cover_file_path(root, board, reference),
            expected,
            "{reference:?}"
        );
    }
}

#[test]
fn a_written_cover_is_at_its_ref_and_a_rewrite_replaces_it() {
    let dir = vault();
    let reference = write_cover(dir.path(), "b1", "abc123-photo.png", b"first").unwrap();
    assert_eq!(reference, ".memry/home-covers/b1/abc123-photo.png");
    let path = cover_file_path(dir.path(), "b1", &reference).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"first");
    write_cover(dir.path(), "b1", "abc123-photo.png", b"second").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"second");
    assert_eq!(names(path.parent().unwrap()), ["abc123-photo.png"]);
}

/// A board id is one plain segment: one that is not names no file, writes nothing and deletes
/// nothing, where Electron would join it into the path (`..` is `.memry` itself).
#[test]
fn a_board_id_or_file_name_that_is_not_one_segment_is_refused() {
    let dir = vault();
    fs::write(dir.path().join(".memry/config.json"), "{}").unwrap();
    for board in ["", ".", "..", "a/b", "a\\b"] {
        let reference = format!(".memry/home-covers/{board}/photo.png");
        assert_eq!(
            cover_file_path(dir.path(), board, &reference),
            None,
            "{board:?}"
        );
        assert!(matches!(
            write_cover(dir.path(), board, "photo.png", b"x"),
            Err(CoverError::InvalidName)
        ));
        prune_cover_files(dir.path(), board, None);
        delete_cover_dir(dir.path(), board);
    }
    for name in ["", ".", "..", "sub/photo.png", "sub\\photo.png"] {
        assert!(matches!(
            write_cover(dir.path(), "b1", name, b"x"),
            Err(CoverError::InvalidName)
        ));
    }
    assert!(dir.path().join(".memry/config.json").is_file());
}

/// A vault that is away (an unplugged drive) fails the write; its folder does not come back.
#[test]
fn a_vault_without_its_memry_folder_is_not_recreated() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("vault");
    assert!(write_cover(&root, "b1", "photo.png", b"x").is_err());
    assert!(!root.exists());
}

#[test]
fn pruning_keeps_only_the_current_cover_and_deleting_the_board_takes_its_folder() {
    let dir = vault();
    for name in ["old.png", "current.png", "older.jpg"] {
        write_cover(dir.path(), "b1", name, b"x").unwrap();
    }
    write_cover(dir.path(), "b2", "other.png", b"x").unwrap();
    let current = cover_file_path(dir.path(), "b1", ".memry/home-covers/b1/current.png").unwrap();
    prune_cover_files(dir.path(), "b1", Some(&current));
    let folder = dir.path().join(".memry/home-covers/b1");
    assert_eq!(names(&folder), ["current.png"]);
    prune_cover_files(dir.path(), "b1", None);
    assert!(names(&folder).is_empty());
    prune_cover_files(dir.path(), "never-had-one", None);

    delete_cover_dir(dir.path(), "b1");
    assert!(!folder.exists());
    assert_eq!(
        names(&dir.path().join(".memry/home-covers/b2")),
        ["other.png"]
    );
    delete_cover_dir(dir.path(), "b1");
}

/// A board folder, or the covers folder, that is a link out of `.memry` is neither written,
/// emptied nor deleted through: the files it leads to (here the vault's own notes) are not
/// covers.
#[cfg(unix)]
#[test]
fn a_cover_folder_linked_out_of_memry_is_never_written_or_emptied() {
    for linked in ["home-covers/b1", "home-covers"] {
        let dir = vault();
        let notes = dir.path().join("notes");
        let board = if linked == "home-covers" {
            notes.join("b1")
        } else {
            notes.clone()
        };
        fs::create_dir_all(&board).unwrap();
        fs::write(board.join("keep.md"), "a note").unwrap();
        fs::create_dir_all(dir.path().join(".memry/home-covers")).unwrap();
        let link = dir.path().join(".memry").join(linked);
        fs::remove_dir(&link).ok();
        std::os::unix::fs::symlink(&notes, &link).unwrap();

        assert!(
            matches!(
                write_cover(dir.path(), "b2", "photo.png", b"x"),
                Err(CoverError::Outside)
            ) == (linked == "home-covers"),
            "{linked}"
        );
        assert!(matches!(
            write_cover(dir.path(), "b1", "photo.png", b"x"),
            Err(CoverError::Outside)
        ));
        prune_cover_files(dir.path(), "b1", None);
        delete_cover_dir(dir.path(), "b1");
        assert_eq!(names(&board), ["keep.md"], "{linked}");
        assert!(!notes.join("b2").exists(), "{linked}");
    }
}
