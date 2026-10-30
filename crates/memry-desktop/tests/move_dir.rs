//! `vault::move_dir` on real folders. A plain rename moves the folder; when Windows refuses it
//! because something beneath is held (forced here through the step hook, and on Windows by
//! real holds), the tree moves entry by entry. A failed move rolls back without replacing
//! anything: every file goes back, beside a save that took its name, or into a visible folder,
//! and no hidden staging folder stays.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

use memry_desktop::vault::move_dir::{
    IncompleteRollback, Step, move_dir, move_dir_checked, simulated_hold,
};

type Tree = BTreeMap<String, Option<Vec<u8>>>;

/// Every file and folder under `root`, by path relative to it: a file with its bytes, a folder
/// with `None`.
fn tree(root: &Path) -> Tree {
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
fn moved(before: &Tree, to: &str) -> Tree {
    before
        .iter()
        .map(|(rel, bytes)| (rel.replacen("notes", to, 1), bytes.clone()))
        .collect()
}

const KEPT: &str = "notes (incomplete move)";

/// Nothing hidden is left, every file of `before` is back at its path or at the same path
/// under the visible folder [`KEPT`], and nothing else is there.
fn back_or_kept(before: &Tree, after: &Tree) {
    let hidden: Vec<_> = after.keys().filter(|rel| rel.starts_with('.')).collect();
    assert!(hidden.is_empty(), "{hidden:?}");
    for (rel, bytes) in before.iter().filter(|(_, bytes)| bytes.is_some()) {
        let kept = rel.replacen("notes", KEPT, 1);
        assert!(
            after.get(rel) == Some(bytes) || after.get(&kept) == Some(bytes),
            "{rel} lost: {after:?}"
        );
    }
    for rel in after.keys() {
        let source = rel.replacen(KEPT, "notes", 1);
        assert!(before.contains_key(&source), "{rel} is new: {after:?}");
    }
}

fn incomplete(error: &io::Error) -> &IncompleteRollback {
    IncompleteRollback::of(error).unwrap_or_else(|| panic!("not an incomplete rollback: {error}"))
}

fn is_staging(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().starts_with(".memry-move-"))
}

/// Refuses the whole folder's rename and the rename of the folder `held` whole, as Windows
/// refuses a folder something beneath holds: the move goes entry by entry, and `held` is made
/// again. Every step is recorded.
fn as_windows_holds<'a>(steps: &'a mut Vec<String>) -> impl FnMut(Step<'_>) -> io::Result<()> + 'a {
    move |step| {
        steps.push(format!("{step:?}"));
        match step {
            Step::Whole { .. } => Err(simulated_hold()),
            Step::Entry { from, .. } if from.ends_with("held") => Err(simulated_hold()),
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

/// A case-only rename names the source itself on a case-insensitive volume, and the source's
/// own name is no move at all: neither is refused as an existing folder.
#[test]
fn a_case_only_rename_is_not_refused_as_an_existing_folder() {
    for name in ["Notes", "notes"] {
        let dir = vault();
        let before = tree(dir.path());
        move_dir(&dir.path().join("notes"), &dir.path().join(name)).unwrap();
        assert_eq!(tree(dir.path()), moved(&before, name), "{name}");
    }
}

/// An existing target, empty or not, is refused before any step runs.
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
        let mut steps = Vec::new();
        let error = move_dir_checked(
            &dir.path().join("notes"),
            &target,
            &mut as_windows_holds(&mut steps),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(steps.is_empty(), "{steps:?}");
        assert_eq!(tree(dir.path()), before, "{target_file:?}");
    }
}

/// A target that appears after the check is never replaced, by the plain rename or by the
/// staging folder's rename at the end of an entry-wise move: the move fails and rolls back.
#[test]
fn a_target_made_mid_move_is_never_replaced() {
    for entry_wise in [false, true] {
        let dir = vault();
        let before = tree(dir.path());
        let target = dir.path().join("moved");
        let mut seen = Vec::new();
        let mut windows = as_windows_holds(&mut seen);
        let error = move_dir_checked(&dir.path().join("notes"), &target, &mut |step| {
            let last = match step {
                Step::Whole { .. } => !entry_wise,
                Step::Entry { from, .. } => is_staging(from),
                _ => false,
            };
            if last && !target.exists() {
                fs::create_dir(&target).unwrap();
            }
            match entry_wise {
                true => windows(step),
                false => Ok(()),
            }
        })
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists, "{entry_wise}");
        let mut want = before.clone();
        want.insert("moved".into(), None);
        assert_eq!(tree(dir.path()), want, "{entry_wise}");
    }
}

/// Something made in the staging folder where an entry of the move lands is never replaced:
/// a file, or an empty folder where a subfolder moves whole. The move fails and rolls back; a
/// planted file comes back beside the original, an empty folder merges into it.
#[test]
fn what_is_made_in_the_staging_folder_is_never_replaced() {
    for (entry, planted) in [("a.md", Some("planted")), ("sub", None)] {
        let dir = vault();
        let mut want = tree(dir.path());
        let mut seen = Vec::new();
        let mut windows = as_windows_holds(&mut seen);
        let error = move_dir_checked(
            &dir.path().join("notes"),
            &dir.path().join("moved"),
            &mut |step| {
                if let Step::Entry { from, to } = step
                    && from.ends_with(entry)
                    && !to.exists()
                {
                    match planted {
                        Some(bytes) => fs::write(to, bytes).unwrap(),
                        None => fs::create_dir(to).unwrap(),
                    }
                }
                windows(step)
            },
        )
        .unwrap_err();
        if let Some(bytes) = planted {
            let copy = "notes/a (conflict copy).md";
            let incomplete = incomplete(&error);
            assert_eq!(incomplete.cause.kind(), io::ErrorKind::AlreadyExists);
            assert_eq!(incomplete.conflict_copies, [dir.path().join(copy)]);
            want.insert(copy.into(), Some(bytes.as_bytes().to_vec()));
        } else {
            assert_eq!(error.kind(), io::ErrorKind::AlreadyExists, "{error}");
        }
        assert_eq!(tree(dir.path()), want, "{entry}");
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

/// Outside Windows a refused rename is a permission or a mount point, not a hold: it is
/// returned, and nothing moves entry by entry.
#[cfg(not(windows))]
#[test]
fn a_refusal_elsewhere_is_returned_and_nothing_moves_entry_by_entry() {
    let dir = vault();
    let before = tree(dir.path());
    let mut steps = Vec::new();
    let error = move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut |step| {
            steps.push(format!("{step:?}"));
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        },
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(steps.len(), 1, "{steps:?}");
    assert_eq!(tree(dir.path()), before);
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

/// Fails each step of an entry-wise move in turn, and with it each step of its rollback in
/// turn: a failure the rollback undoes leaves the tree as it was and returns the first error;
/// a rollback step that fails leaves what it would have put back in the visible folder.
#[test]
fn a_move_that_fails_at_any_step_puts_every_file_back_or_in_sight() {
    // Every run starts from a vault made the same way, so the folders list their entries in
    // the same order and step N is the same step (tmpfs lists them in creation order).
    let disk = || io::Error::other("the disk went away");
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
    // The error, and how many steps ran (the failed ones included).
    let run = |dir: &Path, fail_at: &[usize]| {
        let mut seen = Vec::new();
        let mut windows = as_windows_holds(&mut seen);
        let mut at = 0;
        let error = move_dir_checked(&dir.join("notes"), &dir.join("moved"), &mut |step| {
            at += 1;
            if fail_at.contains(&at) {
                return Err(disk());
            }
            windows(step)
        })
        .unwrap_err();
        (error, at)
    };
    for fail_at in 1..=steps {
        let dir = vault();
        let (error, ran) = run(dir.path(), &[fail_at]);
        assert_eq!(error.to_string(), "the disk went away", "step {fail_at}");
        assert_eq!(tree(dir.path()), before, "failed at step {fail_at}");
        let undo_steps = ran - fail_at;
        // Once the staging folder is made (step 2), every failure rolls something back.
        assert!(
            fail_at <= 2 || undo_steps > 0,
            "step {fail_at}: no rollback"
        );
        for undo_at in fail_at + 1..=fail_at + undo_steps {
            let case = vault();
            let (error, _) = run(case.path(), &[fail_at, undo_at]);
            let at = format!("failed at {fail_at}, undo at {undo_at}");
            let incomplete =
                IncompleteRollback::of(&error).unwrap_or_else(|| panic!("{at}: {error}"));
            assert_eq!(incomplete.cause.to_string(), "the disk went away", "{at}");
            assert!(incomplete.conflict_copies.is_empty(), "{at}");
            assert_eq!(incomplete.kept, [case.path().join(KEPT)], "{at}");
            back_or_kept(&before, &tree(case.path()));
        }
    }
}

/// A rollback step refused for a moment (a scan opened the file or the folder) is retried: a
/// file put back, a folder made again, a staged folder removed.
#[test]
fn a_rollback_step_refused_for_a_moment_is_retried() {
    for refused in ["PutBack", "RemakeDir", "RemoveStaged"] {
        let dir = vault();
        let before = tree(dir.path());
        let mut seen = Vec::new();
        let mut windows = as_windows_holds(&mut seen);
        let mut refused_once = false;
        let error = move_dir_checked(
            &dir.path().join("notes"),
            &dir.path().join("moved"),
            &mut |step| {
                windows(step)?;
                match step {
                    Step::Entry { from, .. } if is_staging(from) => {
                        return Err(io::Error::other("the disk went away"));
                    }
                    // Back one by one, so `notes` is made again.
                    Step::PutBack { from, .. } if is_staging(from) => {
                        return Err(simulated_hold());
                    }
                    _ => {}
                }
                let named = format!("{step:?}");
                let file = !matches!(step, Step::PutBack { from, .. } if from.is_dir());
                if named.starts_with(refused) && file && !std::mem::replace(&mut refused_once, true)
                {
                    return Err(io::Error::from(io::ErrorKind::ResourceBusy));
                }
                Ok(())
            },
        )
        .unwrap_err();
        assert!(refused_once, "{refused}");
        assert_eq!(error.to_string(), "the disk went away", "{refused}");
        assert_eq!(tree(dir.path()), before, "{refused}");
    }
}

/// A rollback whose every file is refused waits the refusal out on a few files only and gives
/// the rest one try each: a large refused tree costs seconds, not a retry schedule per file.
#[test]
fn a_rollback_of_refused_files_retries_only_a_few() {
    const FILES: usize = 12;
    let dir = tempfile::tempdir().unwrap();
    let notes = dir.path().join("notes");
    fs::create_dir(&notes).unwrap();
    for n in 0..FILES {
        fs::write(notes.join(format!("{n}.md")), n.to_string()).unwrap();
    }
    let before = tree(dir.path());
    let mut tries = 0;
    let error = move_dir_checked(&notes, &dir.path().join("moved"), &mut |step| match step {
        Step::Whole { .. } => Err(simulated_hold()),
        Step::Entry { from, .. } if is_staging(from) => Err(io::Error::other("the disk went away")),
        Step::PutBack { from, to } if is_staging(from) && to == notes.as_path() => {
            Err(simulated_hold())
        }
        Step::PutBack { to, .. } if to.parent() == Some(notes.as_path()) => {
            tries += 1;
            Err(io::Error::from(io::ErrorKind::ResourceBusy))
        }
        _ => Ok(()),
    })
    .unwrap_err();
    assert!(tries > FILES && tries < FILES * 4, "{tries} tries");
    assert_eq!(incomplete(&error).kept, [dir.path().join(KEPT)]);
    back_or_kept(&before, &tree(dir.path()));
}

/// When even the visible folder cannot take what the rollback left, the hidden staging folder
/// is what the error names, and the files are still all there.
#[test]
fn the_hidden_staging_folder_is_named_when_the_visible_one_cannot_take_it() {
    let dir = vault();
    let before = tree(dir.path());
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let mut staging = None;
    let error = move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut |step| {
            windows(step)?;
            match step {
                Step::MakeDir(path) if is_staging(path) => staging = Some(path.to_owned()),
                Step::Entry { from, .. } if is_staging(from) => {
                    return Err(io::Error::other("the disk went away"));
                }
                // Back one by one, so `a.md` can fail alone.
                Step::PutBack { from, to } if is_staging(from) && to.ends_with("notes") => {
                    return Err(simulated_hold());
                }
                Step::PutBack { from, to } if from.ends_with("a.md") || to.ends_with(KEPT) => {
                    return Err(io::Error::other("still away"));
                }
                _ => {}
            }
            Ok(())
        },
    )
    .unwrap_err();
    let staging = staging.unwrap();
    assert_eq!(incomplete(&error).kept, std::slice::from_ref(&staging));
    let mut want = before.clone();
    want.remove("notes/a.md");
    let hidden = staging.file_name().unwrap().to_string_lossy().into_owned();
    want.insert(hidden.clone(), None);
    want.insert(format!("{hidden}/a.md"), Some(b"a".to_vec()));
    assert_eq!(tree(dir.path()), want);
}

/// Undoing a subfolder that moved whole, when Windows now refuses it whole, puts its entries
/// back one by one.
#[test]
fn a_subfolder_held_on_the_way_back_goes_back_entry_by_entry() {
    let dir = vault();
    let before = tree(dir.path());
    let mut steps = Vec::new();
    let mut windows = as_windows_holds(&mut steps);
    let error = move_dir_checked(
        &dir.path().join("notes"),
        &dir.path().join("moved"),
        &mut |step| {
            windows(step)?;
            match step {
                Step::Entry { from, .. } if is_staging(from) => {
                    Err(io::Error::other("the disk went away"))
                }
                Step::PutBack { from, .. } if is_staging(from) || from.ends_with("sub") => {
                    Err(simulated_hold())
                }
                _ => Ok(()),
            }
        },
    )
    .unwrap_err();
    drop(windows);
    assert_eq!(error.to_string(), "the disk went away");
    assert_eq!(tree(dir.path()), before);
    for (made, put) in [
        ("RemakeDir", "notes\""),
        ("RemakeDir", "sub\""),
        ("PutBack", "c.md"),
    ] {
        assert!(
            steps.iter().any(|s| s.starts_with(made) && s.contains(put)),
            "{made} {put}: {steps:?}"
        );
    }
}

/// A save that lands in a source folder mid-move, under a new name or at the old path of a file
/// the move already took (`e.md`): the folder cannot be removed, the move rolls back, and the
/// save is never overwritten. A file that cannot go back to its name comes back beside it
/// under a conflict name, and the error says where.
#[test]
fn a_file_that_lands_mid_move_fails_the_move_and_is_never_overwritten() {
    for (name, conflict) in [
        ("landed.md", None),
        ("e.md", Some("notes/held/e (conflict copy).md")),
    ] {
        let dir = vault();
        let mut want = tree(dir.path());
        let mut seen = Vec::new();
        let mut windows = as_windows_holds(&mut seen);
        let landed = dir.path().join("notes/held").join(name);
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
        assert_ne!(error.kind(), io::ErrorKind::PermissionDenied, "{name}");
        assert_eq!(fs::read(&landed).unwrap(), b"new", "{name}");
        let old = want.insert(format!("notes/held/{name}"), Some(b"new".to_vec()));
        match conflict {
            Some(conflict) => {
                want.insert(conflict.into(), old.flatten());
                let incomplete = incomplete(&error);
                assert_eq!(incomplete.conflict_copies, [dir.path().join(conflict)]);
                assert!(incomplete.kept.is_empty());
            }
            None => assert!(IncompleteRollback::of(&error).is_none(), "{error}"),
        }
        assert_eq!(tree(dir.path()), want, "{name}");
    }
}

/// A rollback that cannot put files back (here the source folder turned read-only mid-move,
/// once one of its entries was out) leaves them in a visible folder beside the target, under
/// their paths in the source, never in the hidden staging folder the watcher ignores.
#[cfg(unix)]
#[test]
fn files_a_rollback_cannot_put_back_stay_visible() {
    use std::os::unix::fs::PermissionsExt;
    let dir = vault();
    let before = tree(dir.path());
    let notes = dir.path().join("notes");
    let mode = |m| fs::set_permissions(&notes, fs::Permissions::from_mode(m)).unwrap();
    mode(0o555);
    if fs::write(notes.join("probe"), "").is_ok() {
        mode(0o755);
        return; // running as root: the permission does not bite
    }
    mode(0o755);
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    // Whatever the folder lists first is out (`held`: emptied and removed) before the second
    // entry's step turns `notes` read-only: that entry cannot leave, the first cannot return.
    let mut top_level = 0;
    let result = move_dir_checked(&notes, &dir.path().join("moved"), &mut |step| {
        windows(step)?;
        if let Step::Entry { from, .. } = step
            && from.parent() == Some(notes.as_path())
        {
            top_level += 1;
            if top_level == 2 {
                mode(0o555);
            }
        }
        Ok(())
    });
    mode(0o755);
    let error = result.unwrap_err();
    let incomplete = incomplete(&error);
    assert_eq!(incomplete.cause.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(incomplete.kept, [dir.path().join(KEPT)]);
    back_or_kept(&before, &tree(dir.path()));
}

/// A link that took a subfolder's name while the subfolder was away is never merged into on
/// the way back: the subfolder comes back beside it, and the linked folder is untouched.
#[cfg(unix)]
#[test]
fn a_link_that_took_a_folders_name_is_never_merged_into() {
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("x.md"), "outside").unwrap();
    let dir = vault();
    let mut want = tree(dir.path());
    let notes = dir.path().join("notes");
    let mut seen = Vec::new();
    let mut windows = as_windows_holds(&mut seen);
    let error = move_dir_checked(&notes, &dir.path().join("moved"), &mut |step| {
        windows(step)?;
        if step == Step::RemoveDir(&notes) && !notes.join("sub").exists() {
            std::os::unix::fs::symlink(outside.path(), notes.join("sub")).unwrap();
        }
        Ok(())
    })
    .unwrap_err();
    let copy = "notes/sub (conflict copy)";
    assert_eq!(incomplete(&error).conflict_copies, [dir.path().join(copy)]);
    want = want
        .into_iter()
        .map(|(rel, bytes)| (rel.replacen("notes/sub", copy, 1), bytes))
        .collect();
    want.insert("notes/sub".into(), Some(b"<link>".to_vec()));
    assert_eq!(tree(dir.path()), want);
    assert_eq!(
        tree(outside.path()).len(),
        1,
        "the linked folder is as it was"
    );
}

/// A target inside the source (component by component, under any spelling) is refused before
/// any step runs; a sibling whose name only starts like the source's is not inside it.
#[test]
fn a_target_inside_the_source_is_refused_before_anything_moves() {
    for (target, inside) in [
        ("notes/sub/inner", true),
        ("other/../notes/sub/inner", true),
        ("notes2/notes", false),
    ] {
        let dir = vault();
        let vault_tree = tree(dir.path());
        fs::create_dir(dir.path().join("other")).unwrap();
        fs::create_dir(dir.path().join("notes2")).unwrap();
        let before = tree(dir.path());
        let mut steps = Vec::new();
        let result = move_dir_checked(
            &dir.path().join("notes"),
            &dir.path().join(target),
            &mut as_windows_holds(&mut steps),
        );
        if inside {
            assert_eq!(
                result.unwrap_err().kind(),
                io::ErrorKind::InvalidInput,
                "{target}"
            );
            assert!(steps.is_empty(), "{target}: {steps:?}");
            assert_eq!(tree(dir.path()), before, "{target}");
        } else {
            result.unwrap();
            let mut want = moved(&vault_tree, "notes2/notes");
            want.insert("notes2".into(), None);
            want.insert("other".into(), None);
            assert_eq!(tree(dir.path()), want, "{target}");
        }
    }
}

#[test]
fn a_missing_source_is_not_found_even_when_the_target_exists() {
    let dir = vault();
    let before = tree(dir.path());
    let error = move_dir(&dir.path().join("gone"), &dir.path().join("notes")).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert_eq!(tree(dir.path()), before);
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
            Step::Whole { .. } => Err(simulated_hold()),
            _ => panic!("moved through a link: {step:?}"),
        },
    )
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(outside.path().join("x.md").exists());
}

/// Real Windows holds, with a hook that only records: each test asserts the path the move
/// took, not only where the files ended.
#[cfg(windows)]
mod windows_holds {
    use std::fs::{File, OpenOptions};
    use std::os::windows::fs::OpenOptionsExt;

    use super::*;

    const SHARE_READ_WRITE: u32 = 0x1 | 0x2;
    const SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;

    /// A folder handle that shares delete, as a watcher holds a folder.
    fn hold_folder(path: &Path) -> File {
        OpenOptions::new()
            .read(true)
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .unwrap()
    }

    fn any(steps: &[String], kind: &str, part: &str) -> bool {
        steps
            .iter()
            .any(|s| s.starts_with(kind) && s.contains(part))
    }

    /// A file open without `FILE_SHARE_DELETE` (an editor's handle) can be neither renamed nor
    /// moved out: the plain rename is refused, the move goes entry by entry into the staging
    /// folder, `sub` is made again, `c.md` refuses with a sharing violation, and the whole
    /// move rolls back with every file where it was.
    #[test]
    fn a_file_held_without_share_delete_rolls_the_move_back() {
        let dir = vault();
        let before = tree(dir.path());
        let held = OpenOptions::new()
            .read(true)
            .share_mode(SHARE_READ_WRITE)
            .open(dir.path().join("notes/sub/c.md"))
            .unwrap();
        let mut steps = Vec::new();
        let error = move_dir_checked(
            &dir.path().join("notes"),
            &dir.path().join("moved"),
            &mut |step| {
                steps.push(format!("{step:?}"));
                Ok(())
            },
        )
        .unwrap_err();
        drop(held);
        assert_eq!(
            error.raw_os_error(),
            Some(ERROR_SHARING_VIOLATION),
            "{error}"
        );
        assert!(any(&steps, "MakeDir", ".memry-move-"), "{steps:?}");
        assert!(any(&steps, "MakeDir", "sub\""), "{steps:?}");
        assert!(any(&steps, "Entry", "c.md"), "{steps:?}");
        assert_eq!(tree(dir.path()), before);
    }

    /// A subfolder held open as a watcher holds it: Windows refuses its parent whole, the move
    /// goes entry by entry, and `sub` itself (whose handle shares delete) moves whole into the
    /// staging folder. The hold then refuses the staging folder's rename to the target, so the
    /// move rolls back, `notes` made again since the hold refuses the staging folder whole
    /// on the way back too, and every file is where it was.
    #[test]
    fn a_folder_held_beneath_until_the_end_rolls_the_move_back() {
        let dir = vault();
        let before = tree(dir.path());
        let held = hold_folder(&dir.path().join("notes/sub"));
        let mut steps = Vec::new();
        let error = move_dir_checked(
            &dir.path().join("notes"),
            &dir.path().join("moved"),
            &mut |step| {
                steps.push(format!("{step:?}"));
                Ok(())
            },
        )
        .unwrap_err();
        drop(held);
        assert_eq!(error.raw_os_error(), Some(ERROR_ACCESS_DENIED), "{error}");
        assert!(any(&steps, "MakeDir", ".memry-move-"), "{steps:?}");
        assert!(any(&steps, "Entry", "sub\""), "{steps:?}");
        assert!(!any(&steps, "Entry", "c.md"), "{steps:?}");
        assert!(any(&steps, "RemakeDir", "notes\""), "{steps:?}");
        assert_eq!(tree(dir.path()), before);
    }

    /// The same hold, let go once its folder moved (as a watcher closes the handle of a folder
    /// that went): the move goes entry by entry and lands whole at the target.
    #[test]
    fn a_folder_held_beneath_and_let_go_moves_entry_by_entry() {
        let dir = vault();
        let before = tree(dir.path());
        let mut held = Some(hold_folder(&dir.path().join("notes/sub")));
        let mut steps = Vec::new();
        move_dir_checked(
            &dir.path().join("notes"),
            &dir.path().join("moved"),
            &mut |step| {
                steps.push(format!("{step:?}"));
                if let Step::Entry { from, .. } = step
                    && is_staging(from)
                {
                    held.take();
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(any(&steps, "MakeDir", ".memry-move-"), "{steps:?}");
        assert!(any(&steps, "Entry", "sub\""), "{steps:?}");
        assert_eq!(tree(dir.path()), moved(&before, "moved"));
    }
}
