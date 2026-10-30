//! `vault::move_dir` on real folders. A plain rename moves the folder; when it is refused as
//! Windows refuses a folder something beneath holds (forced here through the step hook, and on
//! Windows by real holds), the tree moves entry by entry. Either way the move is all or
//! nothing: a failed one leaves every file where and as it was, and no staging folder behind.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use memry_desktop::vault::move_dir::{Step, move_dir, move_dir_checked};

/// Every file and folder under `root`, by path relative to it: a file with its bytes, a folder
/// with `None`.
fn tree(root: &Path) -> BTreeMap<String, Option<Vec<u8>>> {
    let mut found = BTreeMap::new();
    let mut folders = vec![root.to_owned()];
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let meta = fs::symlink_metadata(&path).unwrap();
            if meta.is_dir() {
                found.insert(rel, None);
                folders.push(path);
            } else if meta.is_file() {
                found.insert(rel, Some(fs::read(&path).unwrap()));
            } else {
                found.insert(rel, Some(b"<link>".to_vec()));
            }
        }
    }
    found
}

/// A vault with `notes/` holding files at three depths and an empty folder.
fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (rel, text) in [
        ("notes/a.md", "a"),
        ("notes/b.md", "b"),
        ("notes/sub/c.md", "c"),
        ("notes/sub/deep/d.md", "d"),
        ("notes/held/e.md", "e"),
    ] {
        let path = dir.path().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    fs::create_dir_all(dir.path().join("notes/empty")).unwrap();
    dir
}

/// The tree of `notes/` as it would be under `to/`.
fn moved(
    before: &BTreeMap<String, Option<Vec<u8>>>,
    to: &str,
) -> BTreeMap<String, Option<Vec<u8>>> {
    before
        .iter()
        .map(|(rel, bytes)| (rel.replacen("notes", to, 1), bytes.clone()))
        .collect()
}

fn denied() -> io::Error {
    io::Error::from(io::ErrorKind::PermissionDenied)
}

/// Refuses the whole folder's rename and the rename of the folder `held` whole, as Windows
/// refuses a folder something beneath holds: the move goes entry by entry, and `held` is made
/// again. Every step is recorded.
fn as_windows_holds<'a>(steps: &'a mut Vec<String>) -> impl FnMut(Step<'_>) -> io::Result<()> + 'a {
    move |step| {
        steps.push(format!("{step:?}"));
        match step {
            Step::Whole { .. } => Err(denied()),
            Step::Entry { from, .. } if from.ends_with("held") => Err(denied()),
            _ => Ok(()),
        }
    }
}

#[test]
fn a_folder_moves_whole_and_into_a_new_parent() {
    let dir = vault();
    let before = tree(dir.path());
    fs::create_dir(dir.path().join("archive")).unwrap();
    move_dir(&dir.path().join("notes"), &dir.path().join("archive/notes")).unwrap();
    let mut want = moved(&before, "archive/notes");
    want.insert("archive".into(), None);
    assert_eq!(tree(dir.path()), want);
}

#[test]
fn a_case_only_rename_is_not_refused_as_an_existing_folder() {
    let dir = vault();
    let before = tree(dir.path());
    move_dir(&dir.path().join("notes"), &dir.path().join("Notes")).unwrap();
    assert_eq!(tree(dir.path()), moved(&before, "Notes"));
}

#[test]
fn a_folder_that_is_there_is_never_merged_into() {
    for target_file in [None, Some("keep.md")] {
        let dir = vault();
        let target = dir.path().join("other");
        fs::create_dir(&target).unwrap();
        if let Some(name) = target_file {
            fs::write(target.join(name), "theirs").unwrap();
        }
        let before = tree(dir.path());
        let error = move_dir(&dir.path().join("notes"), &target).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(tree(dir.path()), before, "{target_file:?}");
    }
}

#[test]
fn a_folder_windows_holds_moves_entry_by_entry_and_leaves_no_staging() {
    let dir = vault();
    let before = tree(dir.path());
    let mut steps = Vec::new();
    move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut as_windows_holds(&mut steps),
    )
    .unwrap();
    assert_eq!(tree(dir.path()), moved(&before, "moved"));
    // The entries went into a staging folder the watcher ignores, made first, beside the target.
    let staging = steps.iter().find(|s| s.starts_with("MakeDir")).unwrap();
    assert!(
        staging.contains(".memry-move-") && !staging.contains("moved"),
        "{staging}"
    );
    // `held` was made again and its file moved alone; `sub` moved whole.
    assert!(
        steps
            .iter()
            .any(|s| s.starts_with("MakeDir") && s.contains("held")),
        "{steps:?}"
    );
    assert!(steps.iter().any(|s| s.contains("e.md")), "{steps:?}");
    assert!(!steps.iter().any(|s| s.contains("c.md")), "{steps:?}");
}

/// A file Windows refuses for a moment (a scan opened it) is moved on a retry, as every step
/// of the entry-wise move is.
#[test]
fn a_file_refused_for_a_moment_is_moved_on_a_retry() {
    let dir = vault();
    let before = tree(dir.path());
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let mut refused_once = false;
    move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut |step| {
            windows(step)?;
            if let Step::Entry { from, .. } = step
                && from.ends_with("e.md")
                && !std::mem::replace(&mut refused_once, true)
            {
                return Err(io::Error::from(io::ErrorKind::ResourceBusy));
            }
            Ok(())
        },
    )
    .unwrap();
    assert!(refused_once);
    assert_eq!(tree(dir.path()), moved(&before, "moved"));
}

#[test]
fn a_move_that_fails_midway_puts_every_file_back() {
    // Fails each step in turn: whichever step fails, the tree is as it was.
    let dir = vault();
    let before = tree(dir.path());
    let mut count = Vec::new();
    move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut as_windows_holds(&mut count),
    )
    .unwrap();
    let steps = count.len();
    fs::rename(dir.path().join("moved"), dir.path().join("notes")).unwrap();
    assert_eq!(tree(dir.path()), before);
    for fail_at in 1..=steps {
        let mut seen = Vec::new();
        let mut windows = as_windows_holds(&mut seen);
        let mut at = 0;
        let error = move_dir_checked(
            &dir.path().join("notes"),
            &dir.path().join("moved"),
            &mut |step| {
                at += 1;
                if at == fail_at {
                    return Err(io::Error::other("the disk went away"));
                }
                windows(step)
            },
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "the disk went away", "step {fail_at}");
        assert_eq!(tree(dir.path()), before, "failed at step {fail_at}");
    }
}

#[test]
fn a_file_that_lands_mid_move_fails_the_move_and_is_never_deleted() {
    let dir = vault();
    let mut want = tree(dir.path());
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let landed = dir.path().join("notes/held/landed.md");
    let error = move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut |step| {
            windows(step)?;
            if let Step::RemoveDir(path) = step
                && path.ends_with("held")
            {
                fs::write(&landed, "new").unwrap();
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert_ne!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(fs::read(&landed).unwrap(), b"new");
    want.insert("notes/held/landed.md".into(), Some(b"new".to_vec()));
    assert_eq!(tree(dir.path()), want);
}

#[cfg(unix)]
#[test]
fn links_move_as_links_and_a_linked_folder_is_never_moved_through() {
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("x.md"), "outside").unwrap();
    let dir = vault();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("notes/link")).unwrap();
    let before = tree(dir.path());
    let mut steps = Vec::new();
    move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut as_windows_holds(&mut steps),
    )
    .unwrap();
    assert_eq!(tree(dir.path()), moved(&before, "moved"));
    assert_eq!(
        tree(outside.path()).len(),
        1,
        "the linked folder's file stayed"
    );

    let linked = dir.path().join("linked");
    std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
    let error = move_dir_checked(
        &linked,
        &dir.path().join("through"),
        &mut |step| match step {
            Step::Whole { .. } => Err(denied()),
            _ => panic!("moved through a link: {step:?}"),
        },
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(outside.path().join("x.md").exists());
}

/// A file open without `FILE_SHARE_DELETE` (an editor's handle) can be neither renamed nor
/// moved out: the plain rename is refused, the entry-wise move cannot take that file, and the
/// whole move rolls back with every file where it was.
#[cfg(windows)]
#[test]
fn a_file_held_without_share_delete_rolls_the_move_back() {
    use std::os::windows::fs::OpenOptionsExt;
    const SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    let dir = vault();
    let before = tree(dir.path());
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ_WRITE)
        .open(dir.path().join("notes/sub/c.md"))
        .unwrap();
    let error = move_dir(&dir.path().join("notes"), &dir.path().join("moved")).unwrap_err();
    drop(held);
    eprintln!(
        "refused with {:?} os {:?}",
        error.kind(),
        error.raw_os_error()
    );
    assert_eq!(tree(dir.path()), before);
}

/// A subfolder held open as a watcher holds it (a folder handle that shares delete): whether
/// Windows lets the folder rename whole or the move goes entry by entry, it ends all or
/// nothing, and no staging folder stays.
#[cfg(windows)]
#[test]
fn a_folder_held_open_beneath_moves_whole_or_not_at_all() {
    use std::os::windows::fs::OpenOptionsExt;
    const SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let dir = vault();
    let before = tree(dir.path());
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(dir.path().join("notes/sub"))
        .unwrap();
    let mut steps = Vec::new();
    let result = move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut |step| {
            steps.push(format!("{step:?}"));
            Ok(())
        },
    );
    drop(held);
    eprintln!("{result:?} after {} steps", steps.len());
    let after = tree(dir.path());
    assert!(
        after == before || after == moved(&before, "moved"),
        "{result:?}: {after:?}"
    );
    assert_eq!(result.is_ok(), after != before);
}
